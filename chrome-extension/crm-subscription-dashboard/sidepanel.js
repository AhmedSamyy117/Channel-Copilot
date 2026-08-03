const BASE_URL_KEY = "odooBaseUrl";
const SCAN_STATE_KEY = "subscriptionScanState";
const RESULTS_KEY = "subscriptionScanResults";
const SCOPE_KEY = "subscriptionScanScope";
const COUNTS_KEY = "subscriptionOppCounts";

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
const scopeSelect = document.getElementById("scopeSelect");
const oppCountLine = document.getElementById("oppCountLine");

let allResults = [];
let detectedOrigin = null;
let latestCounts = null;

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

async function getScope() {
  const { [SCOPE_KEY]: scope } = await chrome.storage.local.get([SCOPE_KEY]);
  return scope || "mine";
}

function fmtCount(n) {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

function renderOppCountLine() {
  if (!latestCounts) {
    oppCountLine.textContent = "Opportunity count: —";
    return;
  }
  const scope = scopeSelect.value;
  const shown = scope === "mine" ? latestCounts.mine : latestCounts.all;
  const other = scope === "mine" ? latestCounts.all : latestCounts.mine;
  const otherLabel = scope === "mine" ? "all opportunities" : "my pipeline";
  oppCountLine.textContent = `${fmtCount(shown)} opportunities in scope (${fmtCount(other)} ${otherLabel})`;
}

// Fetches both "My Pipeline" and "all opportunities" counts up front so the
// total is visible before running a (slow) full scan.
async function refreshOppCounts() {
  const baseUrl = await getBaseUrl();
  if (!baseUrl) return;
  oppCountLine.textContent = "Opportunity count: loading…";
  chrome.runtime.sendMessage({ type: "GET_OPP_COUNTS", baseUrl }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      oppCountLine.textContent = "Opportunity count: couldn't fetch.";
      return;
    }
    latestCounts = response.counts;
    renderOppCountLine();
  });
}

async function ensurePermission(origin) {
  const pattern = `${origin}/*`;
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

// Reads the origin of whatever tab is active when the panel opens, so the
// user doesn't have to type their Odoo URL by hand — they're expected to
// already be on (or near) the CRM in that tab.
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
  refreshOppCounts();
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
  refreshOppCounts();
});

scopeSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ [SCOPE_KEY]: scopeSelect.value });
  renderOppCountLine();
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

function populateFilterOptions() {
  const salespeople = [...new Set(allResults.map((r) => r.salesperson).filter(Boolean))].sort();
  const stages = [...new Set(allResults.map((r) => r.stage).filter(Boolean))].sort();

  const prevSp = salespersonFilter.value;
  salespersonFilter.innerHTML = '<option value="">All salespeople</option>';
  for (const sp of salespeople) {
    const opt = document.createElement("option");
    opt.value = sp;
    opt.textContent = sp;
    salespersonFilter.appendChild(opt);
  }
  salespersonFilter.value = salespeople.includes(prevSp) ? prevSp : "";

  const prevStage = stageFilter.value;
  stageFilter.innerHTML = '<option value="">All stages</option>';
  for (const st of stages) {
    const opt = document.createElement("option");
    opt.value = st;
    opt.textContent = st;
    stageFilter.appendChild(opt);
  }
  stageFilter.value = stages.includes(prevStage) ? prevStage : "";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
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

  rows.sort((a, b) => (b.expectedRevenue || 0) - (a.expectedRevenue || 0));

  resultsList.innerHTML = "";
  emptyState.style.display = rows.length ? "none" : "block";

  for (const r of rows) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="name">${escapeHtml(r.name)}</div>
      <div class="meta">${escapeHtml(r.contact)}${r.salesperson ? " · " + escapeHtml(r.salesperson) : ""}${r.stage ? " · " + escapeHtml(r.stage) : ""}</div>
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
  const running = state.status === "listing" || state.status === "scanning";
  scanBtn.disabled = running;
  cancelBtn.style.display = running ? "inline-block" : "none";

  if (state.status === "listing") {
    progressTextEl.textContent = `Fetching opportunity list… ${state.total} found so far`;
    progressFillEl.style.width = "0%";
  } else if (state.status === "scanning") {
    progressTextEl.textContent = `Checked ${state.checked} / ${state.total} · ${state.flagged} flagged so far`;
    progressFillEl.style.width = `${state.total ? (state.checked / state.total) * 100 : 0}%`;
  } else if (state.status === "done" || state.status === "cancelled") {
    progressTextEl.textContent =
      state.status === "cancelled" ? `Scan cancelled at ${state.checked} / ${state.total}` : "";
    progressFillEl.style.width = state.status === "done" ? "100%" : `${(state.checked / state.total) * 100}%`;
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
  chrome.runtime.sendMessage({ type: "START_SUBSCRIPTION_SCAN", baseUrl, scope: scopeSelect.value });
});

cancelBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_SUBSCRIPTION_SCAN" });
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
  if (changes[COUNTS_KEY]) {
    latestCounts = changes[COUNTS_KEY].newValue || null;
    renderOppCountLine();
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
  scopeSelect.value = await getScope();

  if (!savedBaseUrl) {
    setupBox.style.display = "block";
    baseUrlInput.value = detectedOrigin || "";
    await showDetectedHintIfUseful();
  } else {
    refreshOppCounts();
  }

  await loadResultsFromStorage();
}

init();
