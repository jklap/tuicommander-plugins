import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createGitLabProvider } from './provider.js';
import { cleanTrace } from './pipelines.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/unrecorded.json', import.meta.url), 'utf8'));
const account = { id: 'work', provider: 'gitlab', host: 'https://gitlab.example.invalid:8443', label: 'Work', login: 'root' };
const issueRef = { providerId: 'gitlab', accountId: 'work', id: 'demo/widgets#12' };
const mrRef = { providerId: 'gitlab', accountId: 'work', id: 'demo/widgets!7' };
const query = { filters: [], savedFilterId: null, search: '', sort: null, groupBy: null, cursor: null, limit: 20 };
const ok = (json, headers = {}) => ({ status: 200, headers, json: structuredClone(json) });
const P = '/api/v4/projects/demo%2Fwidgets';

/** Routes by method + path. `extra` answers first; an unknown request fails the test. */
function gitlab(extra, requests = []) {
  return async (req) => {
    requests.push(req);
    const answer = await extra?.(req);
    if (answer) return answer;
    const url = new URL(req.url);
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    const table = {
      [`GET ${P}/issues/12`]: fixture.issue, [`GET ${P}/merge_requests/7`]: fixture.mr,
      [`GET ${P}/issues/12/discussions`]: fixture.discussions, [`GET ${P}/merge_requests/7/discussions`]: fixture.discussions,
      [`GET ${P}/labels`]: fixture.labels, [`GET ${P}/members/all`]: fixture.members,
      [`GET ${P}/merge_requests/7/approvals`]: fixture.approvals, [`GET ${P}`]: fixture.project,
      [`GET ${P}/merge_requests/7/pipelines`]: fixture.pipelines, [`GET ${P}/pipelines/31/jobs`]: fixture.jobs,
      [`GET ${P}/boards/5`]: fixture.board, [`GET /api/v4/issues`]: [fixture.issue], [`GET ${P}/issues`]: [fixture.issue],
    };
    if (route in table) return ok(table[route]);
    if (req.method === 'PUT' || req.method === 'POST') return ok({ iid: 12 });
    throw new Error(`Unexpected fixture request: ${route}`);
  };
}

// Catches: account bound to the wrong instance — a hostname-only comparison sends
// the port-8443 account's requests and pasted URLs to the default-port instance.
test('self_hosted_port_is_part_of_host_identity', async () => {
  const requests = [];
  const onPort = createGitLabProvider({ account, fetch: gitlab(null, requests) });
  const onDefault = createGitLabProvider({ account: { ...account, id: 'home', host: 'https://gitlab.example.invalid' }, fetch: gitlab() });
  const underRoot = createGitLabProvider({ account: { ...account, id: 'root', host: 'https://gitlab.example.invalid:8443/gitlab' }, fetch: gitlab() });
  const pasted = 'https://gitlab.example.invalid:8443/demo/widgets/-/merge_requests/7/diffs';
  assert.deepEqual(onPort.resolveUrl(pasted), mrRef);
  assert.equal(onDefault.resolveUrl(pasted), null);
  assert.equal(onDefault.resolveUrl('http://gitlab.example.invalid/demo/widgets/-/issues/12'), null);
  assert.equal(underRoot.resolveUrl(pasted), null);
  assert.deepEqual(underRoot.resolveUrl('https://gitlab.example.invalid:8443/gitlab/demo/widgets/-/issues/12').id, 'demo/widgets#12');
  assert.deepEqual(onPort.resolveUrl('https://gitlab.example.invalid:8443/demo/widgets/-/work_items/12').id, 'demo/widgets#12');
  await onPort.detail(issueRef);
  assert.ok(requests.every((r) => new URL(r.url).origin === 'https://gitlab.example.invalid:8443'));
  await assert.rejects(onDefault.detail(issueRef), /another account/);
});

function mergeProvider(mr, requests, answer) {
  return createGitLabProvider({ account, fetch: gitlab((req) => {
    if (req.url.endsWith('/merge_requests/7')) return ok({ ...fixture.mr, ...mr });
    return answer?.(req);
  }, requests) });
}

// Catches: default method always used — the chosen squash/merge never reaches GitLab,
// or the merge is not pinned to the head the user reviewed.
test('merge_method_sent_as_chosen', async () => {
  for (const [method, squash] of [['squash', true], ['merge', false]]) {
    const requests = [];
    const provider = mergeProvider({}, requests);
    const { actions } = await provider.detail(mrRef);
    const chosen = actions.find((a) => a.id.startsWith(`merge:${method}:`));
    assert.equal(chosen.enabled, true);
    await provider.act(mrRef, { kind: 'transition', value: chosen.id });
    const write = requests.find((r) => r.method === 'PUT');
    assert.equal(new URL(write.url).pathname, `${P}/merge_requests/7/merge`);
    assert.deepEqual(write.body, { squash, sha: fixture.mr.diff_refs.head_sha });
  }
});

