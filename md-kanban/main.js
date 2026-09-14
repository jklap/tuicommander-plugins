/**
 * Markdown Kanban Plugin — a board over checkbox tasks in a plain markdown
 * file, with inline metadata (`[field:: value]` / `(field:: value)`),
 * `#tags`, heading-path labels, and a small dependency graph.
 *
 * Unlike wiz-kanban (one file per task, directory-scoped, three views), this
 * plugin's source of truth is a single markdown file the user points a
 * "board" at. Multiple boards can be added; only one is rendered at a time,
 * with an in-panel tab strip to switch between them.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = "md-kanban";
const PANEL_ID = "md-kanban-board";
const BOARDS_DATA_PATH = "boards.json";
const ARCHIVE_DAYS = 5;

/** Column order on the board, left to right. */
export const STATUS_TYPES = ["pending", "ready", "in_progress", "blocked", "done", "wontfix"];

export const STATUS_LABELS = {
  pending: "Pending",
  ready: "Ready",
  in_progress: "In Progress",
  blocked: "Blocked",
  done: "Done",
  wontfix: "Won\u2019t Fix",
};

/** Source status character (inside `[ ]`) -> status type. Anything else means
 *  the line is not a board task and is left untouched. */
export const CHAR_TO_STATUS = {
  " ": "ready",
  x: "done",
  X: "done",
  "/": "in_progress",
  "-": "wontfix",
  "?": "blocked",
  "+": "pending",
  i: "pending",
  I: "pending",
  "!": "pending",
};

/** Status type -> the character written when a card is dropped on that
 *  column. PENDING always writes "+" — the i/I/! distinction is lost on a
 *  round trip, per spec. */
export const STATUS_TO_CHAR = {
  ready: " ",
  done: "x",
  in_progress: "/",
  wontfix: "-",
  blocked: "?",
  pending: "+",
};

/** Severity order: lowest < low < (none) < medium < high < highest. Explicit
 *  "medium" ranks ABOVE no-priority-field — that is the spec as written. */
export const PRIORITY_RANK = { highest: 5, high: 4, medium: 3, "": 2, low: 1, lowest: 0 };

export const PRIORITY_EMOJI = {
  highest: "\uD83D\uDD3A", // 🔺
  high: "\u23EB", // ⏫
  medium: "\uD83D\uDD3C", // 🔼
  "": "",
  low: "\uD83D\uDD3D", // 🔽
  lowest: "\u23EC", // ⏬
};

/** Linear progress order used for the "lagging dependency" check. BLOCKED is
 *  deliberately absent — as an UPSTREAM status it always flags (handled as a
 *  special case in isLagging); as a DOWNSTREAM status it is treated as
 *  READY's rank for the comparison (an open, not-yet-progressing task). */
export const PROGRESS_RANK = { pending: 0, ready: 1, in_progress: 2, done: 3, wontfix: 3 };

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Mirrors host.openExternalUrl's own allowlist (src/utils/openUrl.ts). Any
 *  other scheme is silently dropped there with no signal back to the caller
 *  — checking it here first lets the plugin show the user a toast instead
 *  of a link click doing nothing with no explanation. */
const ALLOWED_EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);
export function isSupportedExternalScheme(target) {
  try {
    return ALLOWED_EXTERNAL_SCHEMES.has(new URL(target).protocol);
  } catch {
    return false;
  }
}

const TASK_LINE_RE = /^(\s*)([-*+])\s\[(.)\]\s?(.*)$/;
const LINK_RE = /\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^()\s]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const FIELD_RE =
  /\[\s*([A-Za-z_][A-Za-z0-9_-]*)\s*::\s*([^\]\n]*?)\s*\]|\(\s*([A-Za-z_][A-Za-z0-9_-]*)\s*::\s*([^)\n]*?)\s*\)/g;
const TAG_RE = /(^|\s)#([A-Za-z0-9_\/-]+)/g;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** Directory portion of a path, POSIX- and Windows-slash tolerant. */
export function dirnameOf(p) {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? "" : p.slice(0, idx);
}

/** Resolve `rel` against `baseDir` without a Node `path` module (plugins run
 *  in the host's JS realm, not Node). Absolute paths pass through unchanged. */
export function resolveRelativePath(baseDir, rel) {
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("/") || rel.startsWith("\\")) return rel;
  const baseParts = baseDir.split(/[\\/]/).filter(Boolean);
  const relParts = rel.split(/[\\/]/);
  for (const part of relParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") baseParts.pop();
    else baseParts.push(part);
  }
  // A POSIX-style path needs its leading "/" rebuilt (split via filter(Boolean)
  // above drops it); a Windows one already starts with a drive letter like
  // "C:" and must NOT get one prepended, or "C:/Users/..." becomes the
  // invalid "/C:/Users/...".
  const isWindowsDrive = /^[a-zA-Z]:$/.test(baseParts[0] || "");
  return isWindowsDrive ? baseParts.join("/") : `/${baseParts.join("/")}`;
}

/** Basename without extension, or the frontmatter title when present. */
export function boardNameFor(path, frontmatterTitle) {
  if (frontmatterTitle && frontmatterTitle.trim()) return frontmatterTitle.trim();
  const base = path.split(/[\\/]/).pop() || path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** A URL-scheme target (http:, https:, mailto:, ...) vs. a plain file path.
 *  Deliberately excludes a Windows drive letter ("C:\...") from looking like
 *  a scheme. */
export function classifyLinkTarget(target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-zA-Z]:[\\/]/.test(target)) {
    return { kind: "external" };
  }
  return { kind: "file" };
}

/** Split content into EOL-free lines, remembering the EOL style and whether
 *  the file ended with a trailing newline, so a rewrite round-trips exactly. */
export function splitPreservingEol(content) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline = content.endsWith("\n") || content.endsWith("\r");
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (endsWithNewline && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { lines, eol, trailingNewline: endsWithNewline };
}

export function joinPreservingEol({ lines, eol, trailingNewline }) {
  return lines.join(eol) + (trailingNewline ? eol : "");
}

/** Today's date as YYYY-MM-DD in LOCAL time — not `toISOString()`, which is
 *  UTC and would name the wrong day for most of the evening in UTC-N zones. */
