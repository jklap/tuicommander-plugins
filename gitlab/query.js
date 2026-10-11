/** A4 WorkItemQuery → GitLab list endpoints (issues, merge requests, to-do items). */
import { nextCursor, pageNumber, pageSize } from './client.js';

const STATES = new Set(['opened', 'closed', 'merged', 'all']);
const SORTS = { updated: 'updated_at', created: 'created_at' };

/** Filterable and sortable list fields; the core list renders one control per field. */
export const listFields = [
  { id: 'type', name: 'Type', kind: 'enum', required: false, editable: false, options: [{ id: 'issue', name: 'Issues' }, { id: 'merge_request', name: 'Merge requests' }] },
  { id: 'state', name: 'State', kind: 'enum', required: false, editable: false, options: [{ id: 'opened', name: 'Open' }, { id: 'closed', name: 'Closed' }, { id: 'merged', name: 'Merged' }, { id: 'all', name: 'All' }] },
  { id: 'labels', name: 'Labels', kind: 'labels', required: false, editable: false, options: [] },
  { id: 'assignee', name: 'Assignee', kind: 'user', required: false, editable: false, options: [] },
  { id: 'author', name: 'Author', kind: 'user', required: false, editable: false, options: [] },
  { id: 'updated', name: 'Updated', kind: 'date', required: false, editable: false, options: [] },
  { id: 'created', name: 'Created', kind: 'date', required: false, editable: false, options: [] },
];

const emptyQuery = { filters: [], savedFilterId: null, search: '', sort: null, groupBy: null, cursor: null, limit: 50 };
const preset = (id, name, filters) => ({ id, name, query: { ...emptyQuery, savedFilterId: id, filters } });
const enumFilter = (fieldId, value) => ({ fieldId, values: [{ kind: 'enum', value }] });

/** `scope` cannot be expressed as a field filter, so presets carry it by id. */
const PRESET_SCOPES = {
  'assigned-issues': 'assigned_to_me', 'created-issues': 'created_by_me',
  'assigned-mrs': 'assigned_to_me', 'created-mrs': 'created_by_me', 'review-mrs': 'all',
};

export function presets(login) {
  const issues = enumFilter('type', 'issue');
  const mrs = enumFilter('type', 'merge_request');
  const open = enumFilter('state', 'opened');
  return [
    preset('assigned-issues', 'Issues assigned to me', [issues, open]),
    preset('created-issues', 'Issues I created', [issues, open]),
    preset('assigned-mrs', 'Merge requests assigned to me', [mrs, open]),
    preset('created-mrs', 'My merge requests', [mrs, open]),
    ...(login ? [preset('review-mrs', 'Review requests', [mrs, open])] : []),
    preset('todos', 'To-do list', []),
  ];
}

function single(query, fieldId) {
  const values = query.filters.filter((f) => f.fieldId === fieldId).flatMap((f) => f.values);
  if (values.length > 1) throw new Error(`GitLab filter ${fieldId} accepts one value`);
  return values[0];
}

const userName = (value) => {
  if (value?.kind !== 'user' || value.value.length !== 1) throw new Error('GitLab user filter needs one username');
  return value.value[0].id.replace(/^@/, '');
};

/** Search, filter and sort parameters shared by the issue list and the board lanes. */
export function issueParams(query) {
  for (const filter of query.filters) {
    if (!listFields.some((f) => f.id === filter.fieldId)) throw new Error(`Unsupported GitLab filter: ${filter.fieldId}`);
  }
  const params = {};
  if (query.search?.trim()) params.search = query.search.trim();
  const labels = query.filters.filter((f) => f.fieldId === 'labels').flatMap((f) => f.values)
    .flatMap((v) => (v.kind === 'labels' ? v.value.map((l) => l.name) : [String(v.value)]))
    .flatMap((name) => name.split(',')).map((name) => name.trim()).filter(Boolean);
  if (labels.length) params.labels = labels.join(',');
  const assignee = single(query, 'assignee');
  if (assignee) params.assignee_username = userName(assignee);
  const author = single(query, 'author');
  if (author) params.author_username = userName(author);
  for (const [fieldId, param] of [['updated', 'updated_after'], ['created', 'created_after']]) {
    const value = single(query, fieldId);
    if (value) params[param] = String(value.value);
  }
  if (query.sort) {
    const orderBy = SORTS[query.sort.fieldId];
    if (!orderBy) throw new Error(`GitLab cannot sort by ${query.sort.fieldId}`);
    params.order_by = orderBy;
    params.sort = query.sort.descending ? 'desc' : 'asc';
  } else {
    params.order_by = 'updated_at';
    params.sort = 'desc';
  }
  return params;
}

/**
 * The list request for a query: `{path, todos}`. Without a configured project the
 * instance-wide endpoints are used (`scope=all` = everything the token can read).
 */
export function listRequest(query, { project, login }) {
  const page = pageNumber(query.cursor);
  const size = pageSize(query.limit);
  if (query.savedFilterId === 'todos') {
    const params = new URLSearchParams({ state: 'pending', per_page: String(size), page: String(page) });
    return { path: `todos?${params}`, todos: true };
  }
  if (query.savedFilterId && !(query.savedFilterId in PRESET_SCOPES)) throw new Error('Unknown GitLab preset');
  const type = single(query, 'type')?.value ?? 'issue';
  if (type !== 'issue' && type !== 'merge_request') throw new Error('Unknown GitLab item type');
  const state = single(query, 'state')?.value ?? 'opened';
  if (!STATES.has(state) || (state === 'merged' && type === 'issue')) throw new Error(`GitLab ${type} has no state ${state}`);
  const params = new URLSearchParams({ ...issueParams(query), per_page: String(size), page: String(page) });
  if (state !== 'all') params.set('state', state);
  params.set('scope', PRESET_SCOPES[query.savedFilterId] ?? 'all');
  if (query.savedFilterId === 'review-mrs') params.set('reviewer_username', login);
  const collection = type === 'issue' ? 'issues' : 'merge_requests';
  const path = project && !query.savedFilterId ? `projects/${encodeURIComponent(project)}/${collection}` : collection;
  if (path.startsWith('projects/')) params.delete('scope');
  return { path: `${path}?${params}`, mr: type === 'merge_request', todos: false };
}

export async function search(request, query, options, signal) {
  const spec = listRequest(query, options);
  const { json, headers } = await request(spec.path, { signal });
  if (!Array.isArray(json)) throw new Error('Invalid GitLab list response');
  const rows = spec.todos
    ? json.filter((t) => (t.target_type === 'Issue' || t.target_type === 'MergeRequest') && t.target)
      .map((t) => ({ raw: t.target, mr: t.target_type === 'MergeRequest' }))
    : json.map((raw) => ({ raw, mr: spec.mr }));
  return { rows, nextCursor: nextCursor(headers) };
}
