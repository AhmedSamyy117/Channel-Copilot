# CRM Similar Leads Checker

Standalone Chrome extension that scans the Odoo CRM Opportunities/Pipeline
and reports, for each opportunity, how many similar/duplicate leads Odoo's
own "Similar Leads" smart button has already matched — with a per-stage
breakdown — so you don't have to open the smart button on 600+ opportunities
one at a time.

## Load the extension

1. `chrome://extensions` → enable Developer mode.
2. "Load unpacked" → select this folder
   (`chrome-extension/crm-similar-leads-checker`).
3. Open your Odoo CRM in a tab, then click the extension icon — it opens in
   the browser's side panel, docked next to the page you're on.

## Setup

Make sure you're already logged into your Odoo instance in this browser.
The first time you open the side panel, it detects the Odoo site from the
active tab and offers "Save & grant access" (Chrome will prompt for that
site only). You can also type the URL manually.

## How it works

We walked the actual UI on a real duplicate ("ACE Company's Opportunity",
5 similar leads) before writing any scan logic, per the brief. What we
found: clicking "Similar Leads" navigates to a client-side kanban action
(grouped by pipeline stage — Territory / Qualified / Qualified Sponsor /
Proposition / Negotiation / Won), not a discrete, inspectable RPC response —
so there's no single JSON payload to just read and parse. A lost match isn't
a separate stage either; it shows up as a ribboned card inside whatever
stage it was in when marked lost.

So, same conclusion (and same fix) as the CRM Subscription Flags tool
reached for its banner check: no shortcut RPC/field exists, so this
brute-forces it, reusing that tool's proven approach:

1. **Bulk list, fast**: fetches every `crm.lead` opportunity via Odoo's own
   JSON-RPC endpoint (`/web/dataset/call_kw`, `search_read`, paged by
   offset/limit) — covers everything in scope regardless of the list
   view's on-screen pagination.
2. **Similar-leads check, brute force**: each opportunity's form is opened
   in a separate, unfocused browser window (created once for the whole
   scan, reused per record — same reasoning as the subscription tool: a
   tab that's the *active* tab of its own unfocused window still reports
   as visible to Odoo's page JS, unlike a genuinely hidden background tab,
   which was found to silently break async lookups). For each record:
   - Read the "Similar Leads N" smart-button count. `0` → skip immediately,
     no click needed.
   - Otherwise click it, wait for the kanban view to render (polls,
     stopping early once the page's text stops changing between checks —
     the same settle trick used for the subscription banner, so records
     with few matches don't pay a fixed delay), then read the stage
     breakdown straight off the kanban columns and per-card "Lost" ribbons.

A full scan across hundreds of opportunities will take a while (same
ballpark as the subscription-flag scan) — accepted tradeoff since no faster
RPC shortcut was found. Handles Arabic-language opportunity/contact names
fine (only actual UI counts/labels are parsed; names pass through
untouched), and pages beyond a single kanban view's initial batch by
reading whatever Odoo renders as it loads more (poll-and-settle covers
this the same way it covers initial render).

## Side panel

- **Scope selector**: "My Pipeline" (default, mirrors Odoo's own filter),
  "All opportunities", or "This view's filters" (matches whatever
  filters/facets are applied on the CRM tab right now — read from the
  actual network request Odoo's client sends to load that list, same
  mechanism as CRM Subscription Flags).
- **Exclude Lost toggle**: persistent (stored in `chrome.storage.local`,
  remembered across sessions and opportunities). Since each card's lost
  status is recorded individually during the scan, toggling this
  recalculates totals/breakdowns instantly — no rescan needed.
- Filterable by salesperson, stage, or a text search; results sorted by
  similar-leads count, highest first.
- **"Open full results in a window"** — pops the same result set out into
  a dedicated browser tab as a full table (own Exclude Lost toggle, link
  back to each opportunity), for sharing or a bigger view than the docked
  panel.
- Results persist in `chrome.storage.local`, so reopening the panel shows
  the last completed scan immediately.

## Notes / limitations

- Assumes you're already signed into Odoo in this browser.
- The stage breakdown depends on the kanban view's rendered DOM structure
  (`.o_kanban_group` / `.o_kanban_record` / a ribbon element for Lost) — if
  a heavily customized Odoo instance renders this differently, a record
  could show a raw count with no breakdown rather than a wrong one (the
  scan surfaces "stage detail unavailable" instead of guessing).
- Same transient-tab-error retry and per-record failure isolation as CRM
  Subscription Flags: one record failing to check doesn't abort the scan.
