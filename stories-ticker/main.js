const PLUGIN_ID = "stories-ticker";
const TICKER_ID = "open-count";

let hostRef = null;
let watchDisposable = null;
let watchGeneration = 0;
let refreshGeneration = 0;

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
    const snapshot = await host.getStoryCount(repoPath);
    if (hostRef !== host || generation !== refreshGeneration) return;
    if (snapshot.openCount > 0) {
      host.setTicker({ id: TICKER_ID, text: `${snapshot.openCount} open`, label: "Stories", priority: 15, ttlMs: 0 });
    } else {
      host.clearTicker(TICKER_ID);
    }
  } catch (error) {
    if (hostRef !== host || generation !== refreshGeneration) return;
    host.log("warn", "Failed to read story count", String(error));
    host.clearTicker(TICKER_ID);
  }
}

async function watchStories(repoPath) {
  const generation = watchGeneration;
  const host = hostRef;
  if (!host) return;
  try {
    const disposable = await host.watchStoryCount(repoPath, () => {
      if (hostRef === host && generation === watchGeneration) void refresh(repoPath);
    });
    if (hostRef !== host || generation !== watchGeneration) disposable.dispose();
    else {
      watchDisposable = disposable;
      await refresh(repoPath);
    }
  } catch (error) {
    if (hostRef !== host || generation !== watchGeneration) return;
    host.log("warn", "Failed to watch story count", String(error));
    host.clearTicker(TICKER_ID);
  }
}

function activateRepo(repoPath) {
  stopWatch();
  // Never keep a previous repository/backend's count while its replacement loads.
  hostRef?.clearTicker(TICKER_ID);
  if (repoPath) void watchStories(repoPath);
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
