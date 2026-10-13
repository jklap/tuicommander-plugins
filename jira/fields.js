import { fieldSchema } from './model.js';

export function creationPort(client, projectId) {
  return async function createFields(itemType) {
    if (!projectId) throw new Error('Jira project is required');
    const base = `${client.api}/issue/createmeta/${encodeURIComponent(projectId)}/issuetypes`;
    if (!itemType) {
      const types = []; let start = 0;
      for (;;) {
        const page = await client.request(`${base}?startAt=${start}&maxResults=100`);
        const batch = page.issueTypes ?? page.values;
        if (!Array.isArray(batch)) throw new Error('Invalid Jira issue type response');
        types.push(...batch.map((t) => ({ id: String(t.id), name: t.name }))); start += batch.length;
        if (page.isLast === true || !batch.length || start >= page.total || (page.total == null && page.isLast == null)) break;
      }
      return [{ id: 'itemType', name: 'Issue type', kind: 'enum', required: true, editable: true, options: types }];
    }
    const fields = []; let start = 0;
    for (;;) {
      const page = await client.request(`${base}/${encodeURIComponent(itemType)}?startAt=${start}&maxResults=100`);
      const batch = page.fields ?? page.values;
      if (!Array.isArray(batch)) throw new Error('Invalid Jira create metadata response');
      fields.push(...batch.map(fieldSchema)); start += batch.length;
      if (page.isLast === true || !batch.length || start >= page.total || (page.total == null && page.isLast == null)) break;
    }
    // Title and body are fixed form inputs, not schema fields.
    return fields.filter((f) => f.id !== 'summary' && f.id !== 'description' && f.id !== 'project' && f.id !== 'issuetype');
  };
}
