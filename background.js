chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.sidePanel.open({ tabId: tab.id });
});

// Batch "Similar Leads" scan results come from a content script (no tabs
// API access there), so it asks the background page to stash the data and
// open the results tab.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OPEN_SIMILAR_LEADS_RESULTS") {
    (async () => {
      await chrome.storage.local.set({
        similarLeadsResults: {
          results: message.results,
          origin: message.origin,
          generatedAt: Date.now(),
        },
      });
      await chrome.tabs.create({ url: chrome.runtime.getURL("similar_leads_results.html") });
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
