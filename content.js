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

// Looks up the customer's contact record through Odoo's own backend API
// (same-origin JSON-RPC, reuses the logged-in session) rather than scraping
// the page — this is the authoritative source for name/country/email/site,
// since page text scraping has proven unreliable across Odoo layouts.
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

// Odoo 17+ uses URLs like /odoo/<action>/<id>; older web clients use
// hash routing like #id=123&model=sale.order&view_type=form.
function getRecordContext() {
  const pathMatch = location.pathname.match(/\/(\d+)(?:[/?]|$)/);
  if (pathMatch) return { id: parseInt(pathMatch[1], 10), model: null };

  const hash = location.hash || "";
  const idMatch = hash.match(/[#&]id=(\d+)/);
  if (idMatch) {
    const modelMatch = hash.match(/[#&]model=([a-zA-Z_.]+)/);
    return { id: parseInt(idMatch[1], 10), model: modelMatch ? modelMatch[1] : null };
  }
  return null;
}

// The Subscriptions app has lived on different models across Odoo versions.
const ORDER_MODEL_CANDIDATES = ["sale.order", "sale.subscription"];

async function fetchOrderPartnerRef(ctx) {
  const models = ctx.model ? [ctx.model] : ORDER_MODEL_CANDIDATES;
  for (const model of models) {
    const rows = await odooRpc(
      model,
      "search_read",
      [[["id", "=", ctx.id]], ["name", "partner_id", "note"]],
      { limit: 1 }
    );
    if (rows && rows.length && rows[0].partner_id) return { ...rows[0], model };
  }
  return null;
}

function stripHtml(html) {
  if (!html) return "";
  return normalize(html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
}

// Point-of-contact candidates: individual contacts under the company record.
async function fetchPartnerContacts(partnerId) {
  const rows = await odooRpc(
    "res.partner",
    "search_read",
    [[["parent_id", "=", partnerId]], ["name", "function", "email", "phone", "mobile"]],
    { limit: 10 }
  );
  return rows || [];
}

// All opportunities tied to this customer, most recent first, so we can
// look at the won one plus any others for extra context (as instructed).
async function fetchOpportunities(partnerId) {
  const rows = await odooRpc(
    "crm.lead",
    "search_read",
    [[["partner_id", "=", partnerId]], ["name", "stage_id", "description", "expected_revenue"]],
    { limit: 20, order: "create_date desc" }
  );
  return (rows || []).map((r) => ({
    name: r.name || "",
    stage: Array.isArray(r.stage_id) ? r.stage_id[1] : "",
    won: Array.isArray(r.stage_id) && /won/i.test(r.stage_id[1] || ""),
    description: stripHtml(r.description),
  }));
}

// Recent chatter/log messages on the order itself — sales reps often note
// context (current system, requirements, etc.) here rather than in a
// dedicated field.
async function fetchChatterMessages(model, recordId) {
  const rows = await odooRpc(
    "mail.message",
    "search_read",
    [
      [
        ["res_id", "=", recordId],
        ["model", "=", model],
      ],
      ["body", "author_id"],
    ],
    { limit: 20, order: "date desc" }
  );
  return (rows || [])
    .map((r) => stripHtml(r.body))
    .filter(Boolean)
    .slice(0, 20);
}

function buildInternalContextText({ opportunities, notes, chatter }) {
  const parts = [];
  if (notes) parts.push(`ORDER NOTES:\n${notes}`);
  if (opportunities && opportunities.length) {
    parts.push(
      "OPPORTUNITIES (most recent first; WON marks the one that became this order):\n" +
        opportunities
          .map(
            (o, i) =>
              `${i + 1}. "${o.name}" [stage: ${o.stage}${o.won ? ", WON" : ""}]\n${o.description || "(no description)"}`
          )
          .join("\n\n")
    );
  }
  if (chatter && chatter.length) {
    parts.push("CHATTER LOG (most recent first):\n" + chatter.map((c, i) => `${i + 1}. ${c}`).join("\n"));
  }
  return parts.join("\n\n---\n\n");
}

async function fetchPartnerDetails(partnerId) {
  const rows = await odooRpc(
    "res.partner",
    "search_read",
    [[["id", "=", partnerId]], ["name", "email", "website", "country_id"]],
    { limit: 1 }
  );
  return rows && rows[0] ? rows[0] : null;
}

// Falls back to a name-based lookup only if we couldn't resolve the current
// record's id (e.g. an unrecognized URL scheme).
async function fetchPartnerByName(customerName) {
  const rows = await odooRpc(
    "res.partner",
    "search_read",
    [[["name", "=", customerName]], ["name", "email", "website", "country_id"]],
    { limit: 1 }
  );
  return rows && rows[0] ? rows[0] : null;
}

async function fetchCustomerRecordInfo(fallbackName) {
  const ctx = getRecordContext();
  let partner = null;
  let orderRef = null;

  if (ctx) {
    orderRef = await fetchOrderPartnerRef(ctx);
    if (orderRef && orderRef.partner_id) {
      partner = await fetchPartnerDetails(orderRef.partner_id[0]);
    }
  }

  if (!partner && fallbackName) {
    partner = await fetchPartnerByName(fallbackName);
  }

  if (!partner) return null;

  const partnerId = orderRef && orderRef.partner_id ? orderRef.partner_id[0] : partner.id || null;

  const [contacts, opportunities, chatter] = await Promise.all([
    partnerId ? fetchPartnerContacts(partnerId) : [],
    partnerId ? fetchOpportunities(partnerId) : [],
    ctx && orderRef ? fetchChatterMessages(orderRef.model, ctx.id) : [],
  ]);

  const contextText = buildInternalContextText({
    opportunities,
    notes: stripHtml(orderRef && orderRef.note),
    chatter,
  });

  return {
    name: partner.name || null,
    email: partner.email || null,
    website: partner.website || null,
    country: Array.isArray(partner.country_id) ? partner.country_id[1] : null,
    contacts,
    contextText,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EXTRACT_ODOO_DATA") {
    sendResponse({ ok: true, data: extractAll() });
    return true;
  }
  if (message?.type === "FETCH_CUSTOMER_RECORD") {
    fetchCustomerRecordInfo(message.fallbackName).then((info) => {
      sendResponse({ ok: true, info });
    });
    return true; // async response
  }
  return false;
});

} // window.__channelCopilotInjected guard
