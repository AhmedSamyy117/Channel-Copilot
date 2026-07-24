# Channel Copilot

Chrome extension that reads an open Odoo Subscriptions page and runs a
lightweight KYC lookup on the customer via the Claude API.

## Load the extension

1. `chrome://extensions` → enable Developer mode.
2. "Load unpacked" → select this repo folder.
3. Click the extension icon on an Odoo subscription page (e.g.
   `.../odoo/subscriptions/...`) to open the side panel.

## Setup

Open the extension's options page (link at the bottom of the side panel)
and paste an Anthropic API key. The key is stored only in
`chrome.storage.local` on your machine and is sent solely to
`api.anthropic.com`.

## How it works

- `content.js` scrapes the subscription form (customer, country guess,
  subscription code, plan, hosting, referrer, MRR) using label-based DOM
  matching, since Odoo field order can vary.
- `sidepanel.js` displays the extracted fields and, on request, asks
  `background.js` to research the customer.
- `background.js` calls the Anthropic Messages API with the
  `web_search_20250305` tool (capped at 3 searches) and returns a
  structured KYC summary: industry, establishment year, employee count,
  and any holding/sister companies found.

## Notes / limitations

- Field extraction is heuristic (label-text matching), since Odoo Studio
  customizations can reorder or rename fields. If extraction fails, the
  panel will say so — this is not a hard crash.
- The extension does not know the customer's website domain from the
  Odoo page alone, so KYC research is scoped to company name + country.
- No backend server: the API key lives in the browser, and API calls go
  directly from the extension to Anthropic.
