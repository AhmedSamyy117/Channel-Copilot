const FIELD_LABELS = {
  customerName: "Customer",
  customerCountry: "Country (guess)",
  subscriptionCode: "Subscription code",
  recurringPlan: "Recurring plan",
  hosting: "Hosting",
  referrer: "Referrer",
  mrr: "MRR",
};

const statusEl = document.getElementById("status");
const fieldsEl = document.getElementById("fields");
const kycBtn = document.getElementById("kycBtn");
const errorEl = document.getElementById("error");
const kycResultEl = document.getElementById("kycResult");

let extracted = null;

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

function renderFields(data) {
  fieldsEl.innerHTML = "";
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const value = data[key];
    if (!value) continue;
    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
    fieldsEl.appendChild(wrap);
  }
}

async function extractFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");

  if (!/^https?:/.test(tab.url || "")) {
    throw new Error("This isn't a regular web page. Open your Odoo subscription page and reopen the panel.");
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (err) {
    throw new Error("Couldn't access this page. Reopen the panel from the Odoo tab you want to read.");
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_ODOO_DATA" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error("Could not read this page. Reopen the panel from the Odoo subscription page."));
        return;
      }
      if (!response?.ok) {
        reject(new Error("Extraction failed."));
        return;
      }
      resolve(response.data);
    });
  });
}

async function init() {
  try {
    extracted = await extractFromActiveTab();
    renderFields(extracted);
    statusEl.textContent = extracted.customerName
      ? `Loaded data for ${extracted.customerName}`
      : "Loaded page, but no customer field found.";
    kycBtn.disabled = !extracted.customerName;
  } catch (err) {
    statusEl.textContent = "";
    showError(err.message);
  }
}

kycBtn.addEventListener("click", () => {
  if (!extracted?.customerName) return;

  kycBtn.disabled = true;
  kycBtn.textContent = "Researching…";
  errorEl.style.display = "none";
  kycResultEl.style.display = "none";

  chrome.runtime.sendMessage(
    {
      type: "RUN_KYC",
      payload: {
        customerName: extracted.customerName,
        country: extracted.customerCountry,
      },
    },
    (response) => {
      kycBtn.disabled = false;
      kycBtn.textContent = "Research KYC";

      if (chrome.runtime.lastError) {
        showError(chrome.runtime.lastError.message);
        return;
      }
      if (!response?.ok) {
        showError(response?.error || "KYC research failed.");
        return;
      }
      kycResultEl.textContent = response.result;
      kycResultEl.style.display = "block";
    }
  );
});

document.getElementById("optionsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
