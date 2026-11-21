// Pure formatting helpers shared by the renderers.

export function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

export function relativeTime(unixTs) {
  if (!unixTs) return "never";
  const diff = Date.now() / 1000 - unixTs;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

export function statCard(value, label, extra = "") {
  return `
    <div class="dash-stat">
      <div class="dash-stat-label">${label}</div>
      <div class="dash-stat-value">${value}</div>
      ${extra}
    </div>`;
}

export const BADGE_BY_TYPE = {
  problem: "badge-error",
  decision: "badge-accent",
  topic: "badge-success",
  handoff: "badge-muted",
  reminder: "badge-warn",
};