export function todayIso(now) {
  const d = now || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Task-body extraction (links, inline fields, tags, display spans)
// ---------------------------------------------------------------------------

/** Does [start, end) overlap any already-masked index? */
function overlapsMasked(masked, start, end) {
  for (let i = start; i < end; i++) {
    if (masked[i]) return true;
  }
  return false;
}

/** Extract links, inline fields, and tags from a task's body text, in that
 *  order — links MUST run first, or a link label containing "::" would be
 *  eaten by the field regex. Each pass only matches spans no earlier pass
 *  already claimed, so nothing is double-counted. */
function extractSpans(body) {
  const masked = new Array(body.length).fill(false);
  const links = [];
  const fields = [];
  const tags = [];

  LINK_RE.lastIndex = 0;
  let m = LINK_RE.exec(body);
  while (m) {
    const start = m.index;
    const end = LINK_RE.lastIndex;
    let target = m[2];
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    links.push({ label: m[1], target, start, end });
    for (let i = start; i < end; i++) masked[i] = true;
    m = LINK_RE.exec(body);
  }

  FIELD_RE.lastIndex = 0;
  m = FIELD_RE.exec(body);
  while (m) {
    const start = m.index;
    const end = FIELD_RE.lastIndex;
    if (!overlapsMasked(masked, start, end)) {
      const bracket = m[1] !== undefined ? "[" : "(";
      const key = m[1] !== undefined ? m[1] : m[3];
      const value = m[1] !== undefined ? m[2] : m[4];
      fields.push({ key, value, bracket, start, end });
      for (let i = start; i < end; i++) masked[i] = true;
    }
    m = FIELD_RE.exec(body);
  }

  TAG_RE.lastIndex = 0;
  m = TAG_RE.exec(body);
  while (m) {
    const tagStart = m.index + m[1].length;
    const tagEnd = TAG_RE.lastIndex;
    if (!overlapsMasked(masked, tagStart, tagEnd)) {
      tags.push({ name: m[2], start: tagStart, end: tagEnd });
      for (let i = tagStart; i < tagEnd; i++) masked[i] = true;
    }
    m = TAG_RE.exec(body);
  }

  return { links, fields, tags, masked };
}

/** Build the ordered text/link spans used for rendering: link ranges become a
 *  placeholder token (so multiple links never collide), field/tag ranges
 *  collapse to a single space, everything else is display text. Whitespace
 *  runs are then collapsed and trimmed, same as a browser would render
 *  adjacent text nodes. */
function buildDisplaySpans(body, links, masked) {
  const PLACEHOLDER = "\u0000";
  const sorted = [...links].sort((a, b) => a.start - b.start);
  let out = "";
  let i = 0;
  let li = 0;
  while (i < body.length) {
    if (li < sorted.length && sorted[li].start === i) {
      out += PLACEHOLDER + li + PLACEHOLDER;
      i = sorted[li].end;
      li++;
      continue;
    }
    out += masked[i] ? " " : body[i];
    i++;
  }
  out = out.replace(/[ \t]+/g, " ").trim();

  const spans = [];
  const re = /\u0000(\d+)\u0000/g;
  let last = 0;
  let m = re.exec(out);
  while (m) {
    if (m.index > last) {
      const text = out.slice(last, m.index).trim();
      if (text) spans.push({ type: "text", text });
    }
    const link = sorted[Number(m[1])];
    spans.push({ type: "link", label: link.label, target: link.target, external: link.external, absPath: link.absPath });
    last = re.lastIndex;
    m = re.exec(out);
  }
  if (last < out.length) {
    const text = out.slice(last).trim();
    if (text) spans.push({ type: "text", text });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a markdown file into a board: frontmatter title, every checkbox
 *  task (with metadata, tags, headings, dependency graph already resolved),
 *  and the EOL bookkeeping needed to round-trip a rewrite exactly. */
export function parseBoard(content, boardPath) {
  const { lines, eol, trailingNewline } = splitPreservingEol(content);
  const boardDir = boardPath ? dirnameOf(boardPath) : "";

  let frontmatterTitle = null;
  let inFrontmatter = false;
  let inFence = false;
  let fenceChar = null;
  let fenceLen = 0;
  const headingStack = [];
  const tasks = [];

  // A leading "---" only counts as frontmatter if it's ever actually closed.
  // Without this check, a document that merely opens with a "---" horizontal
  // rule (and never closes it) would swallow every remaining line as
  // pseudo-frontmatter, silently discarding the whole document's tasks.
  const opensWithFrontmatter =
    lines.length > 0 &&
    lines[0].trim() === "---" &&
    lines.slice(1).some((l) => l.trim() === "---" || l.trim() === "...");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i === 0 && opensWithFrontmatter) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---" || line.trim() === "...") {
        inFrontmatter = false;
        continue;
      }
      const titleMatch = line.match(/^title:\s*(.*)$/);
      if (titleMatch) frontmatterTitle = stripQuotes(titleMatch[1].trim());
      continue;
    }

    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const ch = marker[0];
      const len = marker.length;
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLen = len;
      } else if (ch === fenceChar && len >= fenceLen) {
        inFence = false;
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    if (inFence) continue;

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      headingStack.length = depth - 1;
      headingStack[depth - 1] = headingMatch[2];
      continue;
    }

    const taskMatch = line.match(TASK_LINE_RE);
    if (!taskMatch) continue;
    const [whole, indent, , statusChar, body] = taskMatch;
    const status = CHAR_TO_STATUS[statusChar];
    if (!status) continue; // unrecognized status char — not a board task

    const bodyStart = whole.length - body.length;
    const statusCharIndex = indent.length + 3;

    const extracted = extractSpans(body);
    const fields = extracted.fields.map((f) => ({
      key: f.key,
      value: f.value,
      bracket: f.bracket,
      start: f.start + bodyStart,
      end: f.end + bodyStart,
    }));
    // One resolved link object per match, carrying everything a consumer
    // needs (including start/end for buildDisplaySpans' positioning) — task
    // rendering reads `spans`, not this array, so absPath/external MUST be
    // computed here rather than only on a second, separately-built array
    // renderSpan() never sees.
    const links = extracted.links.map((l) => {
      const external = classifyLinkTarget(l.target).kind === "external";
      const absPath = external
        ? undefined
        : /^[/\\]|^[a-zA-Z]:[\\/]/.test(l.target)
          ? l.target
          : resolveRelativePath(boardDir, l.target);
      return { label: l.label, target: l.target, start: l.start, end: l.end, external, absPath };
    });
    const spans = buildDisplaySpans(body, links, extracted.masked);
    const text = spans
      .map((s) => (s.type === "link" ? s.label || s.target : s.text))
      .join(" ")
      .trim();

    let priority = "";
    let dependsOnRaw = "";
    let id = "";
    let completion = "";
    let cancelled = "";
    for (const f of fields) {
      if (f.key === "priority") {
        const v = f.value.trim().toLowerCase();
        priority = v in PRIORITY_RANK ? v : "";
      } else if (f.key === "dependsOn") {
        dependsOnRaw = f.value;
      } else if (f.key === "id") {
        id = f.value.trim();
      } else if (f.key === "completion") {
        completion = f.value.trim();
      } else if (f.key === "cancelled") {
        cancelled = f.value.trim();
      }
    }
    const dependsOn = dependsOnRaw
      .split(/\s*,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);

    const task = {
      lineIndex: i,
      rawLine: line,
      indent,
      statusChar,
      status,
      statusCharIndex,
      text,
      spans,
      fields,
      priority,
      priorityRank: PRIORITY_RANK[priority] ?? PRIORITY_RANK[""],
      tags: extracted.tags.map((t) => t.name),
      links,
      id,
      dependsOn,
      danglingDeps: [],
      completion,
      cancelled,
      // A skipped heading level (H1 then H3, no H2) leaves a sparse hole at
      // the un-set intermediate index — filter it rather than rendering a
      // blank "FOO /  / BAR" segment for it.
      headingPath: headingStack.filter((h) => h !== undefined),
      key: id || `L${i}`,
      upstream: [],
      downstream: [],
      lagging: [],
    };
    tasks.push(task);
  }

  buildDependencyGraph(tasks);

  return { frontmatterTitle, tasks, eol, trailingNewline, lines };
}

