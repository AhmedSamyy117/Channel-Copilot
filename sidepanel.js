const FIELD_LABELS = {
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
const customerNameInput = document.getElementById("customerNameInput");
const customerCountryInput = document.getElementById("customerCountryInput");

let extracted = null;
let activeTabId = null;

function domainFromContactInfo(info) {
  if (!info) return null;
  if (info.website) {
    try {
      const url = new URL(/^https?:\/\//i.test(info.website) ? info.website : `https://${info.website}`);
      return url.hostname.replace(/^www\./i, "");
    } catch (err) {
      // fall through to email
    }
  }
  if (info.email && info.email.includes("@")) {
    return info.email.split("@")[1].trim();
  }
  return null;
}

function fetchPartnerInfoFromTab(tabId, customerName) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "FETCH_PARTNER_INFO", customerName }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(null);
        return;
      }
      resolve(response.info);
    });
  });
}

function updateKycButtonState() {
  kycBtn.disabled = !customerNameInput.value.trim();
}

customerNameInput.addEventListener("input", updateKycButtonState);

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
  activeTabId = tab.id;

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
    customerNameInput.value = extracted.customerName || "";
    customerCountryInput.value = extracted.customerCountry || "";
    statusEl.textContent = extracted.customerName
      ? "Loaded from page — double-check the fields above before researching."
      : "Loaded page, but couldn't find the customer name — please type it in.";
  } catch (err) {
    statusEl.textContent = "";
    showError(err.message);
  } finally {
    updateKycButtonState();
  }
}

kycBtn.addEventListener("click", async () => {
  const customerName = customerNameInput.value.trim();
  if (!customerName) return;

  kycBtn.disabled = true;
  kycBtn.textContent = "Looking up contact record…";
  errorEl.style.display = "none";
  kycResultEl.style.display = "none";

  const partnerInfo = activeTabId ? await fetchPartnerInfoFromTab(activeTabId, customerName) : null;
  const domain = domainFromContactInfo(partnerInfo);

  statusEl.textContent = domain
    ? `Found domain "${domain}" on the contact record — researching by domain.`
    : "No domain on the contact record — researching by company name only.";
  kycBtn.textContent = "Researching…";

  chrome.runtime.sendMessage(
    {
      type: "RUN_KYC",
      payload: {
        customerName,
        country: customerCountryInput.value.trim(),
        domain,
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
