const PLUGIN_ID = "stories-ticker";
const TICKER_ID = "open-count";
const CLOSED_STATUSES = ["-complete-", "-wontfix-"];

let hostRef = null;
let watchDisposable = null;
let watchGeneration = 0;
let refreshGeneration = 0;

function joinPath(root, relative) {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relative.replace(/^[\\/]+/, "")}`;
}

function isMissing(error) {
  const message = String(error);
  return message.includes("not found") || message.includes("No such file");
}

function stopWatch() {
  watchGeneration += 1;
  refreshGeneration += 1;
  watchDisposable?.dispose();
  watchDisposable = null;
}

async function refresh(repoPath) {
  const host = hostRef;
  const generation = ++refreshGeneration;
  if (!host) return;
  try {
    const names = await host.listDirectory(joinPath(repoPath, "stories"), "*.md");
    if (hostRef !== host || generation !== refreshGeneration) return;
    const openCount = names.filter((name) => !CLOSED_STATUSES.some((status) => name.includes(status))).length;
    if (openCount > 0) {
      host.setTicker({ id: TICKER_ID, text: `${openCount} open`, label: "Stories", priority: 15, ttlMs: 0 });
    } else {
      host.clearTicker(TICKER_ID);
    }
  } catch (error) {
    if (hostRef !== host || generation !== refreshGeneration) return;
    if (!isMissing(error)) host.log("warn", "Failed to scan stories", String(error));
    host.clearTicker(TICKER_ID);
  }
}

async function watchStories(repoPath) {
  const generation = watchGeneration;
  const host = hostRef;
  if (!host) return;
  try {
    const disposable = await host.watchPath(joinPath(repoPath, "stories"), () => { if (hostRef === host && generation === watchGeneration) void refresh(repoPath); });
    if (!hostRef || generation !== watchGeneration) disposable.dispose();
    else watchDisposable = disposable;
  } catch (error) {
    if (!isMissing(error)) hostRef?.log("warn", "Failed to watch stories", String(error));
  }
}

function activateRepo(repoPath) {
  stopWatch();
  if (!repoPath) {
    hostRef?.clearTicker(TICKER_ID);
    return;
  }
  void refresh(repoPath);
  void watchStories(repoPath);
}

export default {
  id: PLUGIN_ID,
  onload(host) {
    hostRef = host;
    host.onStateChange((event) => {
      if (event.type === "repo-changed") activateRepo(host.getActiveRepoPath());
    });
    activateRepo(host.getActiveRepoPath());
  },
  onunload() {
    stopWatch();
    hostRef?.clearTicker(TICKER_ID);
    hostRef = null;
  },
};
