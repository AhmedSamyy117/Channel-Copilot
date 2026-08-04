const EXCLUDE_LOST_KEY = "similarLeadsExcludeLost";
const STAGE_ORDER = ["Territory", "Qualified", "Qualified Sponsor", "Proposition", "Negotiation", "Won", "Lost"];

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function orderedStageNames(breakdown) {
  const keys = Object.keys(breakdown || {});
  keys.sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a);
    const ib = STAGE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return keys;
}

function effectiveCounts(result, excludeLost) {
  if (!result.breakdown) {
    return { total: result.total, breakdownText: "(stage detail unavailable — button count only)" };
  }
  const stages = orderedStageNames(result.breakdown);
  let total = 0;
  const parts = [];
  for (const stage of stages) {
    const s = result.breakdown[stage];
    const count = excludeLost ? s.total - s.lost : s.total;
    if (count <= 0) continue;
    total += count;
    parts.push(`${count} ${stage}`);
  }
  return { total, breakdownText: parts.join(", ") || "none" };
}

async function render() {
  const { similarLeadsResultsSnapshot, [EXCLUDE_LOST_KEY]: excludeLost } = await chrome.storage.local.get([
    "similarLeadsResultsSnapshot",
    EXCLUDE_LOST_KEY,
  ]);
  const toggle = document.getElementById("excludeLostToggle");
  toggle.checked = !!excludeLost;

  const data = similarLeadsResultsSnapshot;
  const contentEl = document.getElementById("content");
  const subtitleEl = document.getElementById("subtitle");

  function draw() {
    const results = (data?.results || [])
      .map((r) => ({ r, eff: effectiveCounts(r, toggle.checked) }))
      .filter(({ eff }) => eff.total > 0)
      .sort((a, b) => b.eff.total - a.eff.total);

    if (!data || !results.length) {
      contentEl.innerHTML = '<div class="empty">No opportunities with similar leads to show.</div>';
      subtitleEl.textContent = data ? `Scanned ${data.results.length} flagged opportunities` : "No scan run yet.";
      return;
    }

    subtitleEl.textContent = `${results.length} opportunities with similar leads · scan from ${new Date(
      data.generatedAt
    ).toLocaleString()}`;

    const rows = results
      .map(
        ({ r, eff }) => `
      <tr>
        <td class="name"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.name)}</a></td>
        <td>${escapeHtml(r.contact)}</td>
        <td>${escapeHtml(r.salesperson)}</td>
        <td class="count">${eff.total}</td>
        <td class="breakdown">${escapeHtml(eff.breakdownText)}</td>
      </tr>`
      )
      .join("");

    contentEl.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Opportunity</th>
            <th>Contact</th>
            <th>Salesperson</th>
            <th>Similar leads</th>
            <th>Stage breakdown</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  toggle.addEventListener("change", async () => {
    await chrome.storage.local.set({ [EXCLUDE_LOST_KEY]: toggle.checked });
    draw();
  });

  draw();
}

render();
