// CRM Subscription Flags — background service worker
//
// Starting point is the CRM Opportunities/Pipeline, not the Subscriptions
// app: we bulk-fetch every opportunity via Odoo's own JSON-RPC endpoint
// (search_read with offset/limit paging), which sidesteps the list view's
// "40 per page" UI pagination entirely. Odoo doesn't expose the running/
// churned-subscription banner as a filterable field or a discrete RPC call
// we could find, so per the brute-force fallback we open each opportunity's
// form view (in an unfocused scan window, see below) and read the banner
// off the rendered page, same as a human would.

const SCAN_STATE_KEY = "subscriptionScanState";
const RESULTS_KEY = "subscriptionScanResults";
const COUNTS_KEY = "subscriptionOppCounts";
const PAGE_SIZE = 200;
const TAB_LOAD_TIMEOUT_MS = 20000;
const RENDER_SETTLE_MS = 1200;
const BETWEEN_RECORD_DELAY_MS = 900;

const BANNER_PATTERNS = [
  /already\s+a\s+running\s+or\s+a?\s*churned\s+subscription/i,
  /running\s+or\s+a?\s*churned\s+subscription/i,
  /churned\s+subscription/i,
];

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

// "mine" mirrors Odoo's own default "My Pipeline" filter (the one visible
// as a search-bar chip on the CRM page) so scoping to it matches what the
// user is actually looking at, rather than every opportunity in the company.
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

// "page" scope needs to match whatever filters/facets are currently
// applied in Odoo's own search bar (e.g. "Assigned Partner = X", "Stage
// not = Won"), not just the default "My Pipeline" chip. There's no public
// RPC for "give me the current search domain," and two internal
// approaches both proved too fragile on real Odoo instances: reflecting
// into the OWL component's internal search-model state (version-specific,
// never found the right shape), and reading record IDs off the rendered
// DOM (the `data-id` Odoo puts on rows/cards turned out not to reliably
// correspond to what's expected, and an auto-nudge that toggled the view
// switcher to force a fresh request was visibly disruptive).
//
// This instead passively watches the network requests Odoo's own web
// client already makes to load the list/kanban data (JSON-RPC POSTs to
// /web/dataset/call_kw) and reads the domain straight out of the request
// body Odoo itself sent — the exact domain that produced what's on
// screen. It's purely passive: nothing on the page is touched. If no such
// request has been observed yet from that tab (e.g. the page loaded
// before the extension was ready to listen), the fix is simply to
// interact with the page once yourself — click a filter, remove/re-add
// one, or switch pages — which makes Odoo issue a fresh request for the
// listener to catch.
const latestPageDomainByTab = new Map(); // tabId -> { domain, fieldCount, timestamp }

// A CRM page fires more than one crm.lead RPC — the main list/kanban call
// that renders what you're looking at, but also assorted background
// widgets (KPI tiles, activity counters, etc.) that also query crm.lead,
// often via search_count or a web_search_read with a handful of fields for
// a summary number. Grabbing whichever request happens to land last was
// picking up one of those side calls instead of the real one, matching
// nothing visible on screen.
//
// So this only looks at "web_search_read" — the call the list/kanban
// renderer itself makes — and, since more than one web_search_read can
// still fire (sub-widgets use it too), keeps whichever one requested the
// most fields. The real view's data call asks for every visible column
// (typically a dozen-plus fields); a KPI/summary widget asks for a
// handful. Field count is a solid proxy for "this is the real one."
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

// Passive observation only catches requests made *after* the listener
// started — a tab that was already open and hasn't been touched since
// (e.g. right after the extension reloaded) has nothing to observe, and
// asking the user to manually click a filter every single time was the
// wrong tradeoff. Instead, nudge the page ourselves: focus the search bar
// and press Enter. Odoo treats that as "commit the search" and reissues
// the exact same query with the exact same filters — nothing about the
// filters, the view, or the scroll position changes, just a brief cursor
// blink in the search box — which gives the listener above a fresh
// request to read.
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
    throw new Error("No CRM tab found — open the Odoo Pipeline page and try again.");
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

// Injected into the hidden form-view tab. Odoo renders this notice as a
// yellow alert box (role="alert" / class containing "alert"), so we read
// that element's text specifically — a smaller, more targeted signal than
// the whole page — and also keep the full body text as a fallback in case
// the banner's markup doesn't use that pattern on some version/customization.
function scanPageForBanner() {
  const alertNodes = Array.from(document.querySelectorAll('[role="alert"], [class*="alert"]'));
  const alertText = alertNodes.map((el) => el.innerText || "").join("\n");
  const text = document.body.innerText || "";
  return { alertText, text };
}

function textHasBanner(text) {
  return BANNER_PATTERNS.some((re) => re.test(text));
}

function pageHasBanner(result) {
  return textHasBanner(result?.alertText || "") || textHasBanner(result?.text || "");
}

