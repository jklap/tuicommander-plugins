import { ACTIONS } from "./constants.js";
import { esc } from "./format.js";

// Page shell: header, action buttons, styles and the postMessage bridge.

function actionBar(opts) {
  const running = opts.running || null;
  const banner = opts.lastResult
    ? `<div class="run-banner ${opts.lastResult.ok ? "ok" : "err"}">${esc(opts.lastResult.text)}</div>`
    : running
      ? `<div class="run-banner running">⏳ ${esc(ACTIONS[running]?.label || running)} running… this can take a while</div>`
      : "";

  const btns = Object.entries(ACTIONS).map(([id, a]) => {
    const isRunning = running === id;
    const disabled = running ? " disabled" : "";
    return `<button data-act="${id}" class="act"${disabled}>${isRunning ? "Running…" : esc(a.label)}</button>`;
  }).join("");

  return { banner, btns };
}
export function buildPage(repoName, version, body, opts = {}) {
  const { banner, btns } = actionBar(opts);
  const verTag = version ? `<span class="version">v${esc(version)}</span>` : "";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* Plugin-specific tweaks only — layout/cards/typography come from
     PLUGIN_BASE_CSS (.dashboard, .dash-*). See docs/plugins-style.md. */
  pre.config-block {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px;
    font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 11px;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .dash-title .repo-name { color: var(--accent); margin-left: 4px; }
  .dash-title .version { color: var(--fg-muted); font-size: 11px; margin-left: 6px; font-weight: 400; }
  .dash-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  button.act {
    background: transparent; color: var(--fg-secondary);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 3px 10px; font-size: 11px; cursor: pointer;
  }
  button.act:hover:not(:disabled) { background: var(--accent); color: var(--bg-primary); border-color: var(--accent); }
  button.act:disabled { opacity: 0.5; cursor: default; }
  .dash-stat-sub { font-size: 10px; color: var(--fg-muted); margin-top: 2px; }
  .dash-stat-sub.warn { color: var(--warning); }
  .badge-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .run-banner { padding: 6px 10px; border-radius: 4px; font-size: 12px; margin-bottom: 10px; border: 1px solid var(--border); }
  /* Encoder signatures must not push the stored model and state outside the panel. */
  .embedding-model, .diagnostic-detail, .diagnostic-command { overflow-wrap: anywhere; }
  .run-banner.ok { color: var(--success); border-color: var(--success); }
  .run-banner.err { color: var(--error); border-color: var(--error); }
  .run-banner.running { color: var(--fg-secondary); }
</style>
</head>
<body>
<div class="dashboard">
  <div class="dash-header">
    <h1 class="dash-title">mdkb <span class="repo-name">${esc(repoName)}</span>${verTag}</h1>
    <div class="dash-actions">${btns}</div>
  </div>
  ${banner}
  ${body}
</div>
<script>
  const post = (m) => window.parent.postMessage(m, "*");
  document.querySelectorAll("button.act").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      document.querySelectorAll("button.act").forEach((b) => { b.disabled = true; });
      btn.textContent = "Running…";
      post({ action: "run", cmd: btn.dataset.act });
    });
  });
</script>
</body>
</html>`;
}
