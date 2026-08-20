const BASE_URL_KEY = "odooBaseUrl";
const SCAN_STATE_KEY = "staleScanState";
const RESULTS_KEY = "staleScanResults";
const COUNT_KEY = "staleOppCount";

const setupBox = document.getElementById("setupBox");
const detectedHint = document.getElementById("detectedHint");
const baseUrlInput = document.getElementById("baseUrlInput");
const saveBaseUrlBtn = document.getElementById("saveBaseUrlBtn");
const changeUrlBtn = document.getElementById("changeUrlBtn");
const scanBtn = document.getElementById("scanBtn");
const cancelBtn = document.getElementById("cancelBtn");
const errorBanner = document.getElementById("errorBanner");
const lastRefreshedEl = document.getElementById("lastRefreshed");
const progressTextEl = document.getElementById("progressText");
const progressFillEl = document.getElementById("progressFill");
const flaggedCountEl = document.getElementById("flaggedCount");
const filterInput = document.getElementById("filterInput");
const salespersonFilter = document.getElementById("salespersonFilter");
const stageFilter = document.getElementById("stageFilter");
const resultsList = document.getElementById("resultsList");
const emptyState = document.getElementById("emptyState");
const oppCountLine = document.getElementById("oppCountLine");
const filterHint = document.getElementById("filterHint");
const exportCsvBtn = document.getElementById("exportCsvBtn");

let allResults = [];
let detectedOrigin = null;
let pageCountState = null; // { status: "loading" | "ok" | "error", count?, error? }

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.style.display = msg ? "block" : "none";
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value.trim());
    return `${url.protocol}//${url.host}`;
  } catch (err) {
    return null;
  }
}

async function getBaseUrl() {
  const { [BASE_URL_KEY]: baseUrl } = await chrome.storage.local.get([BASE_URL_KEY]);
  return baseUrl || null;
}

function fmtCount(n) {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

async function getActiveCrmTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id || null;
}

function renderOppCountLine() {
  if (!pageCountState) {
    oppCountLine.textContent = "Opportunities in this view: —";
  } else if (pageCountState.status === "loading") {
    oppCountLine.textContent = "Opportunities in this view: reading this page's filters…";
  } else if (pageCountState.status === "error") {
    oppCountLine.textContent = pageCountState.error;
  } else {
    oppCountLine.textContent = `${fmtCount(pageCountState.count)} open-pipeline opportunities match this view's current filters (Lost/Won already excluded)`;
  }
}

// Reads the live search domain off the actual CRM tab (whatever
// filters/facets are currently applied there) — always re-fetched, never
// cached, since the whole point is to match what's on screen right now.
async function refreshPageCount() {
  const baseUrl = await getBaseUrl();
  if (!baseUrl) return;
  const tabId = await getActiveCrmTabId();
  pageCountState = { status: "loading" };
  renderOppCountLine();
  chrome.runtime.sendMessage({ type: "GET_PAGE_COUNT", baseUrl, tabId }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      pageCountState = { status: "error", error: response?.error || "Couldn't read this page's filters." };
    } else {
      pageCountState = { status: "ok", count: response.count };
    }
    renderOppCountLine();
  });
}

async function ensurePermission(origin) {
  const pattern = `${origin}/*`;
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

async function detectActiveTabOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) return null;
  try {
    const url = new URL(tab.url);
    return `${url.protocol}//${url.host}`;
  } catch (err) {
    return null;
  }
}

async function useDetectedOrigin() {
  if (!detectedOrigin) return;
  const granted = await ensurePermission(detectedOrigin);
  if (!granted) {
    showError("Access to this site is required to scan its CRM.");
    return;
  }
  await chrome.storage.local.set({ [BASE_URL_KEY]: detectedOrigin });
  showError("");
  setupBox.style.display = "none";
  refreshPageCount();
}

saveBaseUrlBtn.addEventListener("click", async () => {
  const normalized = normalizeBaseUrl(baseUrlInput.value);
  if (!normalized) {
    showError("Enter a valid URL, e.g. https://yourcompany.odoo.com");
    return;
  }
  const granted = await ensurePermission(normalized);
  if (!granted) {
    showError("Access was not granted — the scan needs permission for this site to read the CRM.");
    return;
  }
  await chrome.storage.local.set({ [BASE_URL_KEY]: normalized });
  showError("");
  setupBox.style.display = "none";
  refreshPageCount();
});

