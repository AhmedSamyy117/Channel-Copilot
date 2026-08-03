const BASE_URL_KEY = "odooBaseUrl";
const SCAN_STATE_KEY = "subscriptionScanState";
const RESULTS_KEY = "subscriptionScanResults";

const setupBox = document.getElementById("setupBox");
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
const resultsBody = document.getElementById("resultsBody");
const emptyState = document.getElementById("emptyState");
const resultsTable = document.getElementById("resultsTable");

let allResults = [];
let sortKey = "expectedRevenue";
let sortDir = -1;

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

async function ensurePermission(origin) {
  const pattern = `${origin}/*`;
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return true;
  return chrome.permissions.request({ origins: [pattern] });
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
});

changeUrlBtn.addEventListener("click", () => {
  setupBox.style.display = "block";
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

function renderTable() {
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

  rows.sort((a, b) => {
    const va = a[sortKey];
    const vb = b[sortKey];
    if (typeof va === "number" || typeof vb === "number") {
      return ((va || 0) - (vb || 0)) * sortDir;
    }
    return String(va || "").localeCompare(String(vb || "")) * sortDir;
  });

  resultsBody.innerHTML = "";
  resultsTable.style.display = rows.length ? "" : "none";
  emptyState.style.display = rows.length ? "none" : "block";

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.contact)}</td>
      <td>${escapeHtml(r.salesperson)}</td>
      <td>${escapeHtml(r.stage)}</td>
      <td>${fmtCurrency(r.expectedRevenue)}</td>
      <td><a class="opp-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Open in Odoo</a></td>
    `;
    resultsBody.appendChild(tr);
  }

  flaggedCountEl.textContent = `${rows.length} flagged${rows.length !== allResults.length ? ` (of ${allResults.length} total)` : ""}`;
}

document.querySelectorAll("th[data-key]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (sortKey === key) {
      sortDir *= -1;
    } else {
      sortKey = key;
      sortDir = key === "expectedRevenue" ? -1 : 1;
    }
    document.querySelectorAll("th[data-key]").forEach((el) => el.classList.remove("sort-active"));
    th.classList.add("sort-active");
    th.dataset.dir = sortDir === 1 ? "▲" : "▼";
    renderTable();
  });
});

filterInput.addEventListener("input", renderTable);
salespersonFilter.addEventListener("change", renderTable);
stageFilter.addEventListener("change", renderTable);

async function loadResultsFromStorage() {
  const { [RESULTS_KEY]: results, [SCAN_STATE_KEY]: state } = await chrome.storage.local.get([
    RESULTS_KEY,
    SCAN_STATE_KEY,
  ]);
  allResults = results || [];
  populateFilterOptions();
  renderTable();
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
  const baseUrl = await getBaseUrl();
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
  chrome.runtime.sendMessage({ type: "START_SUBSCRIPTION_SCAN", baseUrl });
});

cancelBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_SUBSCRIPTION_SCAN" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[RESULTS_KEY]) {
    allResults = changes[RESULTS_KEY].newValue || [];
    populateFilterOptions();
    renderTable();
  }
  if (changes[SCAN_STATE_KEY]) {
    applyScanState(changes[SCAN_STATE_KEY].newValue);
  }
});

async function init() {
  const baseUrl = await getBaseUrl();
  if (!baseUrl) {
    setupBox.style.display = "block";
  } else {
    baseUrlInput.value = baseUrl;
  }
  await loadResultsFromStorage();
}

init();
