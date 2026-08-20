// CRM Stale Opportunities — background service worker
//
// Per the brief, the shortcut was investigated before writing any
// brute-force fallback:
// - Odoo's list/kanban view doesn't expose a "Last Updated"/"Last
//   Interaction" column or a built-in "Inactive"/"Unattended" filter on
//   crm.lead in this instance that could be sorted/filtered on directly.
// - But the chatter panel IS backed by ordinary `mail.message` records
//   (model="crm.lead", res_id=<opportunity id>), and Odoo's ORM supports
//   aggregate read_group calls (`fields: ["date:max"], groupby: ["res_id"]`).
//   That means the last-message date for every opportunity in scope can be
//   pulled with a handful of aggregated RPC calls instead of opening 600+
//   individual form views — no per-record page loads needed at all, unlike
//   the subscription-banner tool which had no such shortcut and had to
//   brute-force page loads.
// - "Last update" also needs to catch a stage drag or field edit that
//   didn't generate a chatter message, so this combines the mail.message
//   max date with the record's own `write_date` and takes the later of the
//   two — deliberately NOT `create_date` (creation date), since staleness is
//   about last activity/edit, not opportunity age.

const SCAN_STATE_KEY = "staleScanState";
const RESULTS_KEY = "staleScanResults";
const COUNT_KEY = "staleOppCount";
const PAGE_SIZE = 200;
const MESSAGE_ID_CHUNK = 500;
const STALE_DAYS_THRESHOLD = 30;
const BETWEEN_BATCH_DELAY_MS = 250;

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.sidePanel.open({ tabId: tab.id });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function odooRpcBg(baseUrl, model, method, args, kwargs) {
  const res = await fetch(`${baseUrl}/web/dataset/call_kw`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { model, method, args, kwargs: kwargs || {} },
    }),
  });
  if (!res.ok) throw new Error(`Odoo RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.data?.message || json.error.message || "Odoo RPC error");
  }
  return json.result;
}

// Same technique as the subscription-flag dashboard: there's no public RPC
// for "give me the search bar's current domain," so this watches the
// network request Odoo's own web client already sends to load the
// list/kanban data (a JSON-RPC POST to /web/dataset/call_kw for
// web_search_read on crm.lead) and reads the domain straight out of that
// request body — the exact domain that produced what's on screen. Among
// several crm.lead requests a CRM page can fire (KPI tiles, activity
// counters, etc.), only web_search_read calls are considered, and among
// those, whichever asked for the most fields (the real view request asks
// for every visible column; a summary widget asks for a handful).
const latestPageDomainByTab = new Map(); // tabId -> { domain, fieldCount, timestamp }

function extractCandidateFromRpcParams(params) {
  if (!params || params.model !== "crm.lead" || params.method !== "web_search_read") return null;
  const domain = params.kwargs?.domain;
  if (!Array.isArray(domain)) return null;
  const spec = params.kwargs?.specification;
  const fieldCount = spec && typeof spec === "object" ? Object.keys(spec).length : 0;
  return { domain, fieldCount };
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (!details.tabId || details.tabId < 0) return;
      if (!details.url.includes("/web/dataset/call_kw")) return;
      const raw = details.requestBody?.raw?.[0]?.bytes;
      if (!raw) return;
      const text = new TextDecoder("utf-8").decode(raw);
      const payload = JSON.parse(text);
      const candidate = extractCandidateFromRpcParams(payload?.params);
      if (!candidate) return;

      const existing = latestPageDomainByTab.get(details.tabId);
      const isStale = !existing || Date.now() - existing.timestamp > 4000;
      if (isStale || candidate.fieldCount >= existing.fieldCount) {
        latestPageDomainByTab.set(details.tabId, {
          domain: candidate.domain,
          fieldCount: candidate.fieldCount,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      // Not JSON, not ours, or malformed — ignore and move on.
    }
  },
  { urls: ["*://*/web/dataset/call_kw*"] },
  ["requestBody"]
);

// Nudges the page to reissue its current search (focus search bar + Enter)
// so a tab that was already open before the extension started listening
// still gives us a fresh request to read the domain from.
function triggerSearchRefreshOnPage() {
  try {
    const input = document.querySelector(".o_searchview_input, .o_searchview input[type='text']");
    if (!input) return { ok: false };
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    return { ok: true };
  } catch (err) {
    return { ok: false };
  }
}

async function getActivePageDomain(tabId) {
  if (!tabId) {
    throw new Error("No CRM tab found — open the Odoo CRM list view you want to scan and try again.");
  }
  let entry = latestPageDomainByTab.get(tabId);
  if (!entry) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: triggerSearchRefreshOnPage });
    } catch (err) {
      // Injection can fail (e.g. tab navigated away) — fall through to the
      // error below rather than throwing an unrelated one here.
    }
    await sleep(900);
    entry = latestPageDomainByTab.get(tabId);
  }
  if (!entry) {
    throw new Error(
      "Couldn't read this page's filters — make sure the CRM list/kanban view (with the search bar visible) is the active tab, then try again."
    );
  }
  return entry.domain;
}

// Lost and Won opportunities are always excluded, no toggle — a closed
// deal going 30+ days without an update is expected, not "stale" in the
// sense this scan cares about. This is layered on top of whatever
// filters/facets the user currently has applied, never used to broaden
// scope beyond what's on screen.
async function buildScopeDomain(tabId) {
  const pageDomain = await getActivePageDomain(tabId);
  return [...pageDomain, ["active", "=", true], ["stage_id.is_won", "=", false]];
}

async function countOpportunities(baseUrl, tabId) {
  const domain = await buildScopeDomain(tabId);
  return odooRpcBg(baseUrl, "crm.lead", "search_count", [domain], {});
}

async function fetchAllOpportunities(baseUrl, tabId, onProgress) {
  const fields = ["id", "name", "partner_id", "user_id", "stage_id", "expected_revenue", "write_date"];
  const domain = await buildScopeDomain(tabId);
  let offset = 0;
  const all = [];
  for (;;) {
    const batch = await odooRpcBg(baseUrl, "crm.lead", "search_read", [domain, fields], {
      limit: PAGE_SIZE,
      offset,
      order: "id asc",
    });
    all.push(...batch);
    onProgress?.(all.length);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(BETWEEN_BATCH_DELAY_MS);
  }
  return all;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// One aggregated RPC per chunk of IDs instead of one page-load per record:
// read_group with a max() aggregate on mail.message.date, grouped by res_id,
// scoped to crm.lead messages for exactly the opportunities in scope. This
// is the "inspect the network / find the RPC shortcut" step from the brief
// — the chatter panel's messages are ordinary mail.message rows, and this
// rides the same ORM aggregate any Odoo list view sorting/grouping uses.
async function fetchLastMessageDates(baseUrl, ids, onProgress) {
  const result = new Map(); // id -> ms epoch of last message, or undefined
  const idChunks = chunk(ids, MESSAGE_ID_CHUNK);
  let done = 0;
  for (const idChunk of idChunks) {
    const groups = await odooRpcBg(
      baseUrl,
      "mail.message",
      "read_group",
      [
        [
          ["model", "=", "crm.lead"],
          ["res_id", "in", idChunk],
        ],
        ["date:max"],
        ["res_id"],
      ],
      { lazy: false }
    );
    for (const g of groups || []) {
      const resId = g.res_id;
      const dateStr = g.date; // Odoo UTC datetime string, e.g. "2026-07-01 12:34:56"
      if (resId == null || !dateStr) continue;
      const ms = Date.parse(`${dateStr.replace(" ", "T")}Z`);
      if (!Number.isNaN(ms)) result.set(resId, ms);
    }
    done += idChunk.length;
    onProgress?.(done, ids.length);
    await sleep(BETWEEN_BATCH_DELAY_MS);
  }
  return result;
}

function parseOdooDatetime(str) {
  if (!str) return null;
  const ms = Date.parse(`${str.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

let scanCancelled = false;

async function runStaleScan(baseUrl, tabId) {
  scanCancelled = false;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  await chrome.storage.local.set({
    [SCAN_STATE_KEY]: { status: "listing", checked: 0, total: 0, flagged: 0 },
  });

  const opportunities = await fetchAllOpportunities(trimmedBase, tabId, (count) => {
    chrome.storage.local.set({
      [SCAN_STATE_KEY]: { status: "listing", checked: 0, total: count, flagged: 0 },
    });
  });

  if (scanCancelled) {
    await chrome.storage.local.set({
      [SCAN_STATE_KEY]: { status: "cancelled", checked: 0, total: opportunities.length, flagged: 0 },
    });
    return;
  }

  const total = opportunities.length;
  await chrome.storage.local.set({
    [SCAN_STATE_KEY]: { status: "dates", checked: 0, total, flagged: 0 },
  });

  const ids = opportunities.map((o) => o.id);
  const lastMessageDates = await fetchLastMessageDates(trimmedBase, ids, (done, totalIds) => {
    chrome.storage.local.set({
      [SCAN_STATE_KEY]: { status: "dates", checked: done, total: totalIds, flagged: 0 },
    });
  });

  const now = Date.now();
  const flagged = [];

  for (const opp of opportunities) {
    if (scanCancelled) break;
    const writeMs = parseOdooDatetime(opp.write_date);
    const msgMs = lastMessageDates.get(opp.id) ?? null;
    const lastUpdateMs = [writeMs, msgMs].filter((v) => v != null).reduce((a, b) => Math.max(a, b), 0) || null;
    if (!lastUpdateMs) continue; // no signal at all — skip rather than false-flag

    const daysSince = Math.floor((now - lastUpdateMs) / (24 * 60 * 60 * 1000));
    if (daysSince > STALE_DAYS_THRESHOLD) {
      flagged.push({
        id: opp.id,
        name: opp.name || "",
        contact: Array.isArray(opp.partner_id) ? opp.partner_id[1] : "",
        salesperson: Array.isArray(opp.user_id) ? opp.user_id[1] : "",
        stage: Array.isArray(opp.stage_id) ? opp.stage_id[1] : "",
        expectedRevenue: opp.expected_revenue || 0,
        lastUpdateMs,
        daysSince,
        url: `${trimmedBase}/odoo/crm/${opp.id}`,
      });
    }
  }

  flagged.sort((a, b) => b.daysSince - a.daysSince);

  await chrome.storage.local.set({
    [SCAN_STATE_KEY]: {
      status: scanCancelled ? "cancelled" : "done",
      checked: total,
      total,
      flagged: flagged.length,
      finishedAt: Date.now(),
    },
    [RESULTS_KEY]: flagged,
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_STALE_SCAN") {
    runStaleScan(message.baseUrl, message.tabId).catch((err) => {
      chrome.storage.local.set({
        [SCAN_STATE_KEY]: { status: "error", error: err.message || String(err) },
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "CANCEL_STALE_SCAN") {
    scanCancelled = true;
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "GET_PAGE_COUNT") {
    (async () => {
      try {
        const trimmedBase = message.baseUrl.replace(/\/+$/, "");
        const count = await countOpportunities(trimmedBase, message.tabId);
        await chrome.storage.local.set({ [COUNT_KEY]: count });
        sendResponse({ ok: true, count });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});