// Catches: a merge choice offered while GitLab will refuse it, with the raw status code
// (or nothing) instead of the reason.
test('merge_blockers_are_readable_and_disable_merge', async () => {
  const blocked = await mergeProvider({ detailed_merge_status: 'discussions_not_resolved' }, []).detail(mrRef);
  const merges = blocked.actions.filter((a) => a.id.startsWith('merge:'));
  assert.equal(merges.length, 2);
  assert.ok(merges.every((a) => !a.enabled && a.disabledReason === 'All threads must be resolved'));
  assert.equal(blocked.item.fields.merge_status.value, 'All threads must be resolved');
  const forbidden = await createGitLabProvider({ account, fetch: gitlab((req) => (new URL(req.url).pathname === P ? ok({ ...fixture.project, squash_option: 'never' }) : null)) }).detail(mrRef);
  assert.equal(forbidden.actions.find((a) => a.id.startsWith('merge:squash:')).disabledReason, 'The project does not allow squashing');
  const merged = await mergeProvider({ state: 'merged' }, []).detail(mrRef);
  assert.equal(merged.actions.some((a) => a.id.startsWith('merge:')), false);
});

// Catches: a push after review merges unreviewed commits, or the 409 surfaces as a bare code.
test('stale_head_merge_is_refused_with_a_reason', async () => {
  const provider = mergeProvider({}, [], (req) => (req.method === 'PUT' ? { status: 409, headers: {}, json: { message: 'SHA does not match HEAD of source branch: private' } } : null));
  const { actions } = await provider.detail(mrRef);
  await assert.rejects(provider.act(mrRef, { kind: 'transition', value: actions[1].id }), (e) => e.status === 409 && /changed since you loaded it/.test(e.message) && !/private/.test(e.message));
});

// Catches: move without list label swap, or a move that rewrites the whole label set.
test('board_move_changes_label', async () => {
  const requests = [];
  const provider = createGitLabProvider({ account, project: 'demo/widgets', fetch: gitlab(null, requests) });
  const page = await provider.board('5', query);
  assert.deepEqual(page.board.columns.map((c) => c.name), ['Open', 'To Do', 'Doing', 'Closed']);
  const open = requests.find((r) => new URL(r.url).searchParams.has('not[labels]'));
  assert.equal(new URL(open.url).searchParams.get('not[labels]'), 'To Do,Doing');
  const card = page.lanes.find((l) => l.columnId === '11').cards[0];
  await provider.act(card.item.reference, card.moves.find((m) => m.columnId === '12').action);
  const write = requests.find((r) => r.method === 'PUT');
  assert.equal(new URL(write.url).pathname, `${P}/issues/12`);
  assert.deepEqual(write.body, { add_labels: 'Doing', remove_labels: 'To Do' });
  await provider.act(card.item.reference, card.moves.find((m) => m.columnId === 'closed').action);
  assert.deepEqual(requests.filter((r) => r.method === 'PUT')[1].body, { remove_labels: 'To Do', state_event: 'close' });
});

// Catches: sort and label filter dropped, or only the first page reachable.
test('list_maps_filters_sort_and_pagination', async () => {
  const requests = [];
  const provider = createGitLabProvider({ account, fetch: gitlab((req) => (req.url.includes('/issues?') ? ok([fixture.issue], { 'X-Next-Page': '3' }) : null), requests) });
  const page = await provider.list({ ...query, cursor: '2', sort: { fieldId: 'created', descending: false },
    filters: [{ fieldId: 'labels', values: [{ kind: 'labels', value: [{ id: 'bug', name: 'bug' }] }] }, { fieldId: 'assignee', values: [{ kind: 'user', value: [{ id: '@root', name: 'root', avatarUrl: null }] }] }] });
  const params = new URL(requests[0].url).searchParams;
  assert.deepEqual(Object.fromEntries(params), { labels: 'bug', assignee_username: 'root', order_by: 'created_at', sort: 'asc', per_page: '20', page: '2', state: 'opened', scope: 'all' });
  assert.equal(page.nextCursor, '3');
  assert.equal(page.items[0].key, 'widgets#12');
  await assert.rejects(provider.list({ ...query, sort: { fieldId: 'labels', descending: false } }), /cannot sort/);
});

// Catches: the review-requests and to-do presets ignored, or a Commit to-do crashing the list.
test('presets_select_scope_reviewer_and_todos', async () => {
  const requests = [];
  const todos = structuredClone(fixture.todos);
  todos[0].target = fixture.issue;
  const provider = createGitLabProvider({ account, fetch: gitlab((req) => (req.url.includes('/todos?') ? ok(todos) : req.url.includes('/merge_requests?') ? ok([fixture.mr]) : null), requests) });
  const review = provider.savedFilters.find((f) => f.id === 'review-mrs');
  const mrs = await provider.list(review.query);
  assert.equal(new URL(requests[0].url).searchParams.get('reviewer_username'), 'root');
  assert.equal(mrs.items[0].itemType, 'merge_request');
  const page = await provider.list(provider.savedFilters.find((f) => f.id === 'todos').query);
  assert.deepEqual(page.items.map((i) => i.reference.id), ['demo/widgets#12']);
});

