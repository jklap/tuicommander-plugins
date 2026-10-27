import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createJiraProvider } from './provider.js';
import { adfToMarkdown, markdownToAdf } from './adf.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cloud.json', import.meta.url), 'utf8'));
const account = { id: 'recorded-cloud', host: fixture.provenance.source, kind: 'basic' };
const ref = { providerId: 'jira', accountId: account.id, id: fixture.issue.key };
const query = { search: 'project = TUIC', filters: [], savedFilterId: null, sort: null, cursor: null, limit: 1 };
const ok = (json) => ({ status: 200, headers: {}, json: structuredClone(json) });

// Catches: real Cloud page tokens or a real JQL error body prevent text fallback.
test('recorded_cloud_search_pages_and_jql_error_keep_results', async () => {
  const requests = [];
  const provider = createJiraProvider({ account, fetch: async (request) => {
    requests.push(request);
    return ok(fixture.searchPages[request.body.nextPageToken ? 1 : 0]);
  } });
  const first = await provider.list(query);
  const second = await provider.list({ ...query, cursor: first.nextCursor });
  assert.equal(first.items[0].key, 'TUIC-1');
  assert.equal(second.items[0].key, 'TUIC-2');
  assert.equal(requests[1].body.nextPageToken, fixture.searchPages[0].nextPageToken);
  let calls = 0;
  const fallback = createJiraProvider({ account, fetch: async () => ++calls === 1
    ? { status: 400, headers: {}, json: fixture.jqlError }
    : ok(fixture.searchPages[0]) });
  assert.equal((await fallback.list({ ...query, search: 'Preserve code' })).items[0].key, 'TUIC-1');
  assert.equal(calls, 2);
});

// Catches: independent comment pagination is replaced with embedded issue comments.
test('recorded_cloud_detail_and_comment_pages_keep_adf_and_cursor', async () => {
  const provider = createJiraProvider({ account, fetch: async (request) => {
    if (request.url.includes('/transitions')) return ok(fixture.transitions);
    if (request.url.includes('/comment')) return ok(fixture.commentPages[new URL(request.url).searchParams.get('startAt') === '1' ? 1 : 0]);
    return ok(fixture.issue);
  } });
  const detail = await provider.detail(ref);
  assert.equal(detail.item.title, 'Preserve code and lists');
  assert.equal(detail.comments.entries[0].value.body, 'Ready for review');
  assert.equal(detail.comments.nextCursor, '1');
  const next = await provider.comments(ref, detail.comments.nextCursor, 1);
  assert.equal(next.entries[0].value.body, 'Second comment with hard  \nbreak');
  assert.equal(next.nextCursor, null);
  assert.deepEqual(markdownToAdf(detail.body), fixture.issue.fields.description);
  assert.equal(adfToMarkdown(fixture.issue.fields.description), 'Steps\n\n- First\n- Second\n\n```js\nconst n = 1;\n```');
});

// Catches: recorded status IDs are written instead of Jira workflow transition IDs.
test('recorded_cloud_board_moves_use_the_real_transition_not_status', async () => {
  let write;
  const provider = createJiraProvider({ account, fetch: async (request) => {
    if (request.url.includes('/configuration')) return ok(fixture.board);
    if (request.url.includes('/search')) return ok(fixture.searchPages[0]);
    if (request.url.includes('/transitions')) {
      if (request.method === 'POST') { write = request.body; return { status: 204, headers: {} }; }
      return ok(fixture.transitions);
    }
    if (request.url.includes('/comment')) return ok(fixture.comments);
    return ok(fixture.issue);
  } });
  const board = await provider.board(String(fixture.board.id), query);
  const card = board.lanes.flatMap((lane) => lane.cards)[0];
  const done = board.board.columns.find((column) => column.name === 'Done');
  const move = card.moves.find((candidate) => candidate.columnId === done.id);
  assert.equal(move.action.value, '31');
  assert.notEqual(move.action.value, '10005');
  await provider.act(ref, move.action);
  assert.deepEqual(write, { transition: { id: '31' } });
});

// Catches: real create metadata fields are dropped or the configured project is not sent.
test('recorded_cloud_create_metadata_builds_an_accepted_project_shape', async () => {
  let write;
  const provider = createJiraProvider({ account, projectId: '10001', fetch: async (request) => {
    if (request.url.includes('/createmeta/')) return ok(request.url.includes('/issuetypes/') ? fixture.createmeta : fixture.issueTypes);
    if (request.url.endsWith('/issue')) { write = request.body; return { status: 201, headers: {}, json: fixture.create }; }
    if (request.url.includes('/transitions')) return ok(fixture.transitions);
    if (request.url.includes('/comment')) return ok(fixture.comments);
    return ok(fixture.issue);
  } });
  const types = await provider.createFields();
  assert.ok(types[0].options.some((type) => type.id === '10006' && type.name === 'Task'));
  const fields = await provider.createFields('10006');
  assert.ok(fields.some((field) => field.id === 'assignee'));
  assert.ok(fields.some((field) => field.id === 'priority'));
  const result = await provider.act(null, { kind: 'create', value: { title: 'Preserve code and lists', body: adfToMarkdown(fixture.issue.fields.description), itemType: '10006', fields: {} } });
  assert.equal(result.value.item.key, 'TUIC-1');
  assert.deepEqual(write.fields.project, { id: '10001' });
  assert.deepEqual(write.fields.issuetype, { id: '10006' });
  assert.deepEqual(write.fields.description, fixture.issue.fields.description);
});
