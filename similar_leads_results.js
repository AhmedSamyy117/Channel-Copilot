function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function stageOrderText(breakdown) {
  const STAGE_ORDER = [
    "Territory",
    "Qualified",
    "Qualified Sponsor",
    "Proposition",
    "Negotiation",
    "Won",
    "Lost",
  ];
  const keys = Object.keys(breakdown || {});
  keys.sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a);
    const ib = STAGE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return keys.map((k) => `${breakdown[k]} ${k}`).join(", ");
}

function recordUrl(origin, id) {
  return `${origin}/odoo/crm/${id}`;
}

async function render() {
  const { similarLeadsResults } = await chrome.storage.local.get(["similarLeadsResults"]);
  const contentEl = document.getElementById("content");
  const subtitleEl = document.getElementById("subtitle");

  const data = similarLeadsResults;
  if (!data || !data.results || !data.results.length) {
    contentEl.innerHTML = '<div class="empty">No results to show.</div>';
    return;
  }

  const results = data.results.slice().sort((a, b) => b.total - a.total);
  subtitleEl.textContent = `${results.length} opportunities scanned, ${new Date(
    data.generatedAt
  ).toLocaleString()}`;

  const rows = results
    .map(
      (r) => `
    <tr>
      <td class="name"><a href="${escapeHtml(recordUrl(data.origin, r.id))}" target="_blank" rel="noopener">${escapeHtml(
        r.name
      )}</a></td>
      <td class="count">${r.total}</td>
      <td class="count">${r.totalExcludingLost}</td>
      <td class="breakdown">${escapeHtml(stageOrderText(r.breakdown)) || "none"}</td>
    </tr>`
    )
    .join("");

  contentEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Opportunity</th>
          <th>Similar leads</th>
          <th>Excl. Lost</th>
          <th>Stage breakdown</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

render();
