import { createClient } from './client.js';
import { search, presets } from './query.js';
import { adfToMarkdown, markdownToAdf } from './adf.js';
import { issueToItem, commentPage, fieldSchema } from './model.js';
import { boardPort } from './board.js';
import { creationPort } from './fields.js';

const keyPath = (key) => encodeURIComponent(key);
const emptyQuery = { filters: [], savedFilterId: null, search: '', sort: null, cursor: null, limit: 50, groupBy: null };

export function createJiraProvider(options) {
  const { account } = options;
  const client = createClient(options);
  const { api, host, cloud, request } = client;
  function checkRef(ref) {
    if (!ref || ref.providerId !== 'jira' || ref.accountId !== account.id || !ref.id) throw new Error('Jira item belongs to another account');
    return `${api}/issue/${keyPath(ref.id)}`;
  }
  const toItem = (issue) => issueToItem(issue, account, host);
  const boards = boardPort(client, toItem);
  async function comments(ref, cursor = null, limit = 50) {
    const offset = cursor == null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid Jira comment cursor');
    const size = Math.max(1, Math.min(100, limit));
    return commentPage(await request(`${checkRef(ref)}/comment?startAt=${offset}&maxResults=${size}&orderBy=created`));
  }
  async function detail(ref) {
    const path = checkRef(ref);
    const [issue, transitions, page] = await Promise.all([
      request(`${path}?expand=names,schema,editmeta`), request(`${path}/transitions`), comments(ref),
    ]);
    if (!Array.isArray(transitions?.transitions)) throw new Error('Invalid Jira transitions response');
    const fields = Object.entries(issue.editmeta?.fields ?? {}).map(([id, f]) => ({
      ...fieldSchema({ ...f, fieldId: id }),
      editable: !['project', 'issuetype', 'status'].includes(id) && !!f.operations?.includes('set'),
    }));
    return {
      item: toItem(issue), body: adfToMarkdown(issue.fields.description),
      fields,
      actions: [
        ...(fields.some((field) => field.editable) ? [{ id: 'edit_field', name: 'Edit field', kind: 'edit_field', enabled: true, disabledReason: null }] : []),
        ...transitions.transitions.map((t) => ({ id: String(t.id), name: t.name, kind: 'transition', enabled: true, disabledReason: null })),
        { id: 'comment', name: 'Add comment', kind: 'comment', enabled: true, disabledReason: null },
        { id: 'start_work', name: 'Start work', kind: 'start_work', enabled: true, disabledReason: null },
      ], comments: page,
    };
  }
  const createFields = creationPort(client, options.projectId);
  function rawField(id, field) {
    if (field == null) return null;
    if (field.kind === 'markdown') return cloud ? markdownToAdf(field.value) : field.value;
    if (field.kind === 'enum') return { id: field.value };
    if (field.kind === 'labels') return field.value.map((v) => v.name);
    if (field.kind === 'user') {
      if (field.value.length > 1) throw new Error('Jira assignee accepts one user');
      const selected = field.value[0];
      return selected ? cloud ? { accountId: selected.id } : { name: selected.id } : null;
    }
    if (id === 'parent') return { key: field.value };
    if (id === 'project' || id === 'issuetype' || id === 'status') throw new Error('Use a typed Jira project, type or transition');
    return field.value;
  }
  async function act(ref, action) {
    if (action.kind === 'start_work') { checkRef(ref); return { kind: 'start_work', value: action.value }; }
    if (action.kind === 'create') {
      const value = action.value;
      if (!value.title.trim() || !value.itemType || !(options.projectId ?? value.fields.project?.value)) throw new Error('Jira title, project and issue type are required');
      const schema = await createFields(value.itemType);
      for (const field of schema) {
        const input = field.id === 'summary' ? value.title : field.id === 'description' ? value.body : value.fields[field.id]?.value;
        if (field.required && field.id !== 'project' && field.id !== 'issuetype' && (input == null || input === '' || Array.isArray(input) && !input.length)) throw new Error(`Jira required field: ${field.name}`);
      }
      const fields = Object.fromEntries(Object.entries(value.fields).filter(([id, f]) => id !== 'project' && f != null).map(([id, f]) => [id, rawField(id, f)]));
      fields.summary = value.title;
      fields.issuetype = { id: value.itemType };
      fields.project = { id: options.projectId ?? value.fields.project.value };
      fields.description = cloud ? markdownToAdf(value.body) : value.body;
      const created = await request(`${api}/issue`, { method: 'POST', body: { fields } });
      return { kind: 'item', value: await detail({ providerId: 'jira', accountId: account.id, id: created.key }) };
    }
    const path = checkRef(ref);
    if (action.kind === 'transition') {
      const available = await request(`${path}/transitions`);
      const transition = available.transitions.find((t) => String(t.id) === action.value);
      if (!transition) throw new Error('Jira transition is no longer available');
      await request(`${path}/transitions`, { method: 'POST', body: { transition: { id: String(transition.id) } } });
    } else if (action.kind === 'comment') {
      if (!action.value.trim()) throw new Error('Jira comment cannot be empty');
      await request(`${path}/comment`, { method: 'POST', body: { body: cloud ? markdownToAdf(action.value) : action.value } });
    } else if (action.kind === 'edit_field') {
      const { fieldId, value } = action.value;
      if (['status', 'project', 'issuetype'].includes(fieldId)) throw new Error('Use Jira transitions or create action');
      const issue = await request(`${path}/editmeta`);
      if (!issue.fields?.[fieldId]?.operations?.includes('set')) throw new Error('Jira field is not editable');
      await request(path, { method: 'PUT', body: { fields: { [fieldId]: rawField(fieldId, value) } } });
    } else throw new Error('Unsupported Jira action');
    return { kind: 'item', value: await detail(ref) };
  }
  function resolveUrl(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.origin !== new URL(host).origin) return null;
    const prefix = new URL(host).pathname.replace(/\/$/, '');
    const path = url.pathname.slice(prefix.length);
    if (!url.pathname.startsWith(`${prefix}/`)) return null;
    const key = path.match(/^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/i)?.[1];
    return key ? { providerId: 'jira', accountId: account.id, id: key.toUpperCase() } : null;
  }
  return {
    providerId: 'jira', accountId: account.id, name: `Jira · ${account.label ?? host}`,
    fields: ['project', 'status', 'assignee', 'labels', 'issuetype', 'priority', 'updated', 'created', 'key', 'summary'].map((id) => ({
      id, name: { issuetype: 'Issue type', summary: 'Summary' }[id] ?? id[0].toUpperCase() + id.slice(1),
      kind: id === 'labels' ? 'labels' : id === 'assignee' ? 'user' : 'text', required: false, editable: false, options: [],
      sortable: ['updated', 'created', 'priority', 'key', 'summary'].includes(id),
      groupable: ['assignee', 'issuetype', 'status'].includes(id),
      filterable: ['project', 'status', 'assignee', 'labels', 'issuetype', 'priority'].includes(id),
    })).concat({ id: 'duedate', name: 'Due date', kind: 'date', required: false, editable: false, options: [], sortable: false, groupable: false, filterable: false }),


    boards: (options.boards ?? []).map((b) => ({ id: String(b.id), name: b.name, fieldId: 'status', columns: [] })),
    savedFilters: presets.map((p) => ({ id: p.id, name: p.name, query: { ...emptyQuery, savedFilterId: p.id } })),
    async verify() { return request(`${api}/myself`); },
    async list(query) { const page = await search(client, query); return { items: page.issues.map(toItem), nextCursor: page.nextCursor, ...(page.total === undefined ? {} : { total: page.total }) }; },
    async grouped(query) {
      const page = await this.list(query);
      const groups = new Map();
      for (const item of page.items) {
        const id = query.groupBy === 'assignee' ? item.assignees[0]?.id ?? '' : query.groupBy === 'issuetype' ? item.itemType : item.state.id;
        const name = query.groupBy === 'assignee' ? item.assignees[0]?.name ?? 'Unassigned' : query.groupBy === 'issuetype' ? item.itemType : item.state.name;
        if (!groups.has(id)) groups.set(id, { id, name, items: [] });
        groups.get(id).items.push(item);
      }
      return { groups: [...groups.values()], nextCursor: page.nextCursor };
    },
    // Jira user fields hold one user; a multi-user picker is an array field and never reaches this kind.
    singleUser: () => true,
    async lookupUsers(fieldId, query) {
      if (!query.trim()) return [];
      const params = new URLSearchParams({ [cloud ? 'query' : 'username']: query.trim(), maxResults: '50' });
      if (fieldId === 'assignee') params.set('project', options.projectId);
      const path = fieldId === 'assignee' ? 'user/assignable/search' : 'user/search';
      const users = await request(`${api}/${path}?${params}`);
      if (!Array.isArray(users)) throw new Error('Invalid Jira user search response');
      return users.filter((u) => u.active !== false).map((u) => ({ id: cloud ? u.accountId : u.name, name: u.displayName ?? u.name })).filter((u) => u.id);
    },
    detail, comments, act, createFields, board: boards.board, resolveUrl,
  };
}
