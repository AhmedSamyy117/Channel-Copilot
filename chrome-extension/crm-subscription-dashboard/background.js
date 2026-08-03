// CRM Subscription Flags — background service worker
//
// Starting point is the CRM Opportunities/Pipeline, not the Subscriptions
// app: we bulk-fetch every opportunity via Odoo's own JSON-RPC endpoint
// (search_read with offset/limit paging), which sidesteps the list view's
// "40 per page" UI pagination entirely. Odoo doesn't expose the running/
// churned-subscription banner as a filterable field or a discrete RPC call
// we could find, so per the brute-force fallback we open each opportunity's
// form view in a hidden background tab and read the banner off the
// rendered page, same as a human would.

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

// "page" scope needs whatever filters/facets are currently applied in
// Odoo's own search bar (e.g. "Assigned Partner = X", "Stage not = Won"),
// not just the default "My Pipeline" chip. There's no public RPC for
// "give me the current search domain," and reaching into Odoo's internal
// OWL component state (reflection on __owl__) proved too fragile — it
// failed to find the right internal shape on at least one real Odoo
// build. Instead, this listens for the network requests Odoo's own web
// client makes to load the list/kanban data (JSON-RPC POSTs to
// /web/dataset/call_kw), and reads the domain straight out of the request
// body Odoo itself sent. That RPC transport has been Odoo's stable wire
// protocol for well over a decade, so this doesn't depend on any
// version-specific internal JS structure.
const latestPageDomainByTab = new Map(); // tabId -> { domain, timestamp }

function extractDomainFromRpcParams(params) {
  if (!params || params.model !== "crm.lead") return null;
  if (!["search_read", "web_search_read", "search_count"].includes(params.method)) return null;
  let domain = params.kwargs?.domain;
  if (!domain && Array.isArray(params.args) && Array.isArray(params.args[0])) {
    domain = params.args[0];
  }
  return Array.isArray(domain) ? domain : null;
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
      const domain = extractDomainFromRpcParams(payload?.params);
      if (domain) {
        latestPageDomainByTab.set(details.tabId, { domain, timestamp: Date.now() });
      }
    } catch (err) {
      // Not JSON, not ours, or malformed — ignore and move on.
    }
  },
  { urls: ["*://*/web/dataset/call_kw*"] },
  ["requestBody"]
);

async function getActivePageDomain(tabId) {
  if (!tabId) {
    throw new Error("No CRM tab found — open the Odoo Pipeline page and try again.");
  }
  const entry = latestPageDomainByTab.get(tabId);
  if (!entry) {
    throw new Error(
      "Haven't seen this page's search query yet — click a filter, refresh the list, or switch pages once on the CRM tab, then try again."
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

// Injected into the hidden form-view tab. Reads the rendered page text
// rather than relying on a fixed selector, since the banner's markup could
// change across Odoo versions/customizations.
function scanPageForBanner() {
  const text = document.body.innerText || "";
  return { text };
}

function textHasBanner(text) {
  return BANNER_PATTERNS.some((re) => re.test(text));
}

// Chrome throws "Tabs cannot be edited right now (user may be dragging a
// tab)" if a tab operation lands at the wrong moment (e.g. the user is
// mid-drag on the tab strip). It's transient — retrying a beat later almost
// always succeeds — so we retry a couple of times before giving up on this
// one record, rather than letting it escape and abort the whole scan.
function isTransientTabError(err) {
  return /dragging a tab|tabs cannot be edited/i.test(err?.message || "");
}

async function checkOpportunityBanner(baseUrl, id, attempt = 1) {
  const url = `${baseUrl}/odoo/crm/${id}`;
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    await sleep(RENDER_SETTLE_MS);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageForBanner,
    });
    return textHasBanner(result?.text || "");
  } catch (err) {
    if (isTransientTabError(err) && attempt < 3) {
      await sleep(1500 * attempt);
      return checkOpportunityBanner(baseUrl, id, attempt + 1);
    }
    return null; // couldn't determine — skip rather than false-flag or abort
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
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
