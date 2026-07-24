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
const domainRow = document.getElementById("domainRow");
const domainValueEl = document.getElementById("domainValue");
const sourceHintEl = document.getElementById("sourceHint");

let extracted = null;
let activeTabId = null;
let detectedDomain = null;

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

function fetchCustomerRecordFromTab(tabId, fallbackName) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "FETCH_CUSTOMER_RECORD", fallbackName }, (response) => {
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
    // Prefill from page-scraping first (best-effort), then try to overwrite
    // with the authoritative record from Odoo's own API below.
    customerNameInput.value = extracted.customerName || "";
    customerCountryInput.value = extracted.customerCountry || "";
    statusEl.textContent = "Loaded from page — looking up the contact record for authoritative details…";

    const record = activeTabId
      ? await fetchCustomerRecordFromTab(activeTabId, extracted.customerName)
      : null;

    if (record) {
      if (record.name) customerNameInput.value = record.name;
      if (record.country) customerCountryInput.value = record.country;
      detectedDomain = domainFromContactInfo(record);
      if (detectedDomain) {
        domainRow.style.display = "block";
        domainValueEl.textContent = detectedDomain;
      }
      sourceHintEl.textContent = "Name/country pulled from the Odoo contact record — still editable if wrong.";
      statusEl.textContent = detectedDomain
        ? `Loaded. Will research by domain "${detectedDomain}".`
        : "Loaded. No email/website on the contact record — will research by name only.";
    } else {
      sourceHintEl.textContent = "Couldn't reach the contact record — these are page-scraped guesses. Check/fix before researching.";
      statusEl.textContent = extracted.customerName
        ? "Loaded from page (best-effort) — double-check the fields above."
        : "Loaded page, but couldn't find the customer name — please type it in.";
    }
  } catch (err) {
    statusEl.textContent = "";
    showError(err.message);
  } finally {
    updateKycButtonState();
  }
}

kycBtn.addEventListener("click", () => {
  const customerName = customerNameInput.value.trim();
  if (!customerName) return;

  kycBtn.disabled = true;
  kycBtn.textContent = "Researching…";
  errorEl.style.display = "none";
  kycResultEl.style.display = "none";

  chrome.runtime.sendMessage(
    {
      type: "RUN_KYC",
      payload: {
        customerName,
        country: customerCountryInput.value.trim(),
        domain: detectedDomain,
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
