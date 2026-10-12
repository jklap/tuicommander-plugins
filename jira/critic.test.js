import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createJiraProvider } from './provider.js';

const account = { id: 'a', host: 'https://x.atlassian.net', kind: 'basic', provider: 'jira' };
const query = (over = {}) => ({ filters: [], savedFilterId: null, search: '', sort: null, cursor: null, limit: 50, groupBy: null, ...over });
const issue = { key: 'ABC-1', fields: { summary: 's', status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } } } };
const ok = (json) => ({ status: 200, headers: {}, json });

function provider(handler) {
  const jqls = [];
  const fetch = async (req) => {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (body?.jql) jqls.push(body.jql);
    return handler(req.url, body) ?? ok({});
  };
  return { jira: createJiraProvider({ account, fetch }), jqls };
}

test('critic: Data Center cannot verify through a v3-only manifest path', () => {
  // catches: DC Bearer login verified against /rest/api/3/myself, which DC does not serve (404)
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.providers[0].verify.path, '/rest/api/2/myself');
});

test('critic: key-shaped search for a missing issue falls back to text search', async () => {
  // catches: typing "SHA-256" or a mistyped key shows a 400 error instead of results
  const { jira } = provider((url, body) => {
    if (!url.endsWith('/search/jql')) return null;
    if (body.jql.includes('text ~')) return ok({ issues: [issue], isLast: true });
    return { status: 400, headers: {}, json: {} };
  });
  const page = await jira.list(query({ search: 'SHA-256' }));
  assert.equal(page.items.length, 1);
});

function boardHandler(url, body) {
  if (url.endsWith('/configuration')) return ok({ id: 1, name: 'B', filter: { id: '10' }, columnConfig: { columns: [{ name: 'To Do', statuses: [{ id: '1' }] }] } });
  if (url.endsWith('/search/jql')) {
    if (body.jql.includes('login bug') && !body.jql.includes('text ~')) return { status: 400, headers: {}, json: {} };
    return ok({ issues: [issue], isLast: true });
  }
  if (url.endsWith('/transitions')) return ok({ transitions: [] });
  return null;
}

test('critic: board plain-text search falls back to text search like the list does', { skip: 'finding 3 moved to a story by coordinator (orc-1)' }, async () => {
  // catches: board search box shows a 400 error for any non-JQL text
  const { jira } = provider(boardHandler);
  const result = await jira.board('1', query({ search: 'login bug' }));
  assert.equal(result.lanes[0].cards.length, 1);
});

test('critic: board honors the selected preset', async () => {
  // catches: preset ignored on boards, so "Assigned to me" shows every card
  const { jira, jqls } = provider(boardHandler);
  await jira.board('1', query({ savedFilterId: 'assigned' }));
  assert.ok(jqls.some((j) => j.includes('currentUser()')), jqls.join('\n'));
});