/** Wire up upstream/downstream sets from each task's `dependsOn` ids, and
 *  compute which upstream tasks are "lagging" (see isLagging). Mutates the
 *  task objects in place. */
export function buildDependencyGraph(tasks) {
  const byId = new Map();
  for (const t of tasks) {
    if (t.id) byId.set(t.id, t);
  }
  for (const t of tasks) {
    t.upstream = [];
    t.downstream = [];
    t.danglingDeps = [];
    for (const depId of t.dependsOn) {
      const up = byId.get(depId);
      if (!up) {
        t.danglingDeps.push(depId);
        continue;
      }
      if (up === t) continue; // a task listing its own id: not an error, just a no-op
      t.upstream.push(up);
    }
  }
  for (const t of tasks) {
    for (const up of t.upstream) up.downstream.push(t);
  }
  for (const t of tasks) {
    t.lagging = t.upstream.filter((up) => isLagging(up, t));
  }
  return tasks;
}

/** An upstream task in BLOCKED always flags, whatever the downstream's own
 *  status. Otherwise flag when the upstream is strictly behind the
 *  downstream on the linear PROGRESS_RANK scale. A downstream task that is
 *  itself BLOCKED is treated as READY's rank for this comparison only —
 *  BLOCKED is an "open, not progressing" flavor of READY, not part of the
 *  scale. Equal ranks (including DONE vs WON'T-FIX, or two IN-PROGRESS
 *  tasks) never flag. */
export function isLagging(upstream, downstream) {
  if (upstream.status === "blocked") return true;
  const downstreamRank = downstream.status === "blocked" ? PROGRESS_RANK.ready : PROGRESS_RANK[downstream.status];
  return PROGRESS_RANK[upstream.status] < downstreamRank;
}

/** Group tasks into the 6 status columns, filtering out archived tasks when
 *  asked, and sorting each column by priority (highest severity first),
 *  ties broken by original document order. */
export function groupIntoColumns(tasks, opts) {
  const hideArchived = !!(opts && opts.hideArchived);
  const nowMs = opts && typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
  const columns = {};
  for (const s of STATUS_TYPES) columns[s] = [];
  for (const t of tasks) {
    if (!Object.prototype.hasOwnProperty.call(columns, t.status)) continue;
    if (hideArchived && isArchivable(t, nowMs)) continue;
    columns[t.status].push(t);
  }
  for (const s of STATUS_TYPES) {
    columns[s].sort((a, b) => (b.priorityRank !== a.priorityRank ? b.priorityRank - a.priorityRank : a.lineIndex - b.lineIndex));
  }
  return columns;
}

/** A DONE/WON'T-FIX task is archivable once its completion/cancelled date is
 *  more than ARCHIVE_DAYS in the past. A missing or unparseable date is
 *  never archived — we cannot prove it is old. Parsed as local midnight,
 *  not UTC. */
export function isArchivable(task, nowMs) {
  if (task.status !== "done" && task.status !== "wontfix") return false;
  const raw = (task.status === "done" ? task.completion : task.cancelled) || "";
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const t = Date.parse(`${trimmed}T00:00:00`);
  if (!Number.isFinite(t)) return false;
  return nowMs - t > ARCHIVE_DAYS * 86400000;
}

// ---------------------------------------------------------------------------
// Rewrite engine
// ---------------------------------------------------------------------------

/** Pure 1-char splice — length-neutral, so any other offset into the line
 *  stays valid across it. */
export function setStatusChar(line, statusCharIndex, newChar) {
  return line.slice(0, statusCharIndex) + newChar + line.slice(statusCharIndex + 1);
}

/** Every occurrence of `key` as an inline field on `line`, freshly scanned —
 *  never trust offsets computed against a DIFFERENT (earlier) version of
 *  the line. */
function findAllFields(line, key) {
  const re = new RegExp(FIELD_RE.source, "g");
  const out = [];
  let m = re.exec(line);
  while (m) {
    const k = m[1] !== undefined ? m[1] : m[3];
    if (k === key) out.push({ start: m.index, end: re.lastIndex, bracket: m[1] !== undefined ? "[" : "(" });
    m = re.exec(line);
  }
  return out;
}

/** [start, end) plus one adjacent whitespace run — prefer the leading run
 *  (`text  [k:: v]` -> `text`), falling back to trailing when there is no
 *  leading whitespace to eat. */
function removalEdit(line, match) {
  let start = match.start;
  const end = match.end;
  let s = start;
  while (s > 0 && (line[s - 1] === " " || line[s - 1] === "\t")) s--;
  if (s < start) return { start: s, end, replacement: "" };
  let e = end;
  while (e < line.length && (line[e] === " " || line[e] === "\t")) e++;
  return { start, end: e, replacement: "" };
}

/** Apply non-overlapping [start,end)->replacement edits, right-to-left, so
 *  earlier offsets in the same call stay valid regardless of order given. */
function applyEdits(line, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = line;
  for (const e of sorted) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}

/** Remove every occurrence of an inline field (and its trailing whitespace),
 *  preserving everything else on the line byte-for-byte. A no-op when the
 *  field is absent. */
