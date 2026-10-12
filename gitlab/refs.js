/** GitLab item identity: `ref.id` is the full reference, `group/project#12` or `group/project!7`. */
const PATH = String.raw`[A-Za-z0-9_.][A-Za-z0-9_.\-]*(?:/[A-Za-z0-9_.][A-Za-z0-9_.\-]*)*`;
const FULL = new RegExp(`^(${PATH})([#!])([1-9]\\d{0,9})$`);

export function parseId(id) {
  const match = FULL.exec(id ?? '');
  if (!match || match[1].split('/').some((part) => part === '.' || part === '..')) throw new Error('Invalid GitLab item reference');
  return { project: match[1], mr: match[2] === '!', iid: Number(match[3]) };
}

export const formatId = (project, mr, iid) => `${project}${mr ? '!' : '#'}${iid}`;

/** API path of one issue or merge request. */
export function itemPath(id) {
  const { project, mr, iid } = parseId(id);
  return `projects/${encodeURIComponent(project)}/${mr ? 'merge_requests' : 'issues'}/${iid}`;
}

/**
 * Item URL of this instance → full reference, or null when the URL belongs to
 * another instance (a different scheme, port or relative root counts as another).
 */
export function idFromUrl(base, value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const root = new URL(`${base}/`);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return null;
  const rest = url.pathname.slice(root.pathname.length).replace(/\/+$/, '');
  const match = new RegExp(`^(${PATH})/(?:-/)?(issues|work_items|merge_requests)/([1-9]\\d{0,9})(?:/[a-z_]+)?$`).exec(rest);
  if (!match || match[1].split('/').some((part) => part === '.' || part === '..' || part === '-')) return null;
  return formatId(match[1], match[2] === 'merge_requests', Number(match[3]));
}

/** Text reference: `group/project!7`, or `!7` / `#12` against the account default project. */
export function idFromReference(value, defaultProject) {
  const text = String(value ?? '').trim();
  const short = /^([#!])([1-9]\d{0,9})$/.exec(text);
  if (short) return defaultProject ? formatId(defaultProject, short[1] === '!', Number(short[2])) : null;
  try { parseId(text); return text; } catch { return null; }
}
