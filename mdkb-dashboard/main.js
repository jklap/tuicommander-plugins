/**
 * mdkb Dashboard Plugin
 *
 * Displays the mdkb knowledge base index, collections, memories, code index,
 * session usage, and hook health for the active repository in an interactive
 * HTML panel, and exposes one-click maintenance actions (reindex, code rebuild,
 * re-embed, compact).
 *
 * All data comes from a single `mdkb --format json stats` call plus
 * `mdkb --format json memory list`. The old `status` CLI subcommand was removed
 * upstream (mdkb ≥ 3.x) — `stats` now carries index + collections + code +
 * sessions + hooks. Field paths mirror `src/cli/stats_report.rs` in the mdkb
 * repo; keep them in sync if that struct changes.
 *
 * Capabilities required:
 *   - exec:cli     (run `mdkb --format json <cmd>`, incl. mutating update/embed/compact)
 *   - fs:read      (read .mdkb/config.toml)
 *   - ui:panel     (render HTML dashboard)
 *   - ui:ticker    (show compact status in status bar)
 *
 * The source is split by responsibility: constants.js, data.js (CLI fetch),
 * format.js (helpers), render.js (sections), page.js (shell) and this file
 * (state, ticker, actions, lifecycle).
 */

import { ACTIONS, DB_ICON } from "./constants.js";
import { fetchMdkbData } from "./data.js";
import { buildPage } from "./page.js";
import { renderDashboard } from "./render.js";
import { esc } from "./format.js";

// Exported for unit testing — the plugin loader only reads `.default`, so this
// named export is inert at runtime (same pattern as build-cleaner).
export { renderDashboard };

const PLUGIN_ID = "mdkb-dashboard";

let hostRef = null;
let panelRef = null;
let panelGeneration = 0;
let tickerGeneration = 0;
let lastData = null; // last fetched { stats, memories, config, error }

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------

