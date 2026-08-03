chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.sidePanel.open({ tabId: tab.id });
});

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_SEARCHES = 4;

function buildPrompt({ customerName, country, domain }) {
  const researchStep = domain
    ? `Step 1: Research the company that owns the domain "${domain}" using web search. This should usually be your only search.
Step 2: Only spend a second search on the company name ("${customerName}")${country ? `, scoped to ${country}` : ""} if the domain search comes up completely empty (parked domain, unrelated site, no real company found at all) — not just because some fields are still unfilled.`
    : `Research the company "${customerName}"${country ? `, based in ${country}` : ""}. No verified company domain was available (its CRM contact record has no email/website on file), so search by name directly.`;

  return `You are helping a Partnership Manager complete a lightweight KYC (Know Your Customer) profile on a business customer, using real web search results.

You have a hard budget of ${MAX_SEARCHES} web searches total for this whole task — spend them deliberately, don't burn one on anything you can leave as "Not found".

${researchStep}

Use web search to find the company's industry, founding year, employee count, and any parent/holding company or sister companies. If a result mentions the company has subsidiaries/sister companies/offices but doesn't name them, it's worth spending one more search specifically trying to find their names — but don't chase this further than that one extra search. If names still aren't found, describe what you found (e.g. "operates through 3 subsidiaries, names not published") rather than just "None found".

Respond with ONLY the following, filled in, and nothing else before or after — no headers other than what's shown, no extra commentary, no other markdown formatting:

Company name:
Industry:
Establishment:
Number of employees:
Holding group / sister companies:
- one bullet per parent/holding company or sister company you can verify, in the form "Company Name — https://website.com" (omit the website only if you truly can't find one)

Rules:
- "Establishment" means the year (or full date, if known) the company was founded/established.
- The first four fields must each be a single short value on one line — no sentences, no citations inline in the text.
- For "Holding group / sister companies", list a separate "- " bullet for each verified parent/holding or sister company, each with its website if found. If you found evidence of subsidiaries/sister companies but couldn't verify their names after the extra search, write one bullet describing what's known (e.g. "- Reported to operate 3 subsidiaries/offices; names not published"). If there's no evidence of any parent/holding/sister companies at all, write exactly one bullet: "- None found".
- Only state facts and company names supported by your search results — do not invent names or websites you haven't confirmed.
- If you cannot find reliable public information for one of the first four fields, write "Not found" for that field instead of guessing.`;
}

const INTERNAL_QUESTIONS = `About the client:
- Company name (as per trade license):
- Business/industry:
- Number of locations, and where (HQ, retail/office branches, etc.):
- Business workflow/process:
- Number of employees:
- Number of employees who will use Odoo:
- Departments of those Odoo users:

About the opportunity:
- Current system being used by the client (if any):
- Reason for considering a change:
- Business issues faced / customer's requirements:
- Why the customer would choose Odoo:
- Why the customer chose this implementing partner over others:

Implementation plan:
- Agreed-upon implementation phases:`;

function buildInternalPrompt(contextText) {
  return `You are extracting account-intake answers from raw internal Odoo CRM text (opportunity descriptions, order notes, chatter log) for a Partnership Manager. You have NO web search access for this task and must not use general knowledge — only the text below.

TEXT:
"""
${contextText || "(no internal text was found on this record)"}
"""

Answer each question below using ONLY information explicitly stated in the text above. If a question isn't answered anywhere in the text, write "Not found" for it — do not guess, infer beyond what's stated, or fill gaps with plausible-sounding assumptions.

${INTERNAL_QUESTIONS}

Respond in exactly the format above (same question labels, each followed by its answer or "Not found"), nothing else before or after.`;
}

async function runInternalExtraction(contextText, apiKey, model) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: buildInternalPrompt(contextText) }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = extractFinalText(data.content);
  if (!text) throw new Error("No text returned by the model.");
  return text;
}

function extractFinalText(messageContent) {
  const textBlocks = (messageContent || []).filter((b) => b.type === "text");
  return textBlocks.map((b) => b.text).join("\n").trim();
}

async function runKyc({ customerName, country, domain }, apiKey, model) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 1024,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: MAX_SEARCHES,
        },
      ],
      messages: [
        {
          role: "user",
          content: buildPrompt({ customerName, country, domain }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = extractFinalText(data.content);
  if (!text) {
    throw new Error("No text returned by the model.");
  }
  return text;
}

// --- CRM subscription-flag dashboard ------------------------------------
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
const PAGE_SIZE = 200;
const TAB_LOAD_TIMEOUT_MS = 20000;
const RENDER_SETTLE_MS = 1200;
const BETWEEN_RECORD_DELAY_MS = 900;

const BANNER_PATTERNS = [
  /already\s+a\s+running\s+or\s+a?\s*churned\s+subscription/i,
  /running\s+or\s+a?\s*churned\s+subscription/i,
  /churned\s+subscription/i,
];

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

async function fetchAllOpportunities(baseUrl, onProgress) {
  const fields = ["id", "name", "partner_id", "user_id", "stage_id", "expected_revenue"];
  const domain = [["type", "=", "opportunity"]];
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

async function checkOpportunityBanner(baseUrl, id) {
  const url = `${baseUrl}/odoo/crm/${id}`;
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    await sleep(RENDER_SETTLE_MS);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageForBanner,
    });
    return textHasBanner(result?.text || "");
  } catch (err) {
    return null; // couldn't determine — skip rather than false-flag
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

let scanCancelled = false;

async function runSubscriptionScan(baseUrl) {
  scanCancelled = false;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  await chrome.storage.local.set({
    [SCAN_STATE_KEY]: { status: "listing", checked: 0, total: 0, flagged: 0 },
  });

  const opportunities = await fetchAllOpportunities(trimmedBase, (count) => {
    chrome.storage.local.set({
      [SCAN_STATE_KEY]: { status: "listing", checked: 0, total: count, flagged: 0 },
    });
  });

  const total = opportunities.length;
  const flagged = [];

  for (let i = 0; i < total; i++) {
    if (scanCancelled) break;
    const opp = opportunities[i];
    const hasBanner = await checkOpportunityBanner(trimmedBase, opp.id);
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
      checked: Math.min(total, flagged.length ? total : total),
      total,
      flagged: flagged.length,
      finishedAt: Date.now(),
    },
    [RESULTS_KEY]: flagged,
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_SUBSCRIPTION_SCAN") {
    runSubscriptionScan(message.baseUrl).catch((err) => {
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

  if (message?.type === "RUN_KYC") {
    (async () => {
      try {
        const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
        if (!apiKey) {
          sendResponse({ ok: false, error: "No Anthropic API key set. Open extension options to add one." });
          return;
        }
        const result = await runKyc(message.payload, apiKey, model);
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // keep the message channel open for the async response
  }

  if (message?.type === "RUN_INTERNAL_KYC") {
    (async () => {
      try {
        const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
        if (!apiKey) {
          sendResponse({ ok: false, error: "No Anthropic API key set. Open extension options to add one." });
          return;
        }
        const result = await runInternalExtraction(message.contextText, apiKey, model);
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});
