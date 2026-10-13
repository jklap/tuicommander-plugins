import { adfToMarkdown } from './adf.js';

export const user = (value) => ({ id: value?.accountId ?? value?.name ?? '', name: value?.displayName ?? 'Unknown', avatarUrl: value?.avatarUrls?.['48x48'] ?? null });
export function issueToItem(issue, account, host) {
  if (!issue?.key || !issue.fields?.summary || !issue.fields?.status?.id) throw new Error('Invalid Jira issue response');
  const f = issue.fields;
  return {
    reference: { providerId: 'jira', accountId: account.id, id: issue.key },
    key: issue.key, title: f.summary, itemType: f.issuetype?.name ?? f.issuetype?.id ?? '',
    state: { id: String(f.status.id), name: f.status.name, tone: f.status.statusCategory?.key === 'done' ? 'success' : f.status.statusCategory?.key === 'indeterminate' ? 'info' : 'neutral' },
    assignees: f.assignee ? [user(f.assignee)] : [],
    labels: (f.labels ?? []).map((name) => ({ id: name, name })),
    updatedAt: f.updated ?? '', url: `${host}/browse/${encodeURIComponent(issue.key)}`,
    fields: {
      summary: { kind: 'text', value: f.summary },
      assignee: { kind: 'user', value: f.assignee ? [user(f.assignee)] : [] },
      labels: { kind: 'labels', value: (f.labels ?? []).map((name) => ({ id: name, name })) },
      ...(f.issuetype ? { issuetype: { kind: 'enum', value: f.issuetype.id } } : {}),
      ...(f.duedate ? { duedate: { kind: 'date', value: f.duedate } } : {}), ...(f.priority ? { priority: { kind: 'enum', value: f.priority.id } } : {}),
    },
  };
}

export function commentPage(page) {
  if (!Array.isArray(page?.comments)) throw new Error('Invalid Jira comment response');
  const end = (page.startAt ?? 0) + page.comments.length;
  return {
    entries: page.comments.map((c) => ({ kind: 'normal', value: { id: String(c.id), author: user(c.author), body: adfToMarkdown(c.body), createdAt: c.created, url: null } })),
    nextCursor: end < page.total && page.comments.length ? String(end) : null,
  };
}

export function fieldSchema(field) {
  const type = field.schema?.type;
  const kind = field.fieldId === 'description' ? 'markdown' : field.allowedValues?.length ? 'enum' : type === 'user' ? 'user' : type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'array' && field.schema.items === 'string' ? 'labels' : 'text';
  return { sortable: false, groupable: false, filterable: false, id: field.fieldId, name: field.name, kind, required: !!field.required, editable: (field.operations ?? ['set']).includes('set'), options: (field.allowedValues ?? []).map((o) => ({ id: String(typeof o === 'string' ? o : o.id ?? o.value ?? o.name), name: typeof o === 'string' ? o : o.name ?? o.value ?? o.displayName })) };
}