export function removeField(line, key) {
  const matches = findAllFields(line, key);
  if (matches.length === 0) return line;
  const edits = matches.map((m) => removalEdit(line, m));
  return applyEdits(line, edits).replace(/[ \t]+$/, "");
}

/** Set an inline field to `value`, keeping its original bracket style if it
 *  already exists (updating the first occurrence and removing any stray
 *  duplicates), or appending a new `[key:: value]` field when absent. */
export function upsertField(line, key, value) {
  const matches = findAllFields(line, key);
  if (matches.length === 0) {
    const trimmed = line.replace(/[ \t]+$/, "");
    return `${trimmed}  [${key}:: ${value}]`;
  }
  // If the field is duplicated, keep the LAST occurrence — matching
  // parseBoard's own "last occurrence wins" rule for a task's typed
  // properties. Keeping a different occurrence here than parsing reads would
  // let e.g. archivability (read from the last `completion` field) silently
  // diverge from which occurrence a status-drag rewrite actually updates.
  const keeper = matches[matches.length - 1];
  const dupes = matches.slice(0, -1);
  const edits = dupes.map((m) => removalEdit(line, m));
  const newField = keeper.bracket === "[" ? `[${key}:: ${value}]` : `(${key}:: ${value})`;
  edits.push({ start: keeper.start, end: keeper.end, replacement: newField });
  return applyEdits(line, edits);
}

/** Splice the status char, then add/remove the completion/cancelled date
 *  fields for the target status. Each field op re-scans the line it is
 *  handed — no stale offsets carried between the status splice and the
 *  field edits. */
export function applyStatusTransition(line, task, toStatus, isoDate) {
  let out = setStatusChar(line, task.statusCharIndex, STATUS_TO_CHAR[toStatus]);
  if (toStatus === "done") {
    out = removeField(out, "cancelled");
    out = upsertField(out, "completion", isoDate);
  } else if (toStatus === "wontfix") {
    out = removeField(out, "completion");
    out = upsertField(out, "cancelled", isoDate);
  } else {
    out = removeField(out, "completion");
    out = removeField(out, "cancelled");
  }
  return out;
}

/** 6-char lowercase-alnum id, retried against collisions in `existingIds`. */
export function generateTaskId(existingIds) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let s = "";
    for (let i = 0; i < 6; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    if (!existingIds.has(s)) return s;
  }
  throw new Error("md-kanban: exhausted id generation attempts");
}

/** No-op when the task already has an id. Otherwise generates one, writes
 *  it, and returns both the new line and the id (for the "Get ID" button's
 *  clipboard-copy round trip). */
