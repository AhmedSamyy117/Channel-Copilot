// Surfaces Odoo's own "Similar Leads" duplicate-matching, in-context, on the
// opportunity page and (batch) on the CRM list view. We do not reimplement
// duplicate matching: crm.lead's server action `action_similar_leads` is
// what Odoo's smart button calls, and it returns an ir.actions.act_window
// whose `domain` already encodes whatever Odoo matched on (email/phone/
// partner overlap). We call that same server method once to get the domain,
// then do a single search_read with it — no clicking through records.
//
// Declared as a broad-match content script (see manifest.json) since this
// needs to appear automatically as you land on an opportunity, unlike the
// on-demand side panel tool. It no-ops instantly on any page that isn't an
// Odoo crm.lead form/list view.

if (!window.__channelCopilotSimilarLeadsInjected) {
window.__channelCopilotSimilarLeadsInjected = true;

const STAGE_ORDER = [
  "Territory",
  "Qualified",
  "Qualified Sponsor",
  "Proposition",
  "Negotiation",
  "Won",
  "Lost",
];

function normalize(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

async function odooRpc(model, method, args, kwargs) {
  try {
    const res = await fetch(`${location.origin}/web/dataset/call_kw`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { model, method, args, kwargs: kwargs || {} },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error) return null;
    return json.result;
  } catch (err) {
    return null;
  }
}

function getFormRecordId() {
  const pathMatch = location.pathname.match(/\/(\d+)(?:[/?]|$)/);
  if (pathMatch) return parseInt(pathMatch[1], 10);
  const hash = location.hash || "";
  const idMatch = hash.match(/[#&]id=(\d+)/);
  if (idMatch && /model=crm\.lead/.test(hash)) return parseInt(idMatch[1], 10);
  return null;
}

function findSimilarLeadsButton() {
  const buttons = Array.from(document.querySelectorAll("button.oe_stat_button, .oe_stat_button"));
  return (
    buttons.find((b) => (b.getAttribute("name") || "").includes("similar_leads")) ||
    buttons.find((b) => /similar/i.test(b.textContent || ""))
  );
}

function parseButtonCount(button) {
  const valueEl = button.querySelector(".o_stat_value");
  const text = normalize(valueEl ? valueEl.textContent : button.textContent);
  const match = text.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

// Fetches the exact domain Odoo's own similar-leads action uses for this
// record, then paginates search_read over it (handles 20+ results even
// though a single opportunity's count is normally small).
async function fetchSimilarLeads(leadId) {
  const action = await odooRpc("crm.lead", "action_similar_leads", [[leadId]], {});
  const domain = action && action.domain ? action.domain : null;
  if (!domain) return null;

  const PAGE_SIZE = 80;
  let offset = 0;
  const all = [];
  for (;;) {
    const rows = await odooRpc(
      "crm.lead",
      "search_read",
      [domain, ["name", "stage_id", "active", "probability"]],
      { limit: PAGE_SIZE, offset, context: { active_test: false } }
    );
    if (!rows || !rows.length) break;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

function isLost(row) {
  const stageName = Array.isArray(row.stage_id) ? row.stage_id[1] : "";
  return row.active === false || /lost/i.test(stageName || "");
}

function summarize(rows) {
  const breakdown = {};
  for (const row of rows) {
    const stageName = (Array.isArray(row.stage_id) ? row.stage_id[1] : "") || "Unknown";
    breakdown[stageName] = (breakdown[stageName] || 0) + 1;
  }
  return breakdown;
}

function orderedStages(breakdown) {
  const keys = Object.keys(breakdown);
  keys.sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a);
    const ib = STAGE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return keys;
}

function breakdownText(rows) {
  const breakdown = summarize(rows);
  const parts = orderedStages(breakdown).map((stage) => `${breakdown[stage]} ${stage}`);
  return parts.join(", ") || "none";
}

async function getExcludeLostSetting() {
  const { similarLeadsExcludeLost } = await chrome.storage.local.get(["similarLeadsExcludeLost"]);
  return !!similarLeadsExcludeLost;
}

async function setExcludeLostSetting(value) {
  await chrome.storage.local.set({ similarLeadsExcludeLost: value });
}

// ---- Inline panel on the opportunity form ----

function buildPanel() {
  const panel = document.createElement("div");
  panel.id = "cc-similar-leads-panel";
  panel.style.cssText =
    "margin:8px 0;padding:8px 12px;border:1px solid #d8dadd;border-radius:6px;" +
    "background:#f8f9fa;font-size:13px;line-height:1.5;max-width:520px;";
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <strong id="cc-sl-total">Similar leads: …</strong>
      <label style="display:flex;align-items:center;gap:4px;font-weight:normal;cursor:pointer;">
        <input type="checkbox" id="cc-sl-exclude-lost" />
        Exclude Lost
      </label>
    </div>
    <div id="cc-sl-breakdown" style="margin-top:4px;color:#555;">Loading…</div>
  `;
  return panel;
}

async function renderPanel(panel, rows) {
  const excludeLost = await getExcludeLostSetting();
  panel.querySelector("#cc-sl-exclude-lost").checked = excludeLost;

  const filtered = excludeLost ? rows.filter((r) => !isLost(r)) : rows;
  const totalEl = panel.querySelector("#cc-sl-total");
  const breakdownEl = panel.querySelector("#cc-sl-breakdown");

  totalEl.textContent = excludeLost
    ? `${filtered.length} similar leads (Lost excluded)`
    : `${filtered.length} similar leads`;
  breakdownEl.textContent = filtered.length ? breakdownText(filtered) : "No similar leads found.";
}

async function injectOpportunityPanel() {
  const button = findSimilarLeadsButton();
  if (!button) return;

  const count = parseButtonCount(button);
  if (!count) return; // 0 or unreadable — nothing to surface

  const leadId = getFormRecordId();
  if (!leadId) return;

  const buttonBox = button.closest(".oe_button_box") || button.parentElement;
  if (!buttonBox || !buttonBox.parentElement) return;
  if (document.getElementById("cc-similar-leads-panel")) return;

  const panel = buildPanel();
  buttonBox.parentElement.insertBefore(panel, buttonBox.nextSibling);

  const rows = await fetchSimilarLeads(leadId);
  if (rows === null) {
    panel.querySelector("#cc-sl-breakdown").textContent =
      "Couldn't load similar-leads detail (server call failed).";
    panel.querySelector("#cc-sl-total").textContent = `Similar leads: ${count} (from button)`;
    return;
  }

  await renderPanel(panel, rows);

  panel.querySelector("#cc-sl-exclude-lost").addEventListener("change", async (e) => {
    await setExcludeLostSetting(e.target.checked);
    renderPanel(panel, rows);
  });
}

// ---- Batch scan of the visible CRM list view ----

function getVisibleListLeadIds() {
  const ids = new Set();
  document.querySelectorAll(".o_data_row[data-id], .o_kanban_record[data-id]").forEach((el) => {
    const raw = el.getAttribute("data-id");
    const num = parseInt(raw, 10);
    if (Number.isFinite(num)) ids.add(num);
  });
  return Array.from(ids);
}

function isCrmListView() {
  return !!document.querySelector(".o_crm_lead_view, .o_list_view, .o_kanban_view");
}

async function scanVisibleList(button, statusEl) {
  const ids = getVisibleListLeadIds();
  if (!ids.length) {
    statusEl.textContent = "No leads/opportunities visible in this list.";
    return;
  }

  button.disabled = true;
  const results = [];
  for (let i = 0; i < ids.length; i++) {
    statusEl.textContent = `Checking ${i + 1}/${ids.length}…`;
    const leadId = ids[i];
    const rows = await fetchSimilarLeads(leadId);
    if (rows === null) continue;
    const nameRow = await odooRpc("crm.lead", "read", [[leadId], ["name"]]);
    const name = nameRow && nameRow[0] ? nameRow[0].name : `#${leadId}`;
    results.push({
      id: leadId,
      name,
      total: rows.length,
      totalExcludingLost: rows.filter((r) => !isLost(r)).length,
      breakdown: summarize(rows),
    });
  }
  button.disabled = false;
  statusEl.textContent = "";

  chrome.runtime.sendMessage({ type: "OPEN_SIMILAR_LEADS_RESULTS", results, origin: location.origin });
}

function injectListToolbarButton() {
  if (document.getElementById("cc-similar-leads-scan-btn")) return;
  const toolbar =
    document.querySelector(".o_cp_top_right, .o_control_panel .o_cp_bottom_right, .o_control_panel");
  if (!toolbar) return;

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:8px;margin-left:8px;";
  wrap.innerHTML = `
    <button id="cc-similar-leads-scan-btn" class="btn btn-secondary" type="button">
      Check Similar Leads (visible)
    </button>
    <span id="cc-similar-leads-scan-status" style="font-size:12px;color:#555;"></span>
  `;
  toolbar.appendChild(wrap);

  const btn = wrap.querySelector("#cc-similar-leads-scan-btn");
  const status = wrap.querySelector("#cc-similar-leads-scan-status");
  btn.addEventListener("click", () => scanVisibleList(btn, status));
}

function isCrmLeadFormPage() {
  return !!findSimilarLeadsButton();
}

let lastRun = 0;
function tryRun() {
  const now = Date.now();
  if (now - lastRun < 300) return;
  lastRun = now;

  if (isCrmLeadFormPage()) injectOpportunityPanel();
  else if (isCrmListView() && getVisibleListLeadIds().length) injectListToolbarButton();
}

// Odoo is a single-page app; re-check on DOM mutations (page/view changes)
// rather than only on initial load.
const observer = new MutationObserver(() => tryRun());
observer.observe(document.body, { childList: true, subtree: true });
tryRun();

} // window.__channelCopilotSimilarLeadsInjected guard