function updateTicker(host, stats) {
  if (!stats?.index) {
    host.clearTicker("mdkb-status");
    return;
  }
  const idx = stats.index;
  const collCount = stats.collections?.collections?.length ?? 0;
  const symbols = stats.code?.symbols;
  const codePart = symbols ? ` · ${symbols} sym` : "";
  const pending = stats.memory?.pending_embeddings > 0 ? ` · ${stats.memory.pending_embeddings} unembedded` : "";
  host.setTicker({
    id: "mdkb-status",
    text: `${idx.document_count} docs · ${collCount} coll${codePart}${pending}`,
    label: "mdkb",
    icon: DB_ICON,
    priority: 5, // low tier — popover only
    ttlMs: 0, // persistent until cleared
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Run a maintenance action, then re-fetch state and re-render. */
async function runAction(host, repo, cmdId) {
  const action = ACTIONS[cmdId];
  if (!action) return;
  const request = ++panelGeneration;

  // Show the running state immediately (buttons disabled + banner).
  renderPanel(lastData, repo.path, { running: cmdId });

  let lastResult;
  try {
    const argv = action.noFormat ? action.argv : ["--format", "json", ...action.argv];
    const out = await host.execCli("mdkb", argv, repo.path);
    const summary = summarizeResult(cmdId, out);
    lastResult = summary.ok
      ? { ok: true, text: `✓ ${action.label}: ${summary.text}` }
      : { ok: false, text: `✗ ${action.label} incomplete: ${summary.text}` };
    host.log(summary.ok ? "info" : "warn", `mdkb ${action.argv.join(" ")} ${summary.ok ? "completed" : "reported errors"}`);
  } catch (err) {
    lastResult = { ok: false, text: `✗ ${action.label} failed: ${err.message || err}` };
    host.log("error", `mdkb ${action.argv.join(" ")} failed`, { error: String(err) });
  }

  if (hostRef !== host || request !== panelGeneration || host.getActiveRepo()?.path !== repo.path) return;
  const data = await fetchMdkbData(host, repo.path);
  if (hostRef !== host || request !== panelGeneration || host.getActiveRepo()?.path !== repo.path) return;
  lastData = data;
  renderPanel(data, repo.path, { lastResult });
  void refreshTicker(host);
}

/** Short human summary of an action's stdout as `{ ok, text }`. `update`/`compact`
 *  have no clean JSON, so we just confirm completion; embed/code-force emit
 *  parseable JSON. `embed` reports `errors` (string[]) next to generated/skipped:
 *  a non-empty list means the regeneration is incomplete, never a success. */
function summarizeResult(cmdId, out) {
  try {
    if (cmdId === "embed") {
      const r = JSON.parse(out);
      const errors = Array.isArray(r.errors) ? r.errors : [];
      const counts = `${r.generated ?? 0} generated, ${r.skipped ?? 0} skipped`;
      if (errors.length) return { ok: false, text: `${counts}, ${errors.length} errors (${errors[0]})` };
      return { ok: true, text: counts };
    }
    if (cmdId === "code-force") {
      const r = JSON.parse(out);
      return { ok: true, text: `${r.files_indexed ?? 0} files, ${r.symbols_indexed ?? 0} symbols` };
    }
  } catch {
    // fall through to generic
  }
  return { ok: true, text: "done" };
}

// ---------------------------------------------------------------------------
// Panel lifecycle
// ---------------------------------------------------------------------------

/**
 * Push a render into the open panel. update() returns false once the user has
 * closed the tab; that decision sticks, so we drop the handle instead of
 * re-opening a panel nobody asked for.
 */
function renderPanel(data, repoPath, opts = {}) {
  if (!panelRef) return;
  if (!panelRef.update(renderDashboard(data, repoPath, opts))) panelRef = null;
}

async function handlePanelMessage(msg) {
  if (!msg || msg.action !== "run") return;
  const host = hostRef;
  if (!host) return;
  const repo = host.getActiveRepo();
  if (!repo) return;
  await runAction(host, repo, msg.cmd);
}

async function openDashboard(host) {
  if (hostRef !== host) return;
  const request = ++panelGeneration;
  const onClose = () => { panelGeneration++; panelRef = null; };
  const repo = host.getActiveRepo();
  if (!repo) {
    const html = buildPage("(none)", null, `
      <div class="dash-section">
        <div class="empty-state">
          <h2>No active repository</h2>
          <p>Select a repository in the sidebar to view its mdkb status.</p>
        </div>
      </div>
    `);
    // openPanel reuses and activates the panel with this id when one is open,
    // so the user always ends up looking at it — no update/re-open dance.
    panelRef = host.openPanel({ id: "mdkb-dash", title: "mdkb", html, onMessage: handlePanelMessage, onClose });
    return;
  }

  // Open instantly with a loading placeholder, then fetch.
  const loading = buildPage(repo.displayName, null, `
    <div class="dash-section"><div class="empty-state">Loading mdkb data for ${esc(repo.displayName)}…</div></div>
  `);
  panelRef = host.openPanel({ id: "mdkb-dash", title: "mdkb", html: loading, onMessage: handlePanelMessage, onClose });

  const data = await fetchMdkbData(host, repo.path);
  if (hostRef !== host || request !== panelGeneration || host.getActiveRepo()?.path !== repo.path) return;
  lastData = data;
  renderPanel(data, repo.path);
  void refreshTicker(host);
}

async function refreshTicker(host) {
  const request = ++tickerGeneration;
  const repo = host.getActiveRepo();
  if (!repo) {
    host.clearTicker("mdkb-status");
    return;
  }
  try {
    const out = await host.execCli("mdkb", ["--format", "json", "stats"], repo.path);
    if (hostRef !== host || request !== tickerGeneration || host.getActiveRepo()?.path !== repo.path) return;
    updateTicker(host, JSON.parse(out));
  } catch {
    if (hostRef !== host || request !== tickerGeneration || host.getActiveRepo()?.path !== repo.path) return;
    host.clearTicker("mdkb-status");
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export default {
  id: PLUGIN_ID,

  onload(host) {
    hostRef = host;

    host.registerTerminalAction({
      id: "open-mdkb-dashboard",
      label: "mdkb Dashboard",
      action: () => openDashboard(host),
    });

    host.registerDashboard({
      label: "mdkb",
      icon: DB_ICON,
      open: () => openDashboard(host),
    });

    host.onStateChange((event) => {
      if (event.type !== "repo-changed") return;
      panelGeneration++;
      void refreshTicker(host);
    });
    void refreshTicker(host);
  },

  onunload() {
    panelGeneration++;
    tickerGeneration++;
    hostRef?.clearTicker("mdkb-status");
    hostRef = null;
    panelRef = null;
    lastData = null;
  },
};