// Chrome throws "Tabs cannot be edited right now (user may be dragging a
// tab)" if a tab operation lands at the wrong moment (e.g. the user is
// mid-drag on the tab strip). It's transient — retrying a beat later almost
// always succeeds — so we retry a couple of times before giving up on this
// one record, rather than letting it escape and abort the whole scan.
function isTransientTabError(err) {
  return /dragging a tab|tabs cannot be edited/i.test(err?.message || "");
}

// The banner is computed by a second, async lookup (checking the partner's
// subscriptions) that finishes after the rest of the form has rendered.
// Opening each record as a hidden tab (`chrome.tabs.create({active: false})`)
// in the user's own window meant it was never the active tab there — and
// Odoo's client, like most web apps, gates non-essential async work behind
// the page's visibility state, so that lookup may simply never fire at all
// for a background tab, no matter how long we poll. That's why known-banner
// records were still coming back unflagged even after adding polling.
//
// The fix: run the scan in a separate, unfocused browser *window* instead.
// A tab that's the *active* tab of its own window reports as visible
// (`document.visibilityState === "visible"`) even when that window isn't
// focused at the OS level — so Odoo's page behaves exactly as it would if
// the user had actually clicked into it, without ever stealing focus from
// whatever the user is doing. One window/tab is created once for the whole
// scan and reused (navigated) for every record, rather than opening and
// closing a tab per record.
let scanWindowId = null;
let scanTabId = null;

async function ensureScanWindow() {
  if (scanWindowId != null && scanTabId != null) {
    try {
      await chrome.windows.get(scanWindowId);
      return scanTabId;
    } catch (err) {
      // Window was closed (e.g. by the user) — fall through and recreate.
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

// Rather than always waiting the full window (which would multiply total
// scan time across 600+ records), poll repeatedly but stop early once the
// page's text stops changing between two consecutive checks — a proxy for
// "whatever was still loading has settled" — so records with no banner
// exit quickly, while ones where content is still shifting keep getting
// checked up to the cap.
const BANNER_POLL_INTERVAL_MS = 600;
const BANNER_POLL_MAX_ATTEMPTS = 8; // cap: ~5s extra on top of RENDER_SETTLE_MS
const BANNER_STABLE_CHECKS_TO_STOP = 2;

async function checkOpportunityBanner(baseUrl, id, attempt = 1) {
  const url = `${baseUrl}/odoo/crm/${id}`;
  try {
    const tabId = await ensureScanWindow();
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    await sleep(RENDER_SETTLE_MS);

    let lastText = null;
    let stableCount = 0;
    for (let poll = 0; poll < BANNER_POLL_MAX_ATTEMPTS; poll++) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: scanPageForBanner,
      });
      if (pageHasBanner(result)) return true;

      const text = result?.text || "";
      if (text === lastText) {
        stableCount++;
        if (stableCount >= BANNER_STABLE_CHECKS_TO_STOP) break;
      } else {
        stableCount = 0;
      }
      lastText = text;

      await sleep(BANNER_POLL_INTERVAL_MS);
    }
    return false;
  } catch (err) {
    if (isTransientTabError(err) && attempt < 3) {
      await sleep(1500 * attempt);
      return checkOpportunityBanner(baseUrl, id, attempt + 1);
    }
    // Something else went wrong with the scan window (e.g. it was closed
    // mid-check) — drop it so the next record recreates a fresh one.
    scanWindowId = null;
    scanTabId = null;
    return null; // couldn't determine — skip rather than false-flag or abort
  }
}

let scanCancelled = false;

async function runSubscriptionScan(baseUrl, scope, tabId) {
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
      // A single record's check failing (transient tab error, page timeout,
      // etc.) shouldn't abort the other 600+ — skip it and keep going.
      let hasBanner;
      try {
        hasBanner = await checkOpportunityBanner(trimmedBase, opp.id);
      } catch (err) {
        hasBanner = null;
      }
      if (hasBanner) {
        flagged.push({
          id: opp.id,
          name: opp.name || "",
          contact: Array.isArray(opp.partner_id) ? opp.partner_id[1] : "",
          salesperson: Array.isArray(opp.user_id) ? opp.user_id[1] : "",
          stage: Array.isArray(opp.stage_id) ? opp.stage_id[1] : "",
          expectedRevenue: opp.expected_revenue || 0,
          url: `${trimmedBase}/odoo/crm/${opp.id}`,
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
  if (message?.type === "START_SUBSCRIPTION_SCAN") {
    runSubscriptionScan(message.baseUrl, message.scope, message.tabId).catch((err) => {
      chrome.storage.local.set({
        [SCAN_STATE_KEY]: { status: "error", error: err.message || String(err) },
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "CANCEL_SUBSCRIPTION_SCAN") {
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

  return false;
});