export function ensureTaskId(line, task, existingIds) {
  if (task.id) return { line, id: task.id };
  const id = generateTaskId(existingIds);
  return { line: upsertField(line, "id", id), id };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSpan(span) {
  if (span.type === "text") return esc(span.text);
  const target = span.external ? span.target : span.absPath || span.target;
  const label = esc(span.label || span.target);
  return `<a class="lnk" href="#" data-target="${esc(target)}" data-ext="${span.external ? "1" : "0"}">${label}</a>`;
}

function renderCard(task) {
  const prioEmoji = PRIORITY_EMOJI[task.priority] || "";
  const headingLabel = task.headingPath.length ? esc(task.headingPath.join(" / ").toUpperCase()) : "";
  const tagsHtml = task.tags.map((t) => `<span class="badge tag-badge">#${esc(t)}</span>`).join("");
  const bodyHtml = task.spans.map((s) => renderSpan(s)).join(" ");

  let upBadge = "";
  if (task.upstream.length > 0) {
    const keys = esc(task.upstream.map((u) => u.key).join(","));
    upBadge = `<span class="dep dep-up" data-hl="${keys}" title="Depends on ${task.upstream.length} task(s)">&lt;</span>`;
  } else if (task.danglingDeps.length > 0) {
    upBadge = `<span class="dep dep-dangling" title="Unresolved dependsOn: ${esc(task.danglingDeps.join(", "))}">&lt;?</span>`;
  }
  const lagBadge =
    task.lagging.length > 0
      ? `<span class="dep dep-lag" data-hl="${esc(task.lagging.map((u) => u.key).join(","))}" title="${task.lagging.length} upstream task(s) lagging behind">!</span>`
      : "";
  const downBadge =
    task.downstream.length > 0
      ? `<span class="dep dep-down" data-hl="${esc(task.downstream.map((d) => d.key).join(","))}" title="${task.downstream.length} downstream task(s)">&gt;</span>`
      : "";
  const idBadge = task.id
    ? ""
    : `<button class="get-id-btn" data-key="${esc(task.key)}" data-raw="${esc(task.rawLine)}" title="Assign an id so another task can depend on this one">#</button>`;

  return `<div class="card" data-key="${esc(task.key)}" data-status="${esc(task.status)}" data-raw="${esc(task.rawLine)}">
    <div class="card-head">
      ${prioEmoji ? `<span class="prio">${prioEmoji}</span>` : ""}
      ${headingLabel ? `<span class="heading-path">${headingLabel}</span>` : ""}
      <span class="dep-badges">${upBadge}${lagBadge}${downBadge}${idBadge}</span>
    </div>
    <div class="card-body">${bodyHtml}</div>
    ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ""}
  </div>`;
}

function renderTabs(boards, activeBoardId) {
  if (boards.length === 0) return "";
  return `<div class="board-tabs">${boards
    .map(
      (b) =>
        `<span class="board-tab${b.id === activeBoardId ? " active" : ""}" data-board-id="${esc(b.id)}">
          <span class="board-tab-name">${esc(b.name)}</span>
          <button class="board-tab-close" data-board-id="${esc(b.id)}" title="Close board">&times;</button>
        </span>`,
    )
    .join("")}<button class="add-board-btn" title="Add a markdown file as a board">+ Add Board</button></div>`;
}

function renderEmptyState() {
  return `<div class="empty-state">
    No boards yet
    <div class="hint">Point a board at a markdown file with checkbox tasks to get started.</div>
    <button class="primary add-board-btn">Add Board</button>
  </div>`;
}

function renderColumns(columns) {
  return STATUS_TYPES.map((status) => {
    const cards = columns[status].map((t) => renderCard(t)).join("");
    const placeholder = columns[status].length === 0 ? `<div class="empty-col">No tasks</div>` : "";
    return `<div class="column" data-status="${status}">
      <div class="col-header ${status}">
        <span class="col-label">${STATUS_LABELS[status]}</span>
        <span class="col-count">${columns[status].length}</span>
      </div>
      <div class="col-body">${cards}${placeholder}</div>
    </div>`;
  }).join("");
}

/** Full panel HTML for the current model. `model.boards` is the persisted
 *  board list (id+name, for the tab strip); `model.columns` is null until
 *  the active board's file has actually been read once. */
export function buildBoardHtml(model) {
  const { boards, activeBoardId, hideArchived, search, columns, errorMessage } = model;

  let body;
  if (boards.length === 0) {
    body = renderEmptyState();
  } else if (errorMessage) {
    body = `${renderTabs(boards, activeBoardId)}
      <div class="empty-state">${esc(errorMessage)}</div>`;
  } else if (!columns) {
    body = `${renderTabs(boards, activeBoardId)}<div class="empty-state">Loading&hellip;</div>`;
  } else {
    body = `${renderTabs(boards, activeBoardId)}
      <div class="filter-bar">
        <input type="search" class="search-input" placeholder="Search tasks..." value="${esc(search || "")}">
        <label class="archive-toggle"><input type="checkbox" class="archive-checkbox" ${hideArchived ? "checked" : ""}> Hide archived (&gt;5d)</label>
        <button class="open-file-btn" title="Open this markdown file directly">Open file</button>
      </div>
      <div class="board">${renderColumns(columns)}</div>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { overflow: hidden; height: 100vh; display: flex; flex-direction: column; }

  .board-tabs {
    display: flex; align-items: center; gap: 2px; flex-shrink: 0;
    padding: 4px 8px; border-bottom: 1px solid var(--border, #3e3e42); overflow-x: auto;
  }
  .board-tab {
    display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px 3px 10px;
    border-radius: 4px; font-size: 12px; color: var(--fg-secondary, #a0a0a0); cursor: pointer;
  }
  .board-tab:hover { background: var(--bg-tertiary, #2d2d30); }
  .board-tab.active { background: var(--bg-tertiary, #2d2d30); color: var(--fg-primary, #e0e0e0); font-weight: 600; }
  .board-tab-close {
    background: transparent; border: none; color: var(--fg-muted, #9aa1a9);
    cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px;
  }
  .board-tab-close:hover { color: var(--error, #f48771); }
  .add-board-btn {
    margin-left: 4px; padding: 3px 10px; font-size: 11px; background: transparent;
    border: 1px solid var(--border, #3e3e42); border-radius: 4px;
    color: var(--fg-secondary, #a0a0a0); cursor: pointer; white-space: nowrap;
  }
  .add-board-btn:hover { background: var(--bg-tertiary, #2d2d30); color: var(--fg-primary, #e0e0e0); }

  .filter-bar { flex-shrink: 0; }
  .search-input { flex: 1; max-width: 240px; }
  .archive-toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
  .open-file-btn {
    margin-left: auto; padding: 3px 10px; font-size: 11px; background: transparent;
    border: 1px solid var(--border, #3e3e42); border-radius: 4px;
    color: var(--fg-secondary, #a0a0a0); cursor: pointer;
  }
  .open-file-btn:hover { background: var(--bg-tertiary, #2d2d30); color: var(--fg-primary, #e0e0e0); }

  .board { display: flex; flex: 1; overflow-x: auto; overflow-y: hidden; }
  .column { flex: 1; min-width: 150px; display: flex; flex-direction: column; border-right: 1px solid var(--border, #3e3e42); }
  .column:last-child { border-right: none; }
  .col-header {
    display: flex; align-items: center; justify-content: space-between; padding: 6px 10px;
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--fg-secondary, #a0a0a0); border-top: 3px solid var(--border, #3e3e42); flex-shrink: 0;
  }
  .col-header.pending { border-top-color: var(--fg-muted, #9aa1a9); }
  .col-header.ready { border-top-color: var(--accent, #59a8dd); }
  .col-header.in_progress { border-top-color: var(--warning, #dcdcaa); }
  .col-header.blocked { border-top-color: var(--error, #f48771); }
  .col-header.done { border-top-color: var(--success, #4ec9b0); }
  .col-header.wontfix { border-top-color: var(--fg-muted, #9aa1a9); }
  .col-count { background: var(--bg-tertiary, #2d2d30); padding: 0 6px; border-radius: 8px; font-size: 10px; min-width: 18px; text-align: center; }
  .col-body { flex: 1; overflow-y: auto; padding: 6px; }
  .empty-col { padding: 16px 8px; text-align: center; font-size: 11px; color: var(--fg-muted, #9aa1a9); font-style: italic; }

  .card { margin-bottom: 4px; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
  .card:hover { transform: none; }
  .card.dragging { opacity: 0.4; }
  .card.hl { outline: 2px solid var(--accent, #59a8dd); }
  .drag-ghost {
    position: fixed; pointer-events: none; z-index: 1000; opacity: 0.85;
    transform: rotate(2deg); box-shadow: 0 4px 12px rgba(0,0,0,0.4); max-width: 220px;
  }
  .card-head { display: flex; align-items: center; gap: 4px; margin-bottom: 2px; flex-wrap: wrap; }
  .prio { font-size: 11px; }
  .heading-path { font-size: 9px; font-weight: 600; letter-spacing: 0.3px; color: var(--fg-muted, #9aa1a9); }
  .dep-badges { margin-left: auto; display: inline-flex; gap: 3px; }
  .dep { font-size: 11px; font-weight: 700; cursor: default; color: var(--fg-secondary, #a0a0a0); }
  .dep-lag { color: var(--error, #f48771); }
  .dep-dangling { color: var(--fg-muted, #9aa1a9); font-size: 10px; }
  .get-id-btn {
    font-size: 9px; line-height: 1; padding: 1px 4px; background: transparent;
    border: 1px solid var(--border, #3e3e42); border-radius: 3px; color: var(--fg-muted, #9aa1a9); cursor: pointer;
  }
  .get-id-btn:hover { background: var(--bg-tertiary, #2d2d30); color: var(--fg-primary, #e0e0e0); }
  .card-body { font-size: 12px; line-height: 1.35; }
  .card-body .lnk { color: var(--accent, #59a8dd); }
  .card-tags { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
  .tag-badge { font-size: 10px; }

  .column.drop-target .col-body { background: color-mix(in srgb, var(--accent, #59a8dd) 8%, transparent); }

  .toast {
    position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
    padding: 6px 14px; border-radius: 4px; font-size: 12px; font-weight: 600;
    opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 100;
  }
  .toast.show { opacity: 1; }
  .toast.error { background: var(--error, #f48771); color: var(--text-on-error, #000); }
  .toast.success { background: var(--success, #4ec9b0); color: var(--text-on-success, #000); }
</style>
</head>
<body>
${body}
<div class="toast" id="toast"></div>

<script>
(function () {
  // ── Board tabs / add / close ──
  document.querySelectorAll(".board-tab").forEach(function (tab) {
    tab.addEventListener("click", function (e) {
      if (e.target.closest(".board-tab-close")) return;
      window.parent.postMessage({ type: "switch-board", boardId: tab.dataset.boardId }, "*");
    });
  });
  document.querySelectorAll(".board-tab-close").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      window.parent.postMessage({ type: "close-board", boardId: btn.dataset.boardId }, "*");
    });
  });
  document.querySelectorAll(".add-board-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      window.parent.postMessage({ type: "add-board" }, "*");
    });
  });

  // ── Filter bar ──
  var searchInput = document.querySelector(".search-input");
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      window.parent.postMessage({ type: "filter-change", search: searchInput.value }, "*");
    });
  }
  var archiveCheckbox = document.querySelector(".archive-checkbox");
  if (archiveCheckbox) {
    archiveCheckbox.addEventListener("change", function () {
      window.parent.postMessage({ type: "toggle-archive", hidden: archiveCheckbox.checked }, "*");
    });
  }
  var openFileBtn = document.querySelector(".open-file-btn");
  if (openFileBtn) {
    openFileBtn.addEventListener("click", function () {
      window.parent.postMessage({ type: "open-board-file" }, "*");
    });
  }

  // ── Links and Get-ID (never arm a card drag) ──
  document.querySelectorAll(".lnk").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      window.parent.postMessage({ type: "open-link", target: a.dataset.target, external: a.dataset.ext === "1" }, "*");
    });
  });
  document.querySelectorAll(".get-id-btn").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      window.parent.postMessage({ type: "assign-id", key: btn.dataset.key, rawLine: btn.dataset.raw }, "*");
    });
  });

  // ── Dependency hover highlight (purely internal — no host round trip) ──
  document.querySelectorAll(".dep[data-hl]").forEach(function (badge) {
    var keys = badge.dataset.hl.split(",");
    function setHl() {
      keys.forEach(function (k) {
        var card = document.querySelector('.card[data-key="' + CSS.escape(k) + '"]');
        if (card) card.classList.add("hl");
      });
    }
    function clearHl() {
      document.querySelectorAll(".card.hl").forEach(function (c) { c.classList.remove("hl"); });
    }
    badge.addEventListener("mouseenter", setHl);
    badge.addEventListener("mouseleave", clearHl);
  });

  // ── Drag and drop (mousedown/mousemove/mouseup — HTML5 DnD is unreliable
  //    inside a sandboxed srcdoc iframe). A plain click on the card body
  //    does nothing; only a link or the Get-ID button acts. ──
  var DRAG_THRESHOLD = 5;
  var drag = null;

  function getColumnAt(x, y) {
    var cols = document.querySelectorAll(".column");
    for (var i = 0; i < cols.length; i++) {
      var r = cols[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return cols[i];
    }
    return null;
  }

  function cleanupDrag() {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    if (drag.card) drag.card.classList.remove("dragging");
    document.querySelectorAll(".column.drop-target").forEach(function (c) { c.classList.remove("drop-target"); });
    drag = null;
  }

  document.querySelectorAll(".card").forEach(function (card) {
    card.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest(".lnk, .get-id-btn")) return;
      e.preventDefault();
      drag = {
        card: card, ghost: null,
        data: { key: card.dataset.key, status: card.dataset.status, rawLine: card.dataset.raw },
        startX: e.clientX, startY: e.clientY, started: false,
      };
    });
  });

  document.addEventListener("mousemove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.startX;
    var dy = e.clientY - drag.startY;
    if (!drag.started) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      drag.started = true;
      drag.card.classList.add("dragging");
      var ghost = drag.card.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.classList.remove("dragging");
      ghost.style.width = drag.card.getBoundingClientRect().width + "px";
      document.body.appendChild(ghost);
      drag.ghost = ghost;
    }
    drag.ghost.style.left = (e.clientX - 20) + "px";
    drag.ghost.style.top = (e.clientY - 10) + "px";
    document.querySelectorAll(".column.drop-target").forEach(function (c) { c.classList.remove("drop-target"); });
    var col = getColumnAt(e.clientX, e.clientY);
    if (col && col.dataset.status !== drag.data.status) col.classList.add("drop-target");
  });

  document.addEventListener("mouseup", function (e) {
    if (!drag) return;
    if (!drag.started) {
      // A plain click on the card body does nothing, per spec.
      cleanupDrag();
      return;
    }
    var col = getColumnAt(e.clientX, e.clientY);
    if (col) {
      var toStatus = col.dataset.status;
      if (toStatus !== drag.data.status) {
        window.parent.postMessage({ type: "status-change", key: drag.data.key, rawLine: drag.data.rawLine, toStatus: toStatus }, "*");
      }
    }
    cleanupDrag();
  });

  // ── Messages from host ──
  window.addEventListener("message", function (e) {
    if (!e.data || !e.data.type) return;
    if (e.data.type === "toast") {
      var toast = document.getElementById("toast");
      toast.textContent = e.data.message;
      toast.className = "toast " + (e.data.level || "error") + " show";
      setTimeout(function () { toast.classList.remove("show"); }, 3000);
    } else if (e.data.type === "id-assigned" && window.tuic) {
      window.tuic.clipboard(e.data.id);
      var toast2 = document.getElementById("toast");
      toast2.textContent = "Copied id to clipboard: " + e.data.id;
      toast2.className = "toast success show";
      setTimeout(function () { toast2.classList.remove("show"); }, 3000);
    }
  });
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

let hostRef = null;
let panelHandle = null;
let watchDisposable = null;
let debounceTimer = null;
let refreshPending = false;
let lastWrittenContent = null;

/** [{ id, path, name, hideArchived }] — persisted via read/write_plugin_data. */
let boards = [];
let activeBoardId = null;
let filters = { search: "" };

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function defaultState() {
  return { version: 1, activeBoardId: null, boards: [] };
}

async function loadPersistedState() {
  try {
    const raw = await hostRef.invoke("read_plugin_data", { pluginId: PLUGIN_ID, path: BOARDS_DATA_PATH });
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.boards)) return defaultState();
    return {
      version: 1,
      activeBoardId: typeof parsed.activeBoardId === "string" ? parsed.activeBoardId : null,
      boards: parsed.boards
        .filter((b) => b && typeof b.id === "string" && typeof b.path === "string")
        .map((b) => ({
          id: b.id,
          path: b.path,
          name: typeof b.name === "string" && b.name ? b.name : boardNameFor(b.path, null),
          hideArchived: !!b.hideArchived,
        })),
    };
  } catch (err) {
    hostRef.log("warn", "md-kanban: failed to load persisted state, starting empty", String(err));
    return defaultState();
  }
}

async function persistState() {
  const content = JSON.stringify({
    version: 1,
    activeBoardId,
    boards: boards.map((b) => ({ id: b.id, path: b.path, name: b.name, hideArchived: !!b.hideArchived })),
  });
  try {
    await hostRef.invoke("write_plugin_data", { pluginId: PLUGIN_ID, path: BOARDS_DATA_PATH, content });
  } catch (err) {
    hostRef.log("error", "md-kanban: failed to persist board list", String(err));
  }
}

function generateBoardId(existingIds) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `b_${Math.random().toString(36).slice(2, 8)}`;
    if (!existingIds.has(id)) return id;
  }
  throw new Error("md-kanban: exhausted board id attempts");
}

function getActiveBoard() {
  return boards.find((b) => b.id === activeBoardId) || null;
}

function toast(level, message) {
  if (panelHandle) panelHandle.send({ type: "toast", level, message });
}

// ---------------------------------------------------------------------------
// Rendering glue
// ---------------------------------------------------------------------------

function boardsForTabs() {
  return boards.map((b) => ({ id: b.id, name: b.name }));
}

function loadingModel() {
  return { boards: boardsForTabs(), activeBoardId, hideArchived: false, search: filters.search, columns: null };
}

async function refreshBoard() {
  if (!panelHandle) return;
  if (!panelHandle.isVisible()) {
    refreshPending = true;
    return;
  }

  const board = getActiveBoard();
  if (!board) {
    refreshPending = false;
    const html = buildBoardHtml({ boards: boardsForTabs(), activeBoardId: null, hideArchived: false, search: "", columns: null });
    if (!panelHandle || !panelHandle.isVisible()) {
      refreshPending = true;
      return;
    }
    if (!panelHandle.update(html)) handlePanelClose();
    return;
  }

  let content = null;
  let errorMessage = null;
  try {
    content = await hostRef.readFile(board.path);
  } catch (err) {
    errorMessage = "Could not read this file — it may have been moved or deleted.";
    hostRef.log("warn", `md-kanban: failed to read board "${board.name}"`, String(err));
  }

  if (content !== null && content === lastWrittenContent) {
    // This is our own write echoing back through the watcher — already shown.
    lastWrittenContent = null;
    return;
  }

  refreshPending = false;

  let html;
  if (errorMessage) {
    html = buildBoardHtml({ boards: boardsForTabs(), activeBoardId, hideArchived: board.hideArchived, search: filters.search, columns: null, errorMessage });
  } else {
    const parsed = parseBoard(content, board.path);
    const newName = boardNameFor(board.path, parsed.frontmatterTitle);
    if (newName !== board.name) {
      board.name = newName;
      await persistState();
    }
    const nowMs = Date.now();
    const columns = groupIntoColumns(applySearchFilter(parsed.tasks, filters.search), {
      hideArchived: board.hideArchived,
      nowMs,
    });
    html = buildBoardHtml({
      boards: boardsForTabs(),
      activeBoardId,
      hideArchived: board.hideArchived,
      search: filters.search,
      columns,
    });
  }

  if (!panelHandle || !panelHandle.isVisible()) {
    refreshPending = true;
    return;
  }
  if (!panelHandle.update(html)) handlePanelClose();
}

function applySearchFilter(tasks, search) {
  const q = (search || "").trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter(
    (t) => t.text.toLowerCase().includes(q) || t.tags.some((tag) => tag.toLowerCase().includes(q)),
  );
}

function handlePanelVisibility(visible) {
  if (visible && refreshPending) refreshBoard();
}

function handlePanelClose() {
  panelHandle = null;
  refreshPending = false;
  stopWatching();
}

// ---------------------------------------------------------------------------
// File watching
// ---------------------------------------------------------------------------

async function startWatching() {
  if (watchDisposable) {
    watchDisposable.dispose();
    watchDisposable = null;
  }
  const board = getActiveBoard();
  if (!board) return;

  const dir = dirnameOf(board.path);
  if (!dir) return;
  // The host canonicalizes the watched directory (resolving symlinks) before
  // watching it, so an emitted event's path can differ from board.path's own
  // prefix even for the same file (e.g. macOS /tmp -> /private/tmp). Compare
  // basenames instead of the full path — safe because the watch is scoped to
  // this one directory, non-recursive, so no other file can share the name.
  const boardBasename = board.path.split(/[\\/]/).pop();

  try {
    watchDisposable = await hostRef.watchPath(
      dir,
      (events) => {
        if (!events.some((e) => e.path.split(/[\\/]/).pop() === boardBasename)) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(refreshBoard, 500);
      },
      { recursive: false, debounceMs: 300 },
    );
  } catch {
    // The parent directory may be unreadable or removed — the board still
    // opens, it just won't auto-refresh on external edits.
  }
}

function stopWatching() {
  if (watchDisposable) {
    watchDisposable.dispose();
    watchDisposable = null;
  }
  clearTimeout(debounceTimer);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Re-read the active board fresh, find the task by key, and confirm its
 *  raw line still matches what the card was showing when the action fired
 *  — the file may have changed underneath a drag or a Get-ID click. On a
 *  match, `mutate(task, parsed)` returns either null (no-op) or `{line}`
 *  (plus any extra fields the caller wants back), which is spliced in and
 *  written. */
async function mutateActiveBoardTask(key, expectedRawLine, mutate) {
  const board = getActiveBoard();
  if (!board) return null;

  let content;
  try {
    content = await hostRef.readFile(board.path);
  } catch (err) {
    toast("error", `Could not read ${board.name}: ${err}`);
    return null;
  }

  const parsed = parseBoard(content, board.path);
  const task = parsed.tasks.find((t) => t.key === key);
  if (!task || task.rawLine !== expectedRawLine) {
    toast("error", "File changed on disk — board reloaded");
    await refreshBoard();
    return null;
  }

  const result = mutate(task, parsed);
  if (result == null) return null;

  const newLines = parsed.lines.slice();
  newLines[task.lineIndex] = result.line;
  const nextContent = joinPreservingEol({ lines: newLines, eol: parsed.eol, trailingNewline: parsed.trailingNewline });

  try {
    await hostRef.writeFile(board.path, nextContent);
  } catch (err) {
    toast("error", `Could not write ${board.name}: ${err}`);
    return null;
  }

  // Refresh immediately with the normal path — this render must NOT be
  // treated as an echo. Only after it lands do we remember nextContent as
  // "our own write," so the *watcher's* later, redundant callback for this
  // same write (not this render) is what gets suppressed.
  await refreshBoard();
  lastWrittenContent = nextContent;
  return result;
}

async function handleStatusChange(data) {
  if (data.boardId && data.boardId !== activeBoardId) return;
  if (!STATUS_TYPES.includes(data.toStatus)) return;
  const isoDate = todayIso();
  await mutateActiveBoardTask(data.key, data.rawLine, (task) => {
    if (task.status === data.toStatus) return null;
    return { line: applyStatusTransition(task.rawLine, task, data.toStatus, isoDate) };
  });
}

async function handleAssignId(data) {
  if (data.boardId && data.boardId !== activeBoardId) return;
  const result = await mutateActiveBoardTask(data.key, data.rawLine, (task, parsed) => {
    if (task.id) return null;
    const existingIds = new Set(parsed.tasks.map((t) => t.id).filter(Boolean));
    return ensureTaskId(task.rawLine, task, existingIds);
  });
  if (result && result.id && panelHandle) {
    panelHandle.send({ type: "id-assigned", id: result.id });
  }
}

function handleOpenLink(target, external) {
  if (!target) return;
  if (external) {
    if (!isSupportedExternalScheme(target)) {
      toast("error", "This link's type isn't supported.");
      return;
    }
    hostRef.openExternalUrl(target);
  } else {
    hostRef.openMarkdownFile(target);
  }
}

function handleOpenBoardFile() {
  const board = getActiveBoard();
  if (board) hostRef.openMarkdownFile(board.path);
}

async function handleAddBoard() {
  let picked;
  try {
    picked = await hostRef.pickFile({ filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
  } catch (err) {
    toast("error", `Could not open the file picker: ${err}`);
    return;
  }
  if (!picked) return;

  const existing = boards.find((b) => b.path === picked);
  if (existing) {
    activeBoardId = existing.id;
    filters = { search: "" };
    await persistState();
    await startWatching();
    await refreshBoard();
    return;
  }

  let content;
  try {
    content = await hostRef.readFile(picked);
  } catch (err) {
    // Show the real reason (outside $HOME, deleted between pick and read,
    // permission denied, over the size cap, ...) rather than assuming which
    // one it was.
    toast("error", `Could not read this file: ${err}`);
    hostRef.log("warn", `md-kanban: could not read newly added board "${picked}"`, String(err));
    return;
  }

  const parsed = parseBoard(content, picked);
  const id = generateBoardId(new Set(boards.map((b) => b.id)));
  const name = boardNameFor(picked, parsed.frontmatterTitle);
  boards.push({ id, path: picked, name, hideArchived: false });
  activeBoardId = id;
  filters = { search: "" };
  await persistState();
  await startWatching();
  await refreshBoard();
}

async function handleCloseBoard(boardId) {
  const idx = boards.findIndex((b) => b.id === boardId);
  if (idx === -1) return;
  boards.splice(idx, 1);
  if (activeBoardId === boardId) {
    activeBoardId = boards.length > 0 ? boards[0].id : null;
    filters = { search: "" };
  }
  await persistState();
  await startWatching();
  await refreshBoard();
}

async function handleSwitchBoard(boardId) {
  if (boardId === activeBoardId) return;
  const board = boards.find((b) => b.id === boardId);
  if (!board) return;
  activeBoardId = boardId;
  filters = { search: "" };
  await persistState();
  await startWatching();
  await refreshBoard();
}

async function handleToggleArchive(boardId, hidden) {
  const board = boards.find((b) => b.id === (boardId || activeBoardId));
  if (!board) return;
  board.hideArchived = !!hidden;
  await persistState();
  await refreshBoard();
}

function handleFilterChange(search) {
  filters = { search: search || "" };
  refreshBoard();
}

function handlePanelMessage(data) {
  if (!data || typeof data.type !== "string") return;
  switch (data.type) {
    case "status-change":
      handleStatusChange(data);
      break;
    case "assign-id":
      handleAssignId(data);
      break;
    case "open-link":
      handleOpenLink(data.target, !!data.external);
      break;
    case "open-board-file":
      handleOpenBoardFile();
      break;
    case "add-board":
      handleAddBoard();
      break;
    case "close-board":
      handleCloseBoard(data.boardId);
      break;
    case "switch-board":
      handleSwitchBoard(data.boardId);
      break;
    case "toggle-archive":
      handleToggleArchive(data.boardId, data.hidden);
      break;
    case "filter-change":
      handleFilterChange(data.search);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Panel lifecycle
// ---------------------------------------------------------------------------

async function openBoardPanel() {
  refreshPending = false;
  panelHandle = hostRef.openPanel({
    id: PANEL_ID,
    title: "Kanban",
    html: buildBoardHtml(loadingModel()),
    onMessage: handlePanelMessage,
    onVisibilityChange: handlePanelVisibility,
    onClose: handlePanelClose,
  });
  await startWatching();
  await refreshBoard();
}

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

export default {
  id: PLUGIN_ID,

  async onload(host) {
    hostRef = host;

    const persisted = await loadPersistedState();
    boards = persisted.boards;
    activeBoardId = persisted.activeBoardId && boards.some((b) => b.id === persisted.activeBoardId)
      ? persisted.activeBoardId
      : boards.length > 0
        ? boards[0].id
        : null;

    // md-kanban is not repo-scoped — a board's identity is an absolute path,
    // and openMarkdownFile/read_plugin_data/write_plugin_data all work
    // regardless of the active repo — so, deliberately, no host.onStateChange
    // handling for repo-changed/branch-changed here (unlike wiz-kanban).

    host.registerDashboard({ label: "Kanban", open: () => openBoardPanel() });
    host.registerCommand({ id: "open", title: "Open Kanban Board", run: () => openBoardPanel() });
    host.registerTerminalAction({ id: "open-md-kanban", label: "Kanban Board", action: () => openBoardPanel() });

    host.log("info", "Markdown Kanban loaded");
  },

  onunload() {
    stopWatching();
    refreshPending = false;
    panelHandle = null;
    hostRef = null;
    boards = [];
    activeBoardId = null;
    filters = { search: "" };
    lastWrittenContent = null;
  },
};
