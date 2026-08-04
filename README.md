# Channel Copilot

Chrome extension that reads an open Odoo Subscriptions page and runs a
lightweight KYC lookup on the customer via the Claude API.

See also the standalone tools in `chrome-extension/`:
- `chrome-extension/crm-subscription-dashboard/` — flags opportunities
  with a running/churned subscription.
- `chrome-extension/crm-similar-leads-checker/` — reports each
  opportunity's similar-leads count and stage breakdown.

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

## Similar Leads duplicate-checker

`similar_leads.js` is auto-injected on every page (it no-ops instantly unless
it detects an Odoo CRM opportunity form or list/kanban view) and:

- On an opportunity form: reads the count off the native "Similar Leads"
  smart button, then calls Odoo's own `crm.lead.action_similar_leads` server
  method to get the exact duplicate-matching domain Odoo already computed
  (email/phone/partner — whatever it is, we don't need to know), and does a
  single (paginated) `search_read` with it. Renders an inline panel under the
  smart button with the total and a per-stage breakdown, plus a persistent
  "Exclude Lost" toggle (stored in `chrome.storage.local`, remembered across
  opportunities).
- On a CRM list/kanban view: adds a "Check Similar Leads (visible)" button to
  the control panel toolbar. Clicking it scans every currently-loaded
  record's similar leads the same way, then opens the results as a table in
  a new tab (`similar_leads_results.html`) — one row per opportunity, sorted
  by similar-lead count, with the stage breakdown and a link back to each
  record.

This declares a broad (`<all_urls>`) content script since the tool needs to
appear automatically as you land on a page, unlike the on-demand KYC side
panel — Chrome will show the corresponding "read/change data on all sites"
permission warning.

## Notes / limitations

- Field extraction is heuristic (label-text matching), since Odoo Studio
  customizations can reorder or rename fields. If extraction fails, the
  panel will say so — this is not a hard crash.
- The extension does not know the customer's website domain from the
  Odoo page alone, so KYC research is scoped to company name + country.
- No backend server: the API key lives in the browser, and API calls go
  directly from the extension to Anthropic.
