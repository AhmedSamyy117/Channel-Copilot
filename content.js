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

function findValueForLabel(labelText) {
  const candidates = Array.from(document.querySelectorAll("label, .o_form_label"));
  for (const el of candidates) {
    if (normalize(el.textContent).replace(/\?$/, "") !== labelText) continue;

    // Walk up to the row container, then find the value widget within it.
    const row = el.closest(".o_row, .o_field_widget, tr, div") || el.parentElement;
    if (!row) continue;

    const valueEl =
      row.querySelector(".o_field_widget:not(.o_form_label)") ||
      el.nextElementSibling;

    if (valueEl && valueEl !== el) {
      const text = normalize(valueEl.textContent);
      if (text) return text;
    }
  }
  return null;
}

function extractCustomerBlock() {
  const value = findValueForLabel("Customer");
  if (!value) return { name: null, address: null, country: null };

  // The customer widget typically renders name + multi-line address together.
  const lines = value.split(/(?=[A-Z][a-z]+,|\d{4,})/).map((l) => l.trim());
  const name = lines[0] || value;

  // Best-effort country guess: last comma-free line, or last line overall.
  const country = lines.length > 1 ? lines[lines.length - 1] : null;

  return { name, address: value, country };
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

function extractAll() {
  const customer = extractCustomerBlock();
  return {
    customerName: customer.name,
    customerAddress: customer.address,
    customerCountry: customer.country,
    subscriptionCode: extractSubscriptionCode(),
    orderDate: findValueForLabel("Order Date"),
    recurringPlan: findValueForLabel("Recurring Plan"),
    nextInvoice: findValueForLabel("Next Invoice"),
    pricelist: findValueForLabel("Pricelist"),
    paymentTerms: findValueForLabel("Payment Terms"),
    referrer: findValueForLabel("Referrer"),
    hosting: findValueForLabel("Hosting"),
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
