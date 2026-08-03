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

## Subscription-flag dashboard

Odoo's CRM already shows a native banner on an opportunity's form view when
its customer has a running or churned subscription ("This customer has
already a running or a churned subscription, check them here"). This
extension doesn't re-derive that signal — it surfaces it in bulk across the
whole pipeline instead of you clicking into 600+ opportunities one at a
time.

Open it from the side panel ("Subscription-flag dashboard" link), or
directly at `chrome-extension://<id>/dashboard.html`.

**Setup**: on first use, enter your Odoo instance's base URL (e.g.
`https://yourcompany.odoo.com`). Chrome will prompt you to approve access
for that site — this is a one-time, site-scoped grant so the extension can
call Odoo's own JSON-RPC endpoint using your existing logged-in session
(no separate login/credentials handling; you're expected to already be
signed into Odoo in your browser).

**How the scan works**:
1. Fetches every `crm.lead` record of type `opportunity` via Odoo's
   `/web/dataset/call_kw` JSON-RPC endpoint (`search_read`, paged by
   offset/limit). This bulk RPC call naturally covers all 600+ records —
   it doesn't rely on paging through the list view's UI at all.
2. We looked for a shortcut to avoid opening every record individually —
   either a dedicated RPC method backing the banner, or a filterable
   boolean field on `crm.lead` — but didn't find one exposed. Per that
   investigation, the banner check falls back to opening each opportunity's
   form view in a hidden background tab (`chrome.tabs.create({active:
   false})`), waiting for it to render, and text-matching the page for the
   banner's phrasing ("running or a churned subscription"). Tabs are opened
   one at a time with a delay between each to avoid hammering the instance.
3. Only flagged opportunities (name, contact/company, salesperson, stage,
   expected revenue, and a link back to the record) are kept and shown in
   the dashboard table — sortable by column, filterable by salesperson,
   stage, or a text search over name/contact.
4. Results, scan progress, and a "last refreshed" timestamp persist in
   `chrome.storage.local`, so the dashboard is re-runnable: click "Run scan"
   again any time to refresh it, or "Cancel" to stop a scan in progress.

Because it opens one hidden tab per opportunity, a full scan across 600+
records takes a while (roughly 1–2 seconds per record, so 15–20+ minutes)
— this is the accepted tradeoff of the brute-force approach versus
reverse-engineering Odoo's internal subscription-check logic.

## Notes / limitations

- Field extraction is heuristic (label-text matching), since Odoo Studio
  customizations can reorder or rename fields. If extraction fails, the
  panel will say so — this is not a hard crash.
- The extension does not know the customer's website domain from the
  Odoo page alone, so KYC research is scoped to company name + country.
- No backend server: the API key lives in the browser, and API calls go
  directly from the extension to Anthropic.
