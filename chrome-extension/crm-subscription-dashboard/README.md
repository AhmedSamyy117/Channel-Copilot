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
   opportunity's form view is opened and checked for the banner, same as a
   human would. This runs in a separate, unfocused browser window created
   once for the whole scan (not a hidden background tab in your own
   window) — its tab is navigated to each record in turn and reused. That
   window's tab is the *active* tab within its own window, so it reports
   as visible to Odoo's page JS even though the window itself never steals
   your focus; a genuinely hidden background tab was found to prevent the
   banner's async subscription lookup from running at all in some cases,
   flagging nothing even for opportunities known to have the banner. Once
   the tab finishes loading a record, it polls repeatedly — checking
   specifically the rendered yellow alert box (`[role="alert"]` /
   `[class*="alert"]`, with the full page text as a fallback) against the
   banner's known phrasing ("running or a churned subscription") — and
   stops early once the page's content stops changing between checks (a
   proxy for "whatever was loading has settled") so records with no
   banner don't pay the full polling window. A full scan across 600+
   opportunities takes roughly 20–30+ minutes.

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
    differently: it observes the network request Odoo's own web client
    already made to load that list (a JSON-RPC POST to
    `/web/dataset/call_kw` for `crm.lead`) and reads the domain straight
    out of that request's body — the exact domain that produced what's on
    your screen. That observation only catches requests made *after* the
    listener starts, so a tab that's been sitting untouched (e.g. right
    after the extension reloaded) has nothing to observe yet — rather than
    asking you to click something first, the extension nudges it itself:
    it focuses the search bar and presses Enter, which makes Odoo reissue
    the exact same query with the exact same filters (nothing visibly
    changes beyond a brief cursor blink in the search box), giving itself
    a fresh request to read.
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
- Because this brute-forces one page load per opportunity in a scan
  window, it's slower than a true RPC-based check would be — accepted
  tradeoff since no such RPC/field shortcut was found.
- A transient Chrome error ("Tabs cannot be edited right now — user may be
  dragging a tab") is retried automatically a couple of times; a single
  record failing to check no longer aborts the whole scan.
- **"This view's filters" scope reads the domain from a network request
  Odoo's own client already sends**: there's no public Odoo API for "give
  me the search bar's current domain," so instead of calling Odoo
  directly, the extension watches for the JSON-RPC request Odoo's own
  client sends to load the list/kanban data and reads the domain out of
  that request body. This rides Odoo's actual wire protocol (stable
  across versions) rather than internal JS structure or DOM markup. A CRM
  page fires more than one `crm.lead` request though (KPI tiles, activity
  counters, etc. query it too), so only `web_search_read` calls are
  considered (the one the list/kanban renderer itself makes), and among
  those, whichever asked for the most fields — the real view requests
  every visible column, a summary widget only asks for a handful — to
  avoid locking onto the wrong one. If no such request has been observed
  yet (e.g. the tab was already open before the extension reloaded), the
  extension nudges one itself — focusing the search bar and pressing
  Enter, which makes Odoo reissue the same query with the same filters —
  rather than requiring you to click something first; this happens
  automatically the first time "This view's filters" is used against a
  tab. The "My Pipeline" and "All opportunities" scopes don't have this
  requirement since they call Odoo's RPC endpoint directly themselves.
