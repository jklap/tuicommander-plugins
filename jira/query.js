const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const FIELDS = new Set(['project', 'status', 'assignee', 'labels', 'issuetype', 'priority']);
const SORT = new Set(['updated', 'created', 'priority', 'key', 'summary']);
export const presets = [
  { id: 'assigned', name: 'Assigned to me', jql: 'assignee = currentUser() AND resolution = Unresolved' },
  { id: 'reported', name: 'Reported by me', jql: 'reporter = currentUser() ORDER BY updated DESC' },
  { id: 'recent', name: 'Recently updated', jql: 'updated >= -7d' },
];

export function buildJql(query, textFallback = false) {
  const search = query.search.trim();
  let expression = search || presets.find((p) => p.id === query.savedFilterId)?.jql || 'resolution = Unresolved';
  if (search && !textFallback && /^[a-z][a-z0-9_]*-\d+$/i.test(search)) expression = `key = ${quote(search.toUpperCase())}`;
  else if (search && textFallback) expression = `text ~ ${quote(search)}`;
  const filters = query.filters.map(({ fieldId, values }) => {
    if (!FIELDS.has(fieldId)) throw new Error(`Unsupported Jira filter: ${fieldId}`);
    return values.length ? `${fieldId} IN (${values.flatMap((v) => v.kind === 'user' || v.kind === 'labels' ? v.value.map((o) => quote(o.id)) : [quote(v.value)]).join(', ')})` : '';
  }).filter(Boolean);
  // Preserve a user-provided ORDER BY while placing filters before it.
  const orderAt = expression.search(/\s+ORDER\s+BY\s+/i);
  let order = orderAt < 0 ? '' : expression.slice(orderAt);
  if (orderAt >= 0) expression = expression.slice(0, orderAt);
  if (query.sort) {
    if (!SORT.has(query.sort.fieldId)) throw new Error('Unsupported Jira sort field');
    order = ` ORDER BY ${query.sort.fieldId} ${query.sort.descending ? 'DESC' : 'ASC'}`;
  }
  return [expression, ...filters].map((s) => `(${s})`).join(' AND ') + (order || ' ORDER BY updated DESC');
}

export async function search(client, query, allowFallback = true) {
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit || 50)));
  async function run(fallback) {
    const body = { jql: buildJql(query, fallback), maxResults: limit, fields: ['summary', 'status', 'assignee', 'labels', 'updated', 'issuetype', 'priority', 'duedate'] };
    if (client.cloud) {
      if (query.cursor) body.nextPageToken = query.cursor;
      return client.request(`${client.api}/search/jql`, { method: 'POST', body });
    }
    const offset = query.cursor == null ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid Jira page cursor');
    body.startAt = offset;
    return client.request(`${client.api}/search`, { method: 'POST', body });
  }
  let page;
  try { page = await run(false); }
  catch (error) {
    if (!allowFallback || error.status !== 400 || !query.search.trim()) throw error;
    page = await run(true);
  }
  if (!Array.isArray(page?.issues)) throw new Error('Invalid Jira search response');
  const nextOffset = (page.startAt ?? 0) + page.issues.length;
  return { issues: page.issues, nextCursor: client.cloud ? (page.isLast === true ? null : page.nextPageToken ?? null) : nextOffset < page.total && page.issues.length ? String(nextOffset) : null };
}
