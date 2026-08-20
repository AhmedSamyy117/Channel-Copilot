# CRM Stale Opportunities

Standalone Chrome extension that scans whatever Odoo CRM list view/filter
you currently have open (Opportunities, a saved filter, a single stage, a
salesperson's list — whatever's on screen) and lists the open-pipeline
opportunities that have had no update or logged activity in 30+ days, so
you don't have to open 600+ chatter panels one at a time.

## Load the extension

1. `chrome://extensions` → enable Developer mode.
2. "Load unpacked" → select this folder
   (`chrome-extension/crm-stale-opportunities`).
3. Open your Odoo CRM in a tab, on the exact list view/filter you want to
   scan, then click the extension icon — it opens in the browser's side
   panel, docked next to the page you're on.

## Setup

Make sure you're already logged into your Odoo instance in this browser
(this extension doesn't handle login/credentials at all). The first time
you open the side panel, it detects the Odoo site from whichever tab is
active and offers to use it directly — click "Save & grant access" to
approve (Chrome will prompt for that site only). If you opened the panel
from a different tab, you can still type the URL manually.

## How it works

Investigated first, per the brief, whether a faster path than opening
every record's chatter existed:

- No native "Last Updated"/"Last Interaction" sortable column, and no
  built-in "Inactive"/"Unattended" filter, was found exposed on the CRM
  list view for this instance.
- But the chatter panel itself is backed by ordinary `mail.message`
  records (`model = "crm.lead"`, `res_id = <opportunity id>`), and Odoo's
  ORM supports aggregate `read_group` calls. That means the **last message
  date for every opportunity in scope can be pulled with a handful of
  aggregated RPC calls** (`read_group` with a `date:max` aggregate, grouped
  by `res_id`, chunked by opportunity IDs) — no per-record page loads at
  all, unlike the subscription-flag tool, which found no such shortcut and
  had to brute-force a page load per record.

So the scan works in two RPC-only steps, no page loads:

1. **Bulk list**: fetches every `crm.lead` in the domain built from the
   current tab's search filters (see below), paged by offset/limit via
   `search_read` — this naturally covers all matching records regardless
   of the list view's own "40 per page" UI pagination.
2. **Bulk last-activity lookup**: `mail.message.read_group()` with a
   `date:max` aggregate grouped by `res_id`, scoped to those opportunity
   IDs (chunked, so an `IN` clause never gets too large). This is combined
   with each opportunity's own `write_date` (the later of the two wins),
   since a stage drag or field edit doesn't always generate a chatter
   message — deliberately **not** `create_date`, since staleness is about
   time since last activity/edit, not opportunity age.

Any opportunity where `now − last_update > 30 days` is flagged: name,
contact/company, salesperson, stage, expected revenue, last update date,
and days since last update. Handles Arabic-language names/company text
fine since nothing is parsed or matched against it — displayed names pass
through untouched, and staleness is computed purely from RPC dates.

## Side panel

- **Scope**: always "this view's filters" — matches *whatever*
  filters/facets you've actually applied on the CRM tab (stage, assigned
  salesperson, saved filter, etc.). It observes the network request
  Odoo's own web client already makes to load that list (a JSON-RPC POST
  to `/web/dataset/call_kw` for `crm.lead`) and reads the domain straight
  out of that request's body — the exact domain that produced what's on
  your screen. If nothing's been observed yet (e.g. right after the
  extension reloaded), it nudges the page itself (focuses the search bar,
  presses Enter) to get a fresh request to read, the same way the
  subscription-flag dashboard does.
- **Lost and Won are always excluded**, no toggle — layered on top of
  whatever's on screen as `active = true` and `stage_id.is_won = false`,
  never used to widen scope beyond the current view/filter otherwise. A
  closed deal going quiet for 30+ days is expected, not "stale."
- An opportunity count for the current view is fetched before running the
  scan, so you see the total up front.
- **Results filters** (name/contact text, salesperson, stage) narrow the
  flagged list a completed scan produced — populated from scan results, so
  they show "(in results)" and stay empty until a scan actually flags
  something. Results are sorted **stalest first** (most days since update).
- "Last refreshed" timestamp and a "Run scan" button — re-run any time to
  get a fresh result, since which opportunities count as stale changes
  every day. "Cancel" stops a scan in progress.
- **"Export CSV"** (appears once a scan has flagged anything) downloads
  every flagged opportunity — name, contact/company, salesperson, stage,
  expected revenue, last update date, days since last update, and a link
  back to the record — independent of the results filters above.
- Results persist in `chrome.storage.local`, so reopening the panel shows
  the last completed scan immediately without waiting.

## Notes / limitations

- Login/2FA is entirely out of scope: the extension assumes you're already
  signed into Odoo in this browser and rides your existing session cookie.
- "Last update" combines `write_date` (last DB write on the record) and
  the max `mail.message.date` for that record. An opportunity with neither
  signal (should not normally happen) is skipped rather than false-flagged
  as infinitely stale.
- **Scope always follows the tab's current filters**: there's no public
  Odoo API for "give me the search bar's current domain," so instead of
  calling Odoo directly, the extension watches for the JSON-RPC request
  Odoo's own client sends to load the list/kanban data and reads the
  domain out of that request body. A CRM page fires more than one
  `crm.lead` request (KPI tiles, activity counters, etc.), so only
  `web_search_read` calls are considered, and among those, whichever asked
  for the most fields (the real view request asks for every visible
  column; a summary widget asks for a handful).
- Small delays are added between paginated RPC batches (listing and
  last-activity lookups alike) to avoid hammering the instance, even
  though this scan is RPC-only and much faster than a per-record brute
  force would be.
- A scan across 600+ opportunities should complete in well under a minute,
  since it's a handful of aggregated RPC calls rather than one page load
  per record.
