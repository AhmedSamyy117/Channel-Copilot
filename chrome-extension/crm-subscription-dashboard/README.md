# CRM Subscription Flags

Standalone Chrome extension that scans the whole Odoo CRM Opportunities/
Pipeline and lists only the opportunities whose form view shows Odoo's
native "This customer has already a running or a churned subscription,
check them here" banner — so you don't have to click into 600+
opportunities one at a time.

## Load the extension

1. `chrome://extensions` → enable Developer mode.
2. "Load unpacked" → select this folder
   (`chrome-extension/crm-subscription-dashboard`).
3. Open your Odoo CRM in a tab, then click the extension icon — it opens in
   the browser's side panel, docked next to the page you're on.

## Setup

Make sure you're already logged into your Odoo instance in this browser
(this extension doesn't handle login/credentials at all). The first time
you open the side panel, it detects the Odoo site from whichever tab is
active and offers to use it directly — click "Save & grant access" to
approve (Chrome will prompt for that site only). If you opened the panel
from a different tab, you can still type the URL manually.

## How it works

Investigated first, per the brief, whether a faster path than opening
every record existed:
- No dedicated RPC method backing the subscription banner was found.
- No filterable boolean field exposing the running/churned-subscription
  relationship was found on `crm.lead`.

So the scan works in two parts:

1. **Bulk list, fast**: fetches every `crm.lead` record of type
   `opportunity` via Odoo's own JSON-RPC endpoint
   (`/web/dataset/call_kw`, `search_read`, paged by offset/limit). This
   naturally covers all 600+ records without relying on the list view's
   "40 per page" UI pagination at all.
2. **Banner check, brute force**: since no shortcut was found, each
   opportunity's form view is opened in a hidden background tab
   (`chrome.tabs.create({active: false})`), given time to render, and the
   page text is matched against the banner's known phrasing ("running or a
   churned subscription"). Tabs are opened one at a time with a delay
   between each to avoid hammering the instance — a full scan across 600+
   opportunities takes roughly 15–20+ minutes.

Only flagged opportunities are kept: name, contact/company, salesperson,
stage, expected revenue, and a link back to the record in Odoo. Handles
Arabic-language names/company text fine since matching happens only on the
banner's English phrasing — displayed names pass through untouched.

## Side panel

- **Scope selector**, three options:
  - "My Pipeline" (default) — mirrors Odoo's own "My Pipeline" search-bar
    filter (opportunities assigned to the current user), via a stable RPC
    call (`user_id = <current uid>`).
  - "All opportunities" — entire CRM, no filter, via the same stable RPC.
  - "This view's filters" — matches *whatever* filters/facets you've
    actually applied on the CRM tab (e.g. "Assigned Partner = X", "Stage
    not = Won", combined with My Pipeline or not). This one works
    differently: it reads the live search domain straight out of Odoo's
    own web client state on that tab (see caveat below), so switching to
    it re-reads the domain fresh each time — including right before a scan
    starts, in case you changed filters since the count was last shown.
  Below the selector, an opportunity count for the current scope is
  fetched immediately (`search_count` for the first two scopes; live
  domain read + `search_count` for "This view's filters") so you see the
  total before running the slower per-record scan.
- Filterable by salesperson, stage, or a text search over name/contact;
  sorted by expected revenue, highest first.
- "Last refreshed" timestamp and a "Run scan" button — re-run any time to
  refresh. "Cancel" stops a scan in progress.
- Results persist in `chrome.storage.local`, so reopening the panel shows
  the last completed scan immediately without waiting.

## Notes / limitations

- Login/2FA is entirely out of scope: the extension assumes you're already
  signed into Odoo in this browser and rides your existing session cookie.
- The banner text-match assumes the phrasing stays roughly stable — if
  Odoo renders it differently in some locale/version, a record could be
  under-flagged (missed) rather than false-flagged.
- Because this brute-forces one hidden tab per opportunity, it's slower
  than a true RPC-based check would be — accepted tradeoff since no such
  RPC/field shortcut was found.
- A transient Chrome error ("Tabs cannot be edited right now — user may be
  dragging a tab") is retried automatically a couple of times; a single
  record failing to check no longer aborts the whole scan.
- **"This view's filters" scope is inherently fragile**: there's no public
  Odoo API for "give me the search bar's current domain," so it reaches
  into the web client's internal OWL component state (the same trick Odoo
  developers use from the browser console) to read `searchModel.domain`.
  This is undocumented internal structure, not a stable interface — a
  future Odoo upgrade could change it and break this one scope (it would
  show an error like "Couldn't read this page's filters" rather than
  silently returning wrong data). The "My Pipeline" and "All opportunities"
  scopes are unaffected since they only use stable, public RPC calls.
