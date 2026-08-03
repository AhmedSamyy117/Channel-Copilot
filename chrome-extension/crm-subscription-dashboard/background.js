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

// "page" scope needs to match whatever filters/facets are currently
// applied in Odoo's own search bar (e.g. "Assigned Partner = X", "Stage
// not = Won"), not just the default "My Pipeline" chip. Two earlier
// approaches both proved too fragile on real Odoo instances: reflecting
// into the OWL component's internal search-model state (version-specific,
// never found the right shape), and passively sniffing the JSON-RPC
// request body Odoo's client sends (worked in principle, but recovering
// from a cold tab required auto-toggling the view switcher, which visibly
// flips the page between kanban and list and still wasn't reliable).
//
// Instead, this reads the record IDs directly off whatever is already
// rendered on screen — the exact rows/cards the user is looking at — and
// pages through the list/kanban pager to collect every ID if there's more
// than one page. No domain to reconstruct, no RPC to guess at, and
// nothing on the page changes that the user didn't already trigger
// themselves (view stays whatever it already was).
function scrapeAllVisibleRecordIds() {
  function readPagerTotal() {
    const el = document.querySelector(".o_pager_counter, .o_pager");
    if (!el) return null;
    const match = (el.innerText || "").match(/\/\s*([\d,]+)/);
    return match ? parseInt(match[1].replace(/,/g, ""), 10) : null;
  }
  function currentIds() {
    return Array.from(document.querySelectorAll(".o_data_row[data-id], .o_kanban_record[data-id]"))
      .map((el) => el.dataset.id)
      .filter(Boolean);
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return (async () => {
    const ids = new Set();
    const total = readPagerTotal();
    let guard = 0;
    let pagesAdvanced = 0;
    for (;;) {
      currentIds().forEach((id) => ids.add(id));
      if (total && ids.size >= total) break;
      const nextBtn = document.querySelector(".o_pager_next");
      if (!nextBtn || nextBtn.disabled || nextBtn.classList.contains("disabled")) break;
      nextBtn.click();
      pagesAdvanced++;
      await sleep(700);
      guard++;
      if (guard > 500) break; // safety cap, should never hit in practice
    }
    // Leave the view exactly how it was found rather than stuck on the
    // last page — page back the same number of times we paged forward.
    for (let i = 0; i < pagesAdvanced; i++) {
      const prevBtn = document.querySelector(".o_pager_previous");
      if (!prevBtn || prevBtn.disabled || prevBtn.classList.contains("disabled")) break;
      prevBtn.click();
      await sleep(700);
    }
    return Array.from(ids);
  })();
}

async function scrapePageOpportunityIds(tabId) {
  if (!tabId) {
    throw new Error("No CRM tab found — open the Odoo Pipeline page and try again.");
  }
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeAllVisibleRecordIds });
  } catch (err) {
    throw new Error(
      "Couldn't read this page's records — make sure the CRM Pipeline tab (list or kanban view) is open, then try again."
    );
  }
  const raw = results?.[0]?.result || [];
  const ids = raw.map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id));
  if (!ids.length) {
    throw new Error(
      "No records found on this page — make sure the CRM Pipeline tab (list or kanban view) is open, then try again."
    );
  }
  return ids;
}

async function buildScopeDomain(baseUrl, scope) {
  const domain = [["type", "=", "opportunity"]];
  if (scope === "mine") {
    const uid = await getCurrentUserId(baseUrl);
    domain.push(["user_id", "=", uid]);
  }
  return domain;
}

async function countOpportunities(baseUrl, scope, tabId) {
  if (scope === "page") {
    const ids = await scrapePageOpportunityIds(tabId);
    return ids.length;
  }
  const domain = await buildScopeDomain(baseUrl, scope);
  return odooRpcBg(baseUrl, "crm.lead", "search_count", [domain], {});
}

async function fetchAllOpportunities(baseUrl, scope, tabId, onProgress) {
  const fields = ["id", "name", "partner_id", "user_id", "stage_id", "expected_revenue"];

  if (scope === "page") {
    const ids = await scrapePageOpportunityIds(tabId);
    const all = await odooRpcBg(baseUrl, "crm.lead", "search_read", [[["id", "in", ids]], fields], {
      order: "id asc",
    });
    onProgress?.(all.length);
    return all;
  }

  const domain = await buildScopeDomain(baseUrl, scope);
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

// The banner itself is often computed by a second, async lookup (checking
// the partner's subscriptions) that finishes after the rest of the form
// has rendered — and since this is a hidden/background tab, Chrome throttles
// its timers, so that lookup can take noticeably longer than in a normal
// foreground tab. A single fixed-delay snapshot was missing real banners
// that hadn't rendered in time yet.
//
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
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    await sleep(RENDER_SETTLE_MS);

    let lastText = null;
    let stableCount = 0;
    for (let poll = 0; poll < BANNER_POLL_MAX_ATTEMPTS; poll++) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
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
