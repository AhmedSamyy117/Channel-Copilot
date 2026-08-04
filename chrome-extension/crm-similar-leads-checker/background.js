// CRM Similar Leads Checker — background service worker
//
// Odoo's "Similar Leads" smart button navigates to a client-side action (a
// kanban view grouped by stage) rather than firing a discrete, inspectable
// RPC we could call directly — confirmed by walking the actual UI (button →
// kanban grouped by Territory/Qualified/.../Won, with lost records shown
// ribboned inside their stage column rather than a separate "Lost" stage).
// So, per the same lesson learned on CRM Subscription Flags (no shortcut
// RPC/field existed there either), this brute-forces it: open each
// opportunity's form in an unfocused scan window, read the button's count,
// click it, and read the rendered kanban breakdown off the DOM.

const SCAN_STATE_KEY = "similarLeadsScanState";
const RESULTS_KEY = "similarLeadsScanResults";
const COUNTS_KEY = "similarLeadsOppCounts";
const PAGE_SIZE = 200;
const TAB_LOAD_TIMEOUT_MS = 20000;
const RENDER_SETTLE_MS = 1000;
const BETWEEN_RECORD_DELAY_MS = 700;

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

async function getCurrentUserId(baseUrl) {
  const res = await fetch(`${baseUrl}/web/session/get_session_info`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {} }),
  });
  if (!res.ok) throw new Error(`Session lookup HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.data?.message || json.error.message || "Session lookup failed");
  const uid = json.result?.uid;
  if (!uid) throw new Error("Could not determine the current Odoo user.");
  return uid;
}

// Same "page" scope approach as CRM Subscription Flags: watch the network
// request Odoo's own client sends to load the list/kanban (web_search_read
// on crm.lead), pick whichever asked for the most fields (the real view,
// not a KPI/summary widget), and nudge a fresh one via the search bar if
// nothing's been observed yet on that tab.
const latestPageDomainByTab = new Map();

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

// A single nudge attempt (focus search box, press Enter, wait ~900ms) was
// found to sometimes miss: the synthetic keypress can race with Odoo's own
// search-widget JS, especially right when the extension's service worker
// has just woken up and its webRequest listener is only freshly attached.
// Retrying a few times with a growing delay, instead of failing after one
// shot, means the user doesn't have to notice the failure and click "Run
// scan" again themselves — the same recovery just happens automatically.
const PAGE_DOMAIN_NUDGE_ATTEMPTS = 4;
const PAGE_DOMAIN_NUDGE_DELAYS_MS = [700, 1000, 1400, 1800];

async function getActivePageDomain(tabId) {
  if (!tabId) {
    throw new Error("No CRM tab found — open the Odoo Pipeline page and try again.");
  }
  let entry = latestPageDomainByTab.get(tabId);
  for (let attempt = 0; !entry && attempt < PAGE_DOMAIN_NUDGE_ATTEMPTS; attempt++) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: triggerSearchRefreshOnPage });
    } catch (err) {
      // Injection can fail (e.g. tab navigated away) — fall through below
      // and just try again on the next attempt.
    }
    await sleep(PAGE_DOMAIN_NUDGE_DELAYS_MS[attempt]);
    entry = latestPageDomainByTab.get(tabId);
  }
  if (!entry) {
    throw new Error(
      "Couldn't read this page's filters — make sure the CRM Pipeline tab (list or kanban view, with the search bar visible) is the active tab, then try again."
    );
  }
  return entry.domain;
}

async function buildScopeDomain(baseUrl, scope, tabId) {
  if (scope === "page") {
    return getActivePageDomain(tabId);
  }
  const domain = [["type", "=", "opportunity"]];
  if (scope === "mine") {
    const uid = await getCurrentUserId(baseUrl);
    domain.push(["user_id", "=", uid]);
  }
  return domain;
}

async function countOpportunities(baseUrl, scope, tabId) {
  const domain = await buildScopeDomain(baseUrl, scope, tabId);
  return odooRpcBg(baseUrl, "crm.lead", "search_count", [domain], {});
}

async function fetchAllOpportunities(baseUrl, scope, tabId, onProgress) {
  const fields = ["id", "name", "partner_id", "user_id", "stage_id", "expected_revenue"];
  const domain = await buildScopeDomain(baseUrl, scope, tabId);
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
  }
  return all;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// Injected into the scan tab's opportunity form. Finds the "Similar Leads"
// smart button and reads its count without clicking (0 short-circuits the
// whole record — no point clicking through to an empty kanban).
function readSimilarLeadsCount() {
  const buttons = Array.from(document.querySelectorAll("button.oe_stat_button, .oe_stat_button"));
  const btn =
    buttons.find((b) => (b.getAttribute("name") || "").includes("similar_leads")) ||
    buttons.find((b) => /similar/i.test(b.textContent || ""));
  if (!btn) return { found: false, count: 0 };
  const text = (btn.textContent || "").replace(/\s+/g, " ").trim();
  const match = text.match(/\d+/);
  return { found: true, count: match ? parseInt(match[0], 10) : 0 };
}

// Clicks the same button — Odoo navigates to a kanban view of the matches,
// grouped by stage.
function clickSimilarLeadsButton() {
  const buttons = Array.from(document.querySelectorAll("button.oe_stat_button, .oe_stat_button"));
  const btn =
    buttons.find((b) => (b.getAttribute("name") || "").includes("similar_leads")) ||
    buttons.find((b) => /similar/i.test(b.textContent || ""));
  if (!btn) return { ok: false };
  btn.click();
  return { ok: true };
}

// Reads the rendered kanban: one group per stage, cards per group. A "Lost"
// opportunity isn't a separate stage in standard Odoo CRM — it's shown as a
// ribboned card inside whatever stage it was in when marked lost, so we
// detect that ribbon per-card rather than assuming a "Lost" column exists.
function scanKanbanBreakdown() {
  const groups = Array.from(document.querySelectorAll(".o_kanban_group"));
  if (!groups.length) return null;

  const stages = groups.map((g) => {
    const titleEl = g.querySelector(".o_column_title, .o_kanban_header_title, .o_kanban_group_title");
    const stage = ((titleEl && titleEl.textContent) || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(g.querySelectorAll(".o_kanban_record"));
    const items = cards.map((c) => {
      const isLost = !!c.querySelector('.ribbon, [class*="ribbon"]') || /\blost\b/i.test(c.className || "");
      const nameEl = c.querySelector("strong, .o_kanban_record_title, .oe_kanban_details strong");
      return {
        name: ((nameEl && nameEl.textContent) || "").replace(/\s+/g, " ").trim(),
        lost: isLost,
      };
    });
    return { stage, total: items.length, lost: items.filter((i) => i.lost).length, items };
  });

  return { stages, bodyText: document.body.innerText || "" };
}

// Polls (rather than a single fixed-delay read) but stops early once the
// kanban's text stops changing between checks, same "settle" trick used for
// the subscription banner — keeps fast records fast.
async function pollKanbanBreakdown(tabId) {
  let lastText = null;
  let stableCount = 0;
  const maxAttempts = 8;
  const intervalMs = 500;

  for (let i = 0; i < maxAttempts; i++) {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: scanKanbanBreakdown });
    if (result && result.stages.length) {
      if (result.bodyText === lastText) {
        stableCount++;
        if (stableCount >= 2) return result;
      } else {
        stableCount = 0;
      }
      lastText = result.bodyText;
    }
    await sleep(intervalMs);
  }
  return null; // kanban never rendered in time — caller treats as "couldn't determine"
}

function isTransientTabError(err) {
  return /dragging a tab|tabs cannot be edited/i.test(err?.message || "");
}

// Same reasoning as CRM Subscription Flags: a background tab that's never
// the *active* tab of its own window can have Odoo's async work gated
// behind page-visibility and simply never run. Reuse one unfocused window
// for the whole scan instead of a hidden tab in the user's own window.
let scanWindowId = null;
let scanTabId = null;

async function ensureScanWindow() {
  if (scanWindowId != null && scanTabId != null) {
    try {
      await chrome.windows.get(scanWindowId);
      return scanTabId;
    } catch (err) {
      scanWindowId = null;
      scanTabId = null;
    }
  }
  const win = await chrome.windows.create({
    url: "about:blank",
    focused: false,
    type: "normal",
    width: 1000,
    height: 800,
  });
  scanWindowId = win.id;
  scanTabId = win.tabs[0].id;
  return scanTabId;
}

async function closeScanWindow() {
  if (scanWindowId != null) {
    await chrome.windows.remove(scanWindowId).catch(() => {});
  }
  scanWindowId = null;
  scanTabId = null;
}

async function checkOpportunitySimilarLeads(baseUrl, id, attempt = 1) {
  const url = `${baseUrl}/odoo/crm/${id}`;
  try {
    const tabId = await ensureScanWindow();
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    await sleep(RENDER_SETTLE_MS);

    const [{ result: countResult }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readSimilarLeadsCount,
    });
    if (!countResult || !countResult.found || !countResult.count) {
      return { count: 0, totalExcludingLost: 0, breakdown: {} };
    }

    await chrome.scripting.executeScript({ target: { tabId }, func: clickSimilarLeadsButton });
    await sleep(400);
    const breakdown = await pollKanbanBreakdown(tabId);
    if (!breakdown) {
      // Button reported a count but the kanban never rendered in time —
      // still surface the raw count so the record isn't silently dropped.
      return { count: countResult.count, totalExcludingLost: null, breakdown: null };
    }

    let total = 0;
    let totalExcludingLost = 0;
    const stageBreakdown = {};
    for (const s of breakdown.stages) {
      if (!s.total) continue;
      stageBreakdown[s.stage] = { total: s.total, lost: s.lost };
      total += s.total;
      totalExcludingLost += s.total - s.lost;
    }
    return { count: total, totalExcludingLost, breakdown: stageBreakdown };
  } catch (err) {
    if (isTransientTabError(err) && attempt < 3) {
      await sleep(1500 * attempt);
      return checkOpportunitySimilarLeads(baseUrl, id, attempt + 1);
    }
    scanWindowId = null;
    scanTabId = null;
    return null; // couldn't determine — skip rather than false-flag or abort
  }
}

let scanCancelled = false;

async function runSimilarLeadsScan(baseUrl, scope, tabId) {
  scanCancelled = false;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  await chrome.storage.local.set({
    [SCAN_STATE_KEY]: { status: "listing", checked: 0, total: 0, flagged: 0 },
  });

  const opportunities = await fetchAllOpportunities(trimmedBase, scope, tabId, (count) => {
    chrome.storage.local.set({
      [SCAN_STATE_KEY]: { status: "listing", checked: 0, total: count, flagged: 0 },
    });
  });

  const total = opportunities.length;
  const flagged = [];

  try {
    for (let i = 0; i < total; i++) {
      if (scanCancelled) break;
      const opp = opportunities[i];
      let res;
      try {
        res = await checkOpportunitySimilarLeads(trimmedBase, opp.id);
      } catch (err) {
        res = null;
      }
      if (res && res.count > 0) {
        flagged.push({
          id: opp.id,
          name: opp.name || "",
          contact: Array.isArray(opp.partner_id) ? opp.partner_id[1] : "",
          salesperson: Array.isArray(opp.user_id) ? opp.user_id[1] : "",
          stage: Array.isArray(opp.stage_id) ? opp.stage_id[1] : "",
          expectedRevenue: opp.expected_revenue || 0,
          url: `${trimmedBase}/odoo/crm/${opp.id}`,
          total: res.count,
          totalExcludingLost: res.totalExcludingLost,
          breakdown: res.breakdown,
        });
        await chrome.storage.local.set({ [RESULTS_KEY]: flagged });
      }

      await chrome.storage.local.set({
        [SCAN_STATE_KEY]: { status: "scanning", checked: i + 1, total, flagged: flagged.length },
      });

      await sleep(BETWEEN_RECORD_DELAY_MS);
    }
  } finally {
    await closeScanWindow();
  }

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
  if (message?.type === "START_SIMILAR_LEADS_SCAN") {
    runSimilarLeadsScan(message.baseUrl, message.scope, message.tabId).catch((err) => {
      chrome.storage.local.set({
        [SCAN_STATE_KEY]: { status: "error", error: err.message || String(err) },
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "CANCEL_SIMILAR_LEADS_SCAN") {
    scanCancelled = true;
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "GET_OPP_COUNTS") {
    (async () => {
      try {
        const trimmedBase = message.baseUrl.replace(/\/+$/, "");
        const [mine, all] = await Promise.all([
          countOpportunities(trimmedBase, "mine"),
          countOpportunities(trimmedBase, "all"),
        ]);
        const counts = { mine, all };
        await chrome.storage.local.set({ [COUNTS_KEY]: counts });
        sendResponse({ ok: true, counts });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "GET_PAGE_COUNT") {
    (async () => {
      try {
        const trimmedBase = message.baseUrl.replace(/\/+$/, "");
        const count = await countOpportunities(trimmedBase, "page", message.tabId);
        sendResponse({ ok: true, count });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "OPEN_SIMILAR_LEADS_RESULTS_WINDOW") {
    (async () => {
      const { [RESULTS_KEY]: results } = await chrome.storage.local.get([RESULTS_KEY]);
      await chrome.storage.local.set({
        similarLeadsResultsSnapshot: { results: results || [], generatedAt: Date.now() },
      });
      await chrome.tabs.create({ url: chrome.runtime.getURL("results.html") });
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
