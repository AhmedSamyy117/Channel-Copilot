// Extracts key fields from an Odoo subscription form page. Injected on
// demand via chrome.scripting (see sidepanel.js) rather than declared as a
// static content script, since Odoo is usually self-hosted on a customer's
// own domain rather than odoo.com.
//
// Odoo's web client renders each field as a labeled row: a label element
// (class o_form_label, or a <label>) followed by a value element
// (class o_field_widget) within the same o_row/o_cell container. We match
// on label text rather than fixed selectors since Odoo studio customizations
// can change field order.

if (!window.__channelCopilotInjected) {
window.__channelCopilotInjected = true;

const LABELS = [
  "Customer",
  "Order Date",
  "Recurring Plan",
  "Next Invoice",
  "Pricelist",
  "Payment Terms",
  "Referrer",
  "Hosting",
];

function normalize(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function textOf(el) {
  return el ? normalize(el.textContent) : "";
}

// Odoo forms can render a label/value pair several different ways depending
// on version and layout (label[for]+id, table cells, or sibling divs in a
// two-column o_group). Try each in order and take the first non-empty hit
// that isn't just the label repeated.
function findValueForLabel(labelText) {
  const candidates = Array.from(document.querySelectorAll("label, .o_form_label"));
  for (const el of candidates) {
    if (normalize(el.textContent).replace(/\?$/, "") !== labelText) continue;

    const forId = el.getAttribute && el.getAttribute("for");
    if (forId) {
      const text = textOf(document.getElementById(forId));
      if (text) return text;
    }

    const td = el.closest("td");
    if (td) {
      let sib = td.nextElementSibling;
      while (sib) {
        const text = textOf(sib);
        if (text) return text;
        sib = sib.nextElementSibling;
      }
    }

    let sib = el.nextElementSibling;
    while (sib) {
      const text = textOf(sib);
      if (text && text !== labelText) return text;
      sib = sib.nextElementSibling;
    }

    const parent = el.parentElement;
    if (parent) {
      let psib = parent.nextElementSibling;
      while (psib) {
        const text = textOf(psib);
        if (text && text !== labelText) return text;
        psib = psib.nextElementSibling;
      }
    }
  }
  return null;
}

// Last-resort fallback: scan the page's rendered text line by line, find a
// line that is exactly a known label, and take the following non-empty
// lines as its value (stopping at the next known label). Works regardless
// of how the label/value pair is actually structured in the DOM.
function findRawLinesForLabel(labelText, maxLines) {
  const rawLines = (document.body.innerText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const idx = rawLines.findIndex((l) => l.replace(/\?$/, "") === labelText);
  if (idx === -1) return null;

  const collected = [];
  for (let i = idx + 1; i < rawLines.length && collected.length < (maxLines || 1); i++) {
    const line = rawLines[i];
    if (LABELS.includes(line.replace(/\?$/, ""))) break;
    collected.push(line);
  }
  return collected.length ? collected : null;
}

function findValueByTextScan(labelText, maxLines) {
  const lines = findRawLinesForLabel(labelText, maxLines);
  return lines ? lines.join(", ") : null;
}

function extractCustomerBlock() {
  const domValue = findValueForLabel("Customer");
  if (domValue) {
    // The customer widget typically renders name + multi-line address together
    // as one blob once whitespace is collapsed.
    const lines = domValue.split(/(?=[A-Z][a-z]+,|\d{4,})/).map((l) => l.trim());
    const name = lines[0] || domValue;
    const country = lines.length > 1 ? lines[lines.length - 1] : null;
    return { name, address: domValue, country };
  }

  const rawLines = findRawLinesForLabel("Customer", 6);
  if (rawLines && rawLines.length) {
    // Prefer the last purely-alphabetic line as the country guess (skips
    // trailing phone numbers / postal codes that also lack a comma).
    const alphaLines = rawLines.slice(1).filter((l) => /^[A-Za-z\s'-]+$/.test(l));
    return {
      name: rawLines[0],
      address: rawLines.join(", "),
      country: alphaLines.length ? alphaLines[alphaLines.length - 1] : null,
    };
  }

  return { name: null, address: null, country: null };
}

function extractSubscriptionCode() {
  const heading = document.querySelector("h1, .o_form_sheet h1, .breadcrumb-item.active");
  const text = normalize(heading ? heading.textContent : "");
  const match = text.match(/[A-Z]\d{6,}/);
  return match ? match[0] : null;
}

function extractMRR() {
  const el = Array.from(document.querySelectorAll("button, .o_stat_info")).find((e) =>
    /MRR/i.test(e.textContent)
  );
  if (!el) return null;
  const text = normalize(el.textContent);
  const match = text.match(/US\$\s?[\d,.]+/);
  return match ? match[0] : text || null;
}

function findField(labelText) {
  return findValueForLabel(labelText) || findValueByTextScan(labelText, 1);
}

function extractAll() {
  const customer = extractCustomerBlock();
  return {
    customerName: customer.name,
    customerAddress: customer.address,
    customerCountry: customer.country,
    subscriptionCode: extractSubscriptionCode(),
    orderDate: findField("Order Date"),
    recurringPlan: findField("Recurring Plan"),
    nextInvoice: findField("Next Invoice"),
    pricelist: findField("Pricelist"),
    paymentTerms: findField("Payment Terms"),
    referrer: findField("Referrer"),
    hosting: findField("Hosting"),
    mrr: extractMRR(),
    pageUrl: location.href,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EXTRACT_ODOO_DATA") {
    sendResponse({ ok: true, data: extractAll() });
  }
  return true;
});

} // window.__channelCopilotInjected guard
