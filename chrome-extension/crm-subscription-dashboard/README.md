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
   (`chrome.tabs.create({active: false})`). The banner itself is often
   computed by Odoo via a second, async lookup (checking the partner's
   subscriptions) that can finish well after the rest of the form has
   rendered — and since Chrome throttles timers in hidden/background
   tabs, that lookup can take noticeably longer than in a normal
   foreground tab. Rather than reading the page once after a fixed delay
   (which was missing real banners that hadn't rendered yet), it polls
   repeatedly, checking specifically the rendered yellow alert box
   (`[role="alert"]` / `[class*="alert"]`, with the full page text as a
   fallback) against the banner's known phrasing ("running or a churned
   subscription"), and stops early once the page's content stops changing
   between checks (a proxy for "whatever was loading has settled") so
   records with no banner don't pay the full polling window. Tabs are
   opened one at a time with a delay between each to avoid hammering the
   instance — a full scan across 600+ opportunities takes roughly
   20–30+ minutes.

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
    differently: rather than reconstructing the search domain (calling
    Odoo, or reading its internal state), it reads the record IDs directly
    off whatever is already rendered on screen — the exact rows (list
    view) or cards (kanban view) you're looking at — and pages through
    the pager to collect every ID if there's more than one page. Nothing
    on the page changes (no view switching, no filter clicks) beyond
    paging forward and back to where you started if there's more than one
    page.
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
- **"This view's filters" scope depends on having observed a network
  request from that tab**: there's no public Odoo API for "give me the
  search bar's current domain," so instead of calling Odoo directly, the
  extension watches for the JSON-RPC request Odoo's own client already
  sends to load the list/kanban data and reads the domain out of that
  request body. This rides Odoo's actual wire protocol (stable across
  versions) rather than internal JS structure. If it hasn't seen a
  matching request yet, it auto-nudges one by toggling the view switcher
  (Kanban ↔ List) and back — filters are untouched — then checks again;
  if that still comes up empty (e.g. the CRM tab only has one view type
  available, or the toggle didn't fire in time), you'll see "Haven't seen
  this page's search query yet," and manually clicking a filter or
  switching pages once should resolve it. The "My Pipeline" and "All
  opportunities" scopes don't have this requirement since they call
  Odoo's RPC endpoint directly themselves.