// Catches: GitLab activity ("added ~bug label") shown as conversation, or diff threads
// losing their resolved state.
test('comments_drop_system_notes_and_keep_review_threads', async () => {
  const page = await createGitLabProvider({ account, fetch: gitlab() }).comments(mrRef, null, 20);
  assert.deepEqual(page.entries.map((e) => e.kind), ['normal', 'review_thread']);
  assert.match(page.entries[0].value.body, /<details>/);
  const thread = page.entries[1].value;
  assert.deepEqual([thread.resolved, thread.path, thread.line, thread.comments.length], [false, 'src/login.js', 14, 2]);
});

// Catches: create sends only title and body, losing labels and assignees.
test('create_sends_labels_and_assignees', async () => {
  const requests = [];
  const provider = createGitLabProvider({ account, project: 'demo/widgets', fetch: gitlab(null, requests) });
  await provider.act(null, { kind: 'create', value: { title: 'New', body: 'Text', itemType: 'issue', fields: {
    labels: { kind: 'labels', value: [{ id: 'bug', name: 'bug' }, { id: 'To Do', name: 'To Do' }] },
    assignees: { kind: 'user', value: [{ id: '2', name: 'Dev User', avatarUrl: null }] },
  } } });
  const write = requests.find((r) => r.method === 'POST');
  assert.equal(new URL(write.url).pathname, `${P}/issues`);
  assert.deepEqual(write.body, { title: 'New', description: 'Text', labels: 'bug,To Do', assignee_ids: [2] });
});

// Catches: the create form without a type picker, or Title/Body duplicated as schema fields.
test('create_fields_list_types_then_typed_fields', async () => {
  const provider = createGitLabProvider({ account, project: 'demo/widgets', fetch: gitlab() });
  const [type, ...rest] = await provider.createFields();
  assert.deepEqual([type.id, type.kind, type.options.map((o) => o.id), rest.length], ['itemType', 'enum', ['issue'], 0]);
  const typed = await provider.createFields('issue');
  assert.deepEqual(typed.map((f) => f.id), ['labels', 'assignees', 'due']);
  assert.deepEqual(typed[0].options.map((o) => o.id), ['To Do', 'Doing', 'bug']);
  await assert.rejects(provider.createFields('merge_request'), /issues only/);
});

// Catches: retry endpoints swapped (job id sent to the pipeline route) or retry offered
// for a green pipeline.
test('pipeline_and_job_retry_target_the_failed_run', async () => {
  const requests = [];
  const provider = createGitLabProvider({ account, fetch: gitlab(null, requests) });
  const { actions, item } = await provider.detail(mrRef);
  assert.deepEqual(actions.filter((a) => /retry/.test(a.id)).map((a) => a.id), ['pipeline:retry:31', 'job:retry:101']);
  assert.match(item.fields.jobs.value, /\| test \| \[unit\]\(.*\/jobs\/101\) \| failed \|/);
  await provider.act(mrRef, { kind: 'transition', value: 'job:retry:101' });
  assert.equal(new URL(requests.find((r) => r.method === 'POST').url).pathname, `${P}/jobs/101/retry`);
});

// Catches: terminal colour codes and folding markers left in a job log.
test('job_trace_is_plain_text', async () => {
  const provider = createGitLabProvider({ account, fetch: async (req) => ({ status: 200, headers: {}, json: null, text: req.url.endsWith('/jobs/101/trace') ? fixture.trace : '' }) });
  const trace = await provider.jobTrace(mrRef, 101);
  assert.equal(trace, 'Running with gitlab-runner 17.4.0\nExecuting "step_script" stage\n$ npm test\nFAIL login.test.js\nERROR: Job failed: exit code 1\n');
  assert.equal(cleanTrace('x'.repeat(300 * 1024)).length, 256 * 1024);
  await assert.rejects(provider.jobTrace(issueRef, 101), /merge request/);
});

// Catches: a retry storm against an instance that answered 429.
test('retry_after_honored', async () => {
  let clock = 50_000; let calls = 0;
  const provider = createGitLabProvider({ account, now: () => clock, fetch: async () => {
    calls++;
    return calls === 1 ? { status: 429, headers: { 'Retry-After': '20' }, json: null } : ok([]);
  } });
  await assert.rejects(provider.list(query), (e) => e.status === 429 && e.retryAfterMs === 20_000);
  clock += 19_999;
  await assert.rejects(provider.list(query), (e) => e.retryAfterMs === 1);
  assert.equal(calls, 1);
  clock++;
  assert.deepEqual(await provider.list(query), { items: [], nextCursor: null });
});

// Catches: a direct item lookup for `!7` or a pasted URL replaced by a text search.
test('search_by_reference_opens_the_item', async () => {
  const requests = [];
  const provider = createGitLabProvider({ account, project: 'demo/widgets', fetch: gitlab(null, requests) });
  const page = await provider.list({ ...query, search: '!7' });
  assert.equal(page.items[0].reference.id, 'demo/widgets!7');
  assert.equal(new URL(requests[0].url).pathname, `${P}/merge_requests/7`);
  assert.deepEqual(provider.resolveReference('demo/widgets#12'), issueRef);
  assert.equal(provider.resolveReference('../etc#1'), null);
});