changeUrlBtn.addEventListener("click", async () => {
  setupBox.style.display = "block";
  const baseUrl = await getBaseUrl();
  baseUrlInput.value = baseUrl || detectedOrigin || "";
  await showDetectedHintIfUseful();
});

function fmtCurrency(n) {
  const num = Number(n) || 0;
  return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtTimestamp(ms) {
  if (!ms) return "Never run yet.";
  return `Last refreshed: ${new Date(ms).toLocaleString()}`;
}

function fmtLastUpdate(ms) {
  if (!ms) return "Unknown";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function populateFilterOptions() {
  const salespeople = [...new Set(allResults.map((r) => r.salesperson).filter(Boolean))].sort();
  const stages = [...new Set(allResults.map((r) => r.stage).filter(Boolean))].sort();

  const prevSp = salespersonFilter.value;
  salespersonFilter.innerHTML = '<option value="">All salespeople (in results)</option>';
  for (const sp of salespeople) {
    const opt = document.createElement("option");
    opt.value = sp;
    opt.textContent = sp;
    salespersonFilter.appendChild(opt);
  }
  salespersonFilter.value = salespeople.includes(prevSp) ? prevSp : "";

  const prevStage = stageFilter.value;
  stageFilter.innerHTML = '<option value="">All stages (in results)</option>';
  for (const st of stages) {
    const opt = document.createElement("option");
    opt.value = st;
    opt.textContent = st;
    stageFilter.appendChild(opt);
  }
  stageFilter.value = stages.includes(prevStage) ? prevStage : "";

  filterHint.style.display = allResults.length === 0 ? "block" : "none";
  exportCsvBtn.style.display = allResults.length === 0 ? "none" : "inline-block";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function escapeCsvField(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Exports every flagged opportunity (not just what's currently filtered in
// the panel) — the full takeaway from a scan, not a view of what's on screen.
function exportResultsToCsv() {
  const header = ["Opportunity", "Contact/Company", "Salesperson", "Stage", "Expected Revenue", "Last Update", "Days Since Last Update", "Link"];
  const rows = allResults.map((r) => [
    r.name,
    r.contact,
    r.salesperson,
    r.stage,
    r.expectedRevenue,
    fmtLastUpdate(r.lastUpdateMs),
    r.daysSince,
    r.url,
  ]);
  const csv = [header, ...rows].map((row) => row.map(escapeCsvField).join(",")).join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `crm-stale-opportunities-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

exportCsvBtn.addEventListener("click", exportResultsToCsv);

function staleSeverityClass(days) {
  if (days >= 90) return "critical";
  if (days >= 60) return "warn";
  return "";
}

function renderList() {
  const term = filterInput.value.trim().toLowerCase();
  const spFilter = salespersonFilter.value;
  const stFilter = stageFilter.value;

  let rows = allResults.filter((r) => {
    if (spFilter && r.salesperson !== spFilter) return false;
    if (stFilter && r.stage !== stFilter) return false;
    if (term) {
      const haystack = `${r.name} ${r.contact}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });

  // Stalest first, as required.
  rows.sort((a, b) => b.daysSince - a.daysSince);

  resultsList.innerHTML = "";
  emptyState.style.display = rows.length ? "none" : "block";

  for (const r of rows) {
    const card = document.createElement("div");
    card.className = "card";
    const severity = staleSeverityClass(r.daysSince);
    card.innerHTML = `
      <div class="name">${escapeHtml(r.name)}</div>
      <div class="meta">${escapeHtml(r.contact)}${r.salesperson ? " · " + escapeHtml(r.salesperson) : ""}${r.stage ? " · " + escapeHtml(r.stage) : ""}</div>
      <div class="stale-line${severity ? " " + severity : ""}">${r.daysSince} days since last update (${fmtLastUpdate(r.lastUpdateMs)})</div>
      <div class="revenue">${fmtCurrency(r.expectedRevenue)}</div>
      <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Open in Odoo →</a>
    `;
    resultsList.appendChild(card);
  }

  flaggedCountEl.textContent = `${rows.length} flagged${rows.length !== allResults.length ? ` (of ${allResults.length} total)` : ""}`;
}

filterInput.addEventListener("input", renderList);
salespersonFilter.addEventListener("change", renderList);
stageFilter.addEventListener("change", renderList);

async function loadResultsFromStorage() {
  const { [RESULTS_KEY]: results, [SCAN_STATE_KEY]: state } = await chrome.storage.local.get([
    RESULTS_KEY,
    SCAN_STATE_KEY,
  ]);
  allResults = results || [];
  populateFilterOptions();
  renderList();
  applyScanState(state);
}

function applyScanState(state) {
  if (!state) {
    lastRefreshedEl.textContent = "Never run yet.";
    return;
  }

  if (state.status === "error") {
    showError(`Scan failed: ${state.error}`);
    scanBtn.disabled = false;
    cancelBtn.style.display = "none";
    progressTextEl.textContent = "";
    progressFillEl.style.width = "0%";
    return;
  }

  showError("");
  const running = state.status === "listing" || state.status === "dates";
  scanBtn.disabled = running;
  cancelBtn.style.display = running ? "inline-block" : "none";

  if (state.status === "listing") {
    progressTextEl.textContent = `Fetching opportunities in this view… ${state.total} found so far`;
    progressFillEl.style.width = "0%";
  } else if (state.status === "dates") {
    progressTextEl.textContent = `Reading last-activity dates… ${state.checked} / ${state.total} opportunities`;
    progressFillEl.style.width = `${state.total ? (state.checked / state.total) * 100 : 0}%`;
  } else if (state.status === "done" || state.status === "cancelled") {
    progressTextEl.textContent =
      state.status === "cancelled" ? `Scan cancelled at ${state.checked} / ${state.total}` : "";
    progressFillEl.style.width = state.status === "done" ? "100%" : `${state.total ? (state.checked / state.total) * 100 : 0}%`;
    lastRefreshedEl.textContent = fmtTimestamp(state.finishedAt);
  }
}

scanBtn.addEventListener("click", async () => {
  let baseUrl = await getBaseUrl();
  if (!baseUrl && detectedOrigin) {
    await useDetectedOrigin();
    baseUrl = await getBaseUrl();
  }
  if (!baseUrl) {
    setupBox.style.display = "block";
    showError("Set your Odoo base URL first.");
    return;
  }
  const granted = await ensurePermission(baseUrl);
  if (!granted) {
    showError("Access to the CRM site is required to scan opportunities.");
    return;
  }
  showError("");
  scanBtn.disabled = true;
  cancelBtn.style.display = "inline-block";
  const tabId = await getActiveCrmTabId();
  // A callback is required: without one, a background-service-worker
  // hiccup (asleep, still starting up, or a genuine error) fails silently
  // and the button stays disabled with no feedback.
  chrome.runtime.sendMessage({ type: "START_STALE_SCAN", baseUrl, tabId }, () => {
    if (chrome.runtime.lastError) {
      showError(`Couldn't start the scan: ${chrome.runtime.lastError.message}. Try again in a moment.`);
      scanBtn.disabled = false;
      cancelBtn.style.display = "none";
    }
  });
});

cancelBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_STALE_SCAN" }, () => {
    if (chrome.runtime.lastError) {
      showError(`Couldn't cancel: ${chrome.runtime.lastError.message}.`);
    }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[RESULTS_KEY]) {
    allResults = changes[RESULTS_KEY].newValue || [];
    populateFilterOptions();
    renderList();
  }
  if (changes[SCAN_STATE_KEY]) {
    applyScanState(changes[SCAN_STATE_KEY].newValue);
  }
});

async function showDetectedHintIfUseful() {
  if (detectedOrigin) {
    detectedHint.textContent = `Detected from your current tab: ${detectedOrigin}`;
    detectedHint.style.display = "block";
  } else {
    detectedHint.style.display = "none";
  }
}

async function init() {
  detectedOrigin = await detectActiveTabOrigin();
  const savedBaseUrl = await getBaseUrl();

  if (!savedBaseUrl) {
    setupBox.style.display = "block";
    baseUrlInput.value = detectedOrigin || "";
    await showDetectedHintIfUseful();
  } else {
    refreshPageCount();
  }

  await loadResultsFromStorage();
}

init();
