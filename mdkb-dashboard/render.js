import { statCard, esc, formatBytes, relativeTime, BADGE_BY_TYPE } from "./format.js";
import { buildPage } from "./page.js";

// HTML rendering of the dashboard sections.

// Exported for unit testing — the plugin loader only reads `.default`, so this
// named export is inert at runtime (same pattern as build-cleaner).
export function renderDashboard(data, repoPath, opts = {}) {
  const { stats, memories, config, error } = data;
  const repoName = repoPath.split("/").pop();

  if (error && !stats) {
    return buildPage(repoName, null, `
      <div class="dash-section">
        <div class="empty-state">
          <h2>mdkb not available</h2>
          <p>${esc(error)}</p>
          <p class="hint">Make sure <code>mdkb</code> is installed and the project was initialized with <code>mdkb init</code>.</p>
        </div>
      </div>
    `);
  }

  const sections = [];
  const header = stats?.header || {};

  // --- Doctor (`stats.doctor`, absent from older mdkb) ---
  // First, because a finding is something to act on. Read from `stats`, not
  // `mdkb doctor`: execCli drops stdout on a non-zero exit, and doctor exits
  // non-zero exactly when it has an error to show.
  if (stats?.doctor?.length) {
    const SEVERITY_BADGE = { error: "badge-error", warning: "badge-warn", info: "badge-muted" };
    const rows = stats.doctor.map((f) =>
      `<tr>
        <td><span class="badge ${SEVERITY_BADGE[f.severity] || "badge-muted"}">${esc(f.severity)}</span></td>
        <td><code>${esc(f.id)}</code></td>
        <td>${esc(f.message)}</td>
        <td>${f.fix ? `<code>${esc(f.fix)}</code>` : ""}</td>
      </tr>`
    ).join("");
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Doctor <span class="dash-section-hint">mdkb doctor --full for the live distiller probe</span></h2>
        <table>
          <thead><tr><th>Severity</th><th>Check</th><th>Finding</th><th>Fix</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }

  // --- Overview (index) ---
  if (stats?.index) {
    const idx = stats.index;
    const collCount = stats.collections?.collections?.length ?? 0;
    const fragPct = Math.round((idx.free_page_ratio || 0) * 100);
    const fragExtra = fragPct >= 20
      ? `<div class="dash-stat-sub warn">${fragPct}% free pages — Compact to reclaim</div>`
      : `<div class="dash-stat-sub">${fragPct}% free pages</div>`;
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">
          Index
          <span class="dash-section-hint">Updated ${relativeTime(header.last_updated)}</span>
        </h2>
        <div class="dash-stat-grid">
          ${statCard(idx.document_count ?? "—", "Documents")}
          ${statCard(idx.memory_count ?? "—", "Memories")}
          ${statCard(collCount, "Collections")}
          ${statCard(formatBytes(header.db_size_bytes), "DB Size", fragExtra)}
        </div>
      </div>
    `);
  }

  // --- Collections ---
  const collections = stats?.collections?.collections || [];
  if (collections.length > 0) {
    const rows = collections.map((c) => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td><code>${esc(c.path)}</code></td>
        <td><code>${esc(c.pattern)}</code></td>
        <td class="num">${c.doc_count ?? 0}</td>
      </tr>
    `).join("");
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Collections</h2>
        <table>
          <thead><tr><th>Name</th><th>Path</th><th>Pattern</th><th class="num">Docs</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }

  // --- Memory health + entries ---
  if (stats?.memory) {
    const m = stats.memory;
    const byType = m.counts_by_type || {};
    const typeBadges = Object.keys(byType).sort((a, b) => byType[b] - byType[a]).map((t) =>
      `<span class="badge ${BADGE_BY_TYPE[t] || "badge-muted"}">${esc(t)} ${byType[t]}</span>`
    ).join(" ");
    const remind = m.reminders_due > 0
      ? `<span class="badge badge-warn">${m.reminders_due} due</span>` : "";
    const remindUp = m.reminders_upcoming_7d > 0
      ? `<span class="badge badge-muted">${m.reminders_upcoming_7d} upcoming 7d</span>` : "";
    const pending = m.pending_embeddings > 0
      ? `<span class="badge badge-warn">${m.pending_embeddings} pending embeddings</span>` : "";

    const memRows = (memories || []).slice(0, 30).map((mem) => {
      const badgeClass = BADGE_BY_TYPE[mem.entry_type] || "badge-muted";
      const tags = (mem.tags || []).map((t) => `<span class="badge badge-muted">${esc(t)}</span>`).join(" ");
      return `
        <tr>
          <td><code>${esc(mem.id)}</code></td>
          <td>${esc(mem.title)}</td>
          <td><span class="badge ${badgeClass}">${esc(mem.entry_type)}</span></td>
          <td class="num">${mem.access_count || 0}</td>
          <td>${tags}</td>
        </tr>`;
    }).join("");

    const memTable = (memories && memories.length > 0) ? `
      <table>
        <thead><tr><th>ID</th><th>Title</th><th>Type</th><th class="num">Hits</th><th>Tags</th></tr></thead>
        <tbody>${memRows}</tbody>
      </table>` : `<div class="empty-state">No memory entries yet.</div>`;

    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">
          Memory
          <span class="dash-section-hint">${m.active_count ?? 0} active${memories && memories.length > 30 ? " · showing 30" : ""}</span>
        </h2>
        <div class="badge-row">${typeBadges} ${remind} ${remindUp} ${pending}</div>
        ${memTable}
      </div>
    `);
  }

  // --- Code index ---
  if (stats?.code) {
    const c = stats.code;
    const langRows = (c.languages || []).map((l) =>
      `<tr><td>${esc(l.language)}</td><td class="num">${l.files}</td><td class="num">${l.symbols}</td></tr>`
    ).join("");
    const kindBadges = (c.symbols_by_kind || []).slice(0, 8).map((k) =>
      `<span class="badge badge-muted">${esc(k.kind)} ${k.count}</span>`
    ).join(" ");
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">
          Code Index
          <span class="dash-section-hint">Indexed ${relativeTime(c.last_indexed)}</span>
        </h2>
        <div class="dash-stat-grid">
          ${statCard(c.files ?? "—", "Files")}
          ${statCard(c.symbols ?? "—", "Symbols")}
          ${statCard(c.relations ?? "—", "Relations")}
        </div>
        ${kindBadges ? `<div class="badge-row">${kindBadges}</div>` : ""}
        ${langRows ? `<table>
          <thead><tr><th>Language</th><th class="num">Files</th><th class="num">Symbols</th></tr></thead>
          <tbody>${langRows}</tbody>
        </table>` : ""}
      </div>
    `);
  }

  // --- Session usage ---
  if (stats?.sessions) {
    const s = stats.sessions;
    const toolRows = (s.top_tools || []).slice(0, 8).map((t) =>
      `<tr><td><code>${esc(t.tool_name)}</code></td><td class="num">${t.call_count}</td></tr>`
    ).join("");
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Session Usage</h2>
        <div class="dash-stat-grid">
          ${statCard(s.total_sessions ?? 0, "Sessions")}
          ${statCard(s.total_calls ?? 0, "Tool Calls")}
        </div>
        ${toolRows ? `<table>
          <thead><tr><th>Tool</th><th class="num">Calls</th></tr></thead>
          <tbody>${toolRows}</tbody>
        </table>` : ""}
      </div>
    `);
  }

  // --- Hook health ---
  if (stats?.hooks?.telemetry_enabled === false) {
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Hooks</h2>
        <div class="empty-state">
          <p>Hook telemetry is off</p>
          <p class="hint">Hook activity and timing metrics are not collected. This does not mean hooks are inactive.</p>
        </div>
      </div>
    `);
  } else if (stats?.hooks?.telemetry_enabled === true && !stats.hooks.events?.length) {
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Hooks</h2>
        <div class="empty-state"><p>No hook activity recorded</p></div>
      </div>
    `);
  } else if (stats?.hooks?.events?.length) {
    const h = stats.hooks;
    const rows = h.events.map((e) =>
      `<tr>
        <td><code>${esc(e.event)}</code></td>
        <td class="num">${e.invocations}</td>
        <td class="num">${e.fired}</td>
        <td class="num">${e.avg_ms}</td>
        <td class="num">${e.p95_ms}</td>
      </tr>`
    ).join("");
    const mining = h.mining
      ? `<span class="badge ${h.mining.enabled ? "badge-success" : "badge-muted"}">mining ${h.mining.enabled ? "on" : "off"}${h.mining.reason ? " · " + esc(h.mining.reason) : ""}</span>`
      : "";
    const slow = h.slow_events_7d > 0 ? `<span class="badge badge-warn">${h.slow_events_7d} slow (7d)</span>` : "";
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Hooks</h2>
        <div class="badge-row">${mining} ${slow}</div>
        <table>
          <thead><tr><th>Event</th><th class="num">Calls</th><th class="num">Fired</th><th class="num">Avg ms</th><th class="num">p95 ms</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }

  // --- Recall ledger (`stats.recall`, absent from older mdkb) ---
  const recall = stats?.recall;
  if (recall && Object.keys(recall.prompts_by_mode || {}).length) {
    const modes = Object.entries(recall.prompts_by_mode)
      .map(([mode, n]) => `<span class="badge badge-muted">${esc(mode)} ${n}</span>`)
      .join(" ");
    const labelled = recall.insufficient_data
      ? `<span class="badge badge-warn">${recall.labelled} labelled — insufficient data</span>`
      : `<span class="badge badge-success">${recall.labelled} labelled</span>`;
    const bandRows = (bands, holdout) => bands.map((b) =>
      `<tr>
        <td><code>${esc(b.band)}</code>${holdout ? ' <span class="badge badge-muted">holdout</span>' : ""}</td>
        <td>${esc(b.entry_type)}</td>
        <td class="num">${b.offered}</td>
        <td class="num">${b.injected}</td>
        <td class="num">${b.labelled}</td>
        <td class="num">${b.positive}</td>
        <td class="num">${b.negative}</td>
        <td class="num">${b.missed}</td>
        <td class="num">${b.precision == null ? "–" : Math.round(b.precision * 100) + "%"}</td>
      </tr>`
    ).join("");
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">Recall <span class="dash-section-hint">candidates offered per cosine band</span></h2>
        <div class="badge-row">${modes} ${labelled}</div>
        <table>
          <thead><tr><th>Band</th><th>Type</th><th class="num">Offered</th><th class="num">Injected</th><th class="num">Labelled</th><th class="num">+</th><th class="num">−</th><th class="num">Missed</th><th class="num">Precision</th></tr></thead>
          <tbody>${bandRows(recall.bands || [], false)}${bandRows(recall.holdout || [], true)}</tbody>
        </table>
      </div>
    `);
  }

  // --- Config ---
  if (config) {
    sections.push(`
      <div class="dash-section">
        <h2 class="dash-section-title">
          Configuration
          <span class="dash-section-hint">.mdkb/config.toml</span>
        </h2>
        <pre class="config-block">${esc(config)}</pre>
      </div>
    `);
  }

  return buildPage(repoName, header.version, sections.join("\n"), opts);
}

