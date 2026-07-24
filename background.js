chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.sidePanel.open({ tabId: tab.id });
});

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_SEARCHES = 3;

function buildPrompt({ customerName, country, domain }) {
  const researchStep = domain
    ? `Step 1: Research the company that owns the domain "${domain}" using web search. This should usually be your only search.
Step 2: Only spend a second search on the company name ("${customerName}")${country ? `, scoped to ${country}` : ""} if the domain search comes up completely empty (parked domain, unrelated site, no real company found at all) — not just because some fields are still unfilled.`
    : `Research the company "${customerName}"${country ? `, based in ${country}` : ""}. No verified company domain was available (its CRM contact record has no email/website on file), so search by name directly.`;

  return `You are helping a Partnership Manager complete a lightweight KYC (Know Your Customer) profile on a business customer, using real web search results.

You have a hard budget of ${MAX_SEARCHES} web searches total for this whole task — spend them deliberately, don't burn one on anything you can leave as "Not found".

${researchStep}

Use web search to find the company's industry, founding year, employee count, and any parent/holding company or sister companies. If results mention a parent/holding group or sister companies, note them, but do not spend a dedicated extra search hunting for this — if it didn't come up naturally, list "None found".

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
- For "Holding group / sister companies", list a separate "- " bullet for each verified parent/holding or sister company, each with its website if found. If none can be verified, write exactly one bullet: "- None found".
- Only state facts and company names supported by your search results — do not invent names or websites you haven't confirmed.
- If you cannot find reliable public information for one of the first four fields, write "Not found" for that field instead of guessing.`;
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
  if (message?.type !== "RUN_KYC") return false;

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
});
