// Data fetching: runs the mdkb CLI and parses its JSON output.

export async function fetchMdkbData(host, repoPath) {
  const data = { stats: null, memories: null, config: null, error: null };

  // stats and memory list are independent — one failing must not blank the
  // whole dashboard (the old Promise.all did exactly that when `status` broke).
  const [statsRes, memRes] = await Promise.allSettled([
    host.execCli("mdkb", ["--format", "json", "status"], repoPath),
    host.execCli("mdkb", ["--format", "json", "memory", "list"], repoPath),
  ]);

  if (statsRes.status === "fulfilled") {
    try {
      data.stats = JSON.parse(statsRes.value);
    } catch (err) {
      data.error = `Could not parse mdkb status: ${err.message || err}`;
    }
  } else {
    data.error = statsRes.reason?.message || String(statsRes.reason);
    host.log("warn", "mdkb status failed", { error: data.error });
  }

  if (memRes.status === "fulfilled") {
    try {
      const parsed = JSON.parse(memRes.value);
      data.memories = Array.isArray(parsed) ? parsed : [];
    } catch {
      data.memories = [];
    }
  }

  // Config is optional — absent before `mdkb init`.
  try {
    data.config = await host.readFile(`${repoPath}/.mdkb/config.toml`);
  } catch {
    data.config = null;
  }

  return data;
}
