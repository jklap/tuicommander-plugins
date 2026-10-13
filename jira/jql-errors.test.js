import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createJiraProvider } from './provider.js';

const live = JSON.parse(readFileSync(new URL('./fixtures/malformed-jql-live.json', import.meta.url), 'utf8'));
const issue = JSON.parse(readFileSync(new URL('./fixtures/cloud.json', import.meta.url), 'utf8')).issue;
const account = { id: 'review', host: 'https://jira.example.invalid', kind: 'basic' };
const query = { filters: [], savedFilterId: null, sort: null, cursor: null, limit: 100, groupBy: null };

// Catches: a Jira parse error silently becomes unrelated text-search results.
test('malformed_explicit_or_intended_jql_keeps_live_parse_error', async () => {
  for (const input of ['project =', 'jql: project =']) {
    const requests = [];
    const provider = createJiraProvider({ account, fetch: async (request) => {
      requests.push(request);
      return requests.length === 1 ? structuredClone(live.response) : { status: 200, json: { issues: [issue], isLast: true } };
    } });
    await assert.rejects(provider.list({ ...query, search: input }), (error) => {
      assert.equal(error.status, 400);
      assert.ok(error.message.includes(live.response.json.errorMessages[0]));
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.jql, live.request.jql);
  }
});

// Catches: an explicit search mode is discarded, or keys and saved filters become literal text.
test('text_key_valid_jql_and_saved_filter_keep_query_semantics', async () => {
  const cases = [
    ['text: project =', '(text ~ "project =") ORDER BY updated DESC'],
    ['text: order by "name"', String.raw`(text ~ "order by \"name\"") ORDER BY updated DESC`],
    ['lan-23350', '(key = "LAN-23350") ORDER BY updated DESC'],
    ['project = AITR', '(project = AITR) ORDER BY updated DESC'],
    ['jql: project = AITR', '(project = AITR) ORDER BY updated DESC'],
    ['filter = 28712', '(filter = 28712) ORDER BY updated DESC'],
    ['jql: filter = 28712 ORDER BY key ASC', '(filter = 28712) ORDER BY key ASC'],
  ];
  for (const [search, jql] of cases) {
    const requests = [];
    const provider = createJiraProvider({ account, fetch: async (req) => {
      requests.push(req);
      return { status: 200, json: { issues: [issue], nextPageToken: 'next' } };
    } });
    const page = await provider.list({ ...query, search });
    assert.equal(page.items[0].key, issue.key);
    assert.equal(page.nextCursor, 'next');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.jql, jql);
  }
});

// Catches: boards bypass the list's JQL guard and retry malformed predicates as text.
test('board_malformed_jql_preserves_error_and_board_scope', async () => {
  for (const search of ['project =', 'jql: project =']) {
    const searches = [];
    const provider = createJiraProvider({ account, fetch: async (req) => {
      if (req.url.endsWith('/configuration')) return { status: 200, json: {
        id: 1, name: 'Board', filter: { id: '28712' }, columnConfig: { columns: [] },
      } };
      searches.push(req);
      return searches.length === 1 ? structuredClone(live.response) : { status: 200, json: { issues: [], isLast: true } };
    } });
    await assert.rejects(provider.board('1', { ...query, search }), /Expecting either a value/);
    assert.equal(searches.length, 1);
    assert.equal(searches[0].body.jql, '(filter = 28712 AND ((project =))) ORDER BY updated DESC');
  }
});

// Catches: a failed explicit text query retries as JQL, or DC drops the parse failure.
test('explicit_text_does_not_retry_and_dc_keeps_parse_error', async () => {
  for (const kind of ['basic', 'bearer']) {
    for (const search of ['text: project =', 'jql: project =']) {
      const requests = [];
      const provider = createJiraProvider({ account: { ...account, kind }, fetch: async (req) => {
        requests.push(req);
        return structuredClone(live.response);
      } });
      await assert.rejects(provider.list({ ...query, search }), /Expecting either a value/);
      assert.equal(requests.length, 1);
      assert.equal(new URL(requests[0].url).pathname, kind === 'basic' ? '/rest/api/3/search/jql' : '/rest/api/2/search');
    }
  }
});
