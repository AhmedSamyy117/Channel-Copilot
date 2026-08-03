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
3. Click the extension icon to open the dashboard tab.

## Setup

Make sure you're already logged into your Odoo instance in this browser
(this extension doesn't handle login/credentials at all). On first use,
enter your Odoo base URL (e.g. `https://yourcompany.odoo.com`) in the
dashboard's setup box and click "Save & grant access" — Chrome will prompt
you to approve access for that site only.

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

## Dashboard

- Sortable by any column, filterable by salesperson, stage, or a text
  search over name/contact.
- "Last refreshed" timestamp and a "Run scan" button — re-run any time to
  refresh. "Cancel" stops a scan in progress.
- Results persist in `chrome.storage.local`, so reopening the dashboard
  shows the last completed scan immediately without waiting.

## Notes / limitations

- Login/2FA is entirely out of scope: the extension assumes you're already
  signed into Odoo in this browser and rides your existing session cookie.
- The banner text-match assumes the phrasing stays roughly stable — if
  Odoo renders it differently in some locale/version, a record could be
  under-flagged (missed) rather than false-flagged.
- Because this brute-forces one hidden tab per opportunity, it's slower
  than a true RPC-based check would be — accepted tradeoff since no such
  RPC/field shortcut was found.
