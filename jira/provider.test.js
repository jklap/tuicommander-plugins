import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createJiraProvider } from './provider.js';
import { adfToMarkdown, markdownToAdf } from './adf.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cloud.json', import.meta.url), 'utf8'));
const account = { id: 'site-one', host: 'https://jira.example.invalid', kind: 'basic' };
const ref = { providerId: 'jira', accountId: 'site-one', id: 'DEMO-7' };
const query = { search: '', filters: [], savedFilterId: null, sort: null, cursor: null, limit: 25 };
const ok = (json) => ({ status: 200, headers: {}, json: structuredClone(json) });
function fixtureFetch(extra) {
  return async (req) => {
    const response = await extra?.(req);
    if (response) return response;
    if (req.url.includes('/search')) return ok({ issues: [fixture.issue], isLast: true });
    if (req.url.includes('/transitions')) return ok(fixture.transitions);
    if (req.url.includes('/comment')) return ok(fixture.comments);
    if (req.url.includes('/configuration')) return ok(fixture.board);
    if (req.url.includes('/createmeta/')) return ok(fixture.createmeta);
    if (req.url.includes('/issue/DEMO-7')) return ok(fixture.issue);
    throw new Error(`Unexpected fixture request: ${req.method} ${req.url}`);
  };
}

// Catches: a free-text query rejected as JQL aborts instead of falling back.
test('jql_400_falls_back_to_text_search', async () => {
  const requests = [];
  const provider = createJiraProvider({ account, fetch: async (req) => {
    requests.push(req);
    return requests.length === 1 ? { status: 400 } : ok({ issues: [fixture.issue], isLast: true });
  } });
  const page = await provider.list({ ...query, search: 'broken "query"' });
  assert.equal(page.items[0].title, 'Preserve code and lists');
  assert.equal(requests[1].body.jql, String.raw`(text ~ "broken \"query\"") ORDER BY updated DESC`);
  assert.equal(new URL(requests[1].url).pathname, '/rest/api/3/search/jql');
});

// Catches: board action writes a status ID where Jira requires a transition ID.
test('board_move_uses_transition_id', async () => {
  let write;
  const provider = createJiraProvider({ account, fetch: fixtureFetch((req) => {
    if (req.method === 'POST' && req.url.endsWith('/transitions')) { write = req; return ok(null); }
  }) });
  const board = await provider.board('42', query);
  await provider.act(ref, board.lanes[1].cards[0].moves.find((m) => m.columnId === '2').action);
  assert.equal(new URL(write.url).pathname, '/rest/api/3/issue/DEMO-7/transitions');
  assert.deepEqual(write.body, { transition: { id: '91' } });
});

// Catches: conversion flattens list items or turns code into paragraphs.
test('adf_roundtrip_keeps_lists_and_code', () => {
  const markdown = adfToMarkdown(fixture.issue.fields.description);
  assert.equal(markdown, 'Steps\n\n- First\n- Second\n\n```js\nconst n = 1;\n```');
  assert.deepEqual(markdownToAdf(markdown), fixture.issue.fields.description);
  const nested = '- Parent\n  - Child\n\n3. Third\n4. Fourth\n\n```js\n``` inside\n```';
  const parsed = markdownToAdf(nested);
  assert.equal(parsed.content[0].content[0].content[1].type, 'bulletList');
  assert.equal(parsed.content[1].attrs.order, 3);
});

// Catches: immediate re-fetch after 429 ignores an account's Retry-After.
test('retry_after_honored', async () => {
  let clock = 100_000; let calls = 0;
  const provider = createJiraProvider({ account, now: () => clock, fetch: async () => {
    calls++;
    return calls === 1 ? { status: 429, headers: { 'Retry-After': '30' } } : ok({ issues: [], isLast: true });
  } });
  await assert.rejects(provider.list(query), (e) => e.status === 429 && e.retryAfterMs === 30_000);
  clock += 29_999;
  await assert.rejects(provider.list(query), (e) => e.retryAfterMs === 1);
  assert.equal(calls, 1);
  clock++;
  assert.deepEqual(await provider.list(query), { items: [], nextCursor: null });
});

// Catches: Cloud cursors use startAt and Data Center URLs lose a context path.
test('cloud_and_dc_preserve_site_and_pagination_contracts', async () => {
  const requests = [];
  const cloud = createJiraProvider({ account, fetch: async (req) => { requests.push(req); return ok({ issues: [fixture.issue], nextPageToken: 'opaque+token' }); } });
  const page = await cloud.list({ ...query, search: 'demo-7' });
  assert.equal(page.nextCursor, 'opaque+token');
  await cloud.list({ ...query, cursor: page.nextCursor });
  assert.equal(requests[0].body.jql, '(key = "DEMO-7") ORDER BY updated DESC');
  assert.equal(requests[1].body.nextPageToken, 'opaque+token');
  const dc = createJiraProvider({ account: { ...account, host: 'https://dc.example.invalid/jira', kind: 'bearer' }, fetch: async (req) => { requests.push(req); return ok({ issues: [fixture.issue], startAt: 25, total: 99 }); } });
  assert.equal((await dc.list({ ...query, cursor: '25' })).nextCursor, '26');
  assert.equal(requests.at(-1).url, 'https://dc.example.invalid/jira/rest/api/2/search');
  assert.equal(requests.at(-1).body.startAt, 25);
  assert.equal(requests.at(-1).headers['User-Agent'], 'TUICommander-Jira/1.0');
  assert.equal(dc.resolveUrl('https://dc.example.invalid/jira/browse/DEMO-7').id, 'DEMO-7');
  assert.equal(dc.resolveUrl('https://dc.example.invalid/other/browse/DEMO-7'), null);
});

// Catches: a failed query silently falls back on authentication/server errors.
test('non_400_failures_propagate_without_fallback_or_response_body', async () => {
  for (const status of [401, 403, 500]) {
    let calls = 0;
    const provider = createJiraProvider({ account, fetch: async () => { calls++; return { status, json: { message: 'secret echoed by upstream' } }; } });
    await assert.rejects(provider.list({ ...query, search: 'test' }), (e) => e.status === status && !e.message.includes('secret'));
    assert.equal(calls, 1);
  }
});

// Catches: an account-scoped provider sends another site's item to its host.
test('foreign_account_and_unavailable_transition_never_write', async () => {
  let writes = 0;
  const provider = createJiraProvider({ account, fetch: fixtureFetch((req) => { if (req.method !== 'GET') writes++; }) });
  await assert.rejects(provider.detail({ ...ref, accountId: 'other' }), /another account/);
  await assert.rejects(provider.act(ref, { kind: 'transition', value: '5' }), /no longer available/);
  await assert.rejects(provider.act(ref, { kind: 'edit_field', value: { fieldId: 'status', value: { kind: 'enum', value: '5' } } }), /transitions/);
  assert.equal(writes, 0);
});

// Catches: comment pages discard ADF text and create ignores required project/type.
test('detail_comments_and_create_keep_public_work_item_shapes', async () => {
  let created;
  const provider = createJiraProvider({ account, projectId: '10000', fetch: fixtureFetch((req) => {
    if (req.method === 'POST' && req.url.endsWith('/issue')) { created = req.body; return ok({ key: 'DEMO-7' }); }
  }) });
  const detail = await provider.detail(ref);
  assert.equal(detail.comments.entries[0].value.body, 'Ready for review');
  assert.equal(detail.item.reference.accountId, 'site-one');
  assert.equal(detail.item.state.tone, 'info');
  const fields = await provider.createFields('10004');
  assert.deepEqual(fields.map((f) => f.id), ['priority']);
  assert.deepEqual(fields[0].options, [{ id: '2', name: 'High' }]);
  await assert.rejects(provider.act(null, { kind: 'create', value: { title: 'Title', body: '', itemType: '', fields: {} } }), /issue type/);
  const result = await provider.act(null, { kind: 'create', value: { title: 'Title', body: '- First', itemType: '10004', fields: { project: { kind: 'enum', value: '10000' } } } });
  assert.equal(result.value.item.key, 'DEMO-7');
  assert.deepEqual(created.fields.project, { id: '10000' });
  assert.equal(created.fields.description.content[0].type, 'bulletList');
});

// Catches: per-card workflow lookup reuses another item's transition ID.
test('board_resolves_each_cards_transition_and_keeps_empty_lanes', async () => {
  const writes = [];
  const second = structuredClone(fixture.issue); second.key = 'DEMO-8';
  const transitions = { transitions: [{ id: '191', name: 'Finish other workflow', to: { id: '5' } }] };
  const provider = createJiraProvider({ account, fetch: fixtureFetch((req) => {
    if (req.url.includes('/search')) return ok({ issues: [fixture.issue, second], isLast: true });
    if (req.url.includes('/DEMO-8/transitions')) {
      if (req.method === 'POST') { writes.push(req.body); return ok(null); }
      return ok(transitions);
    }
    if (req.url.includes('/DEMO-8/comment')) return ok(fixture.comments);
    if (req.url.includes('/DEMO-8?')) return ok(second);
  }) });
  const page = await provider.board('42', query);
  assert.equal(page.lanes.length, 3);
  assert.equal(page.lanes[0].cards.length, 0);
  assert.equal(page.lanes[1].cards.length, 2);
  assert.deepEqual(page.lanes[1].cards[1].moves, [{ columnId: '2', action: { kind: 'transition', value: '191' } }]);
  await provider.act({ ...ref, id: 'DEMO-8' }, page.lanes[1].cards[1].moves[0].action);
  assert.deepEqual(writes, [{ transition: { id: '191' } }]);
});

// Catches: an HTTP-date rate limit permits retry before the server deadline.
test('retry_after_http_date_blocks_without_replaying_write', async () => {
  let calls = 0; let clock = Date.UTC(2026, 9, 10, 12, 0, 0);
  const provider = createJiraProvider({ account, now: () => clock, fetch: async () => {
    calls++; return { status: 429, headers: { 'retry-after': 'Sat, 10 Oct 2026 12:01:00 GMT' } };
  } });
  await assert.rejects(provider.verify(), (e) => e.retryAfterMs === 60_000);
  clock += 30_000;
  await assert.rejects(provider.verify(), (e) => e.retryAfterMs === 30_000);
  assert.equal(calls, 1);
});

// Catches: type changes reuse the previous type's required fields or stop at page one.
test('create_metadata_pages_and_type_changes_use_selected_issue_type', async () => {
  const requests = [];
  const provider = createJiraProvider({ account, projectId: '10000', fetch: async (req) => {
    requests.push(req.url);
    if (req.url.includes('/issuetypes?')) return ok({ issueTypes: [{ id: '10004', name: 'Task' }], isLast: true });
    if (req.url.includes('/10004?startAt=0')) return ok({ fields: [fixture.createmeta.fields[0]], startAt: 0, total: 2 });
    if (req.url.includes('/10004?startAt=1')) return ok({ fields: [fixture.createmeta.fields[1]], startAt: 1, total: 2 });
    return ok({ fields: [{ fieldId: 'customfield_123', name: 'Risk', required: true, schema: { type: 'string' }, operations: ['set'] }], total: 1 });
  } });
  assert.deepEqual((await provider.createFields())[0].options, [{ id: '10004', name: 'Task' }]);
  assert.deepEqual((await provider.createFields())[0].id, 'itemType');
  assert.deepEqual((await provider.createFields('10004')).map((f) => f.id), ['priority']);
  assert.equal((await provider.createFields('10005'))[0].id, 'customfield_123');
  await assert.rejects(provider.act(null, { kind: 'create', value: { title: 'Title', body: '', itemType: '10005', fields: {} } }), /required field: Risk/);
  assert.equal(requests.some((path) => path.includes('/10004?startAt=1')), true);
});

// Catches: DC comment writes use Cloud ADF, or start-work runs a terminal side effect.
test('dc_comments_use_text_and_start_work_returns_host_intent', async () => {
  let body; let calls = 0;
  const provider = createJiraProvider({ account: { ...account, kind: 'bearer' }, fetch: fixtureFetch((req) => {
    calls++;
    if (req.method === 'POST') { body = req.body; return ok(null); }
    if (req.url.includes('/comment?startAt=1')) return ok({ startAt: 1, total: 3, comments: fixture.comments.comments });
  }) });
  await provider.act(ref, { kind: 'comment', value: 'Plain comment' });
  assert.deepEqual(body, { body: 'Plain comment' });
  assert.equal((await provider.comments(ref, '1', 1)).nextCursor, '2');
  const before = calls;
  const intent = { repoPath: '/repo', branch: 'fix/demo-7', baseRef: null, prompt: 'untrusted text', agentType: null, delivery: 'draft' };
  assert.deepEqual(await provider.act(ref, { kind: 'start_work', value: intent }), { kind: 'start_work', value: intent });
  assert.equal(calls, before);
});

// Catches: inline editing accepts a non-editable field or encodes a text field as an option.
test('editable_field_uses_metadata_and_typed_wire_value', async () => {
  let write;
  const provider = createJiraProvider({ account, fetch: fixtureFetch((req) => {
    if (req.url.endsWith('/editmeta')) return ok(fixture.issue.editmeta);
    if (req.method === 'PUT') { write = req.body; return ok(null); }
  }) });
  await provider.act(ref, { kind: 'edit_field', value: { fieldId: 'summary', value: { kind: 'text', value: 'Changed title' } } });
  assert.deepEqual(write, { fields: { summary: 'Changed title' } });
  await assert.rejects(provider.act(ref, { kind: 'edit_field', value: { fieldId: 'unknown', value: null } }), /not editable/);
});

// Catches: adding a filter after ORDER BY produces invalid JQL, or grouping drops rows.
test('preset_filters_sort_and_group_keep_the_same_account_rows', async () => {
  let body;
  const provider = createJiraProvider({ account, fetch: async (req) => {
    body = req.body; return ok({ issues: [fixture.issue], isLast: true });
  } });
  const groups = await provider.grouped({ ...query, savedFilterId: 'reported', groupBy: 'status', filters: [{ fieldId: 'labels', values: [{ kind: 'labels', value: [{ id: 'integration', name: 'integration' }] }] }], sort: { fieldId: 'priority', descending: false } });
  assert.equal(body.jql, '(reporter = currentUser()) AND (labels IN ("integration")) ORDER BY priority ASC');
  assert.equal(groups.groups[0].name, 'In progress');
  assert.equal(groups.groups[0].items[0].reference.accountId, 'site-one');
});

// Catches: the host offers a query option that this provider rejects (or omits all declarations).
test('declared_query_capabilities_never_offer_rejected_options', async () => {
  const provider = createJiraProvider({ account, fetch: fixtureFetch() });
  const base = { filters: [], savedFilterId: null, search: '', sort: null, groupBy: null, cursor: null, limit: 20 };
  assert.ok(provider.fields.some((f) => f.sortable), 'must expose a supported sort');
  assert.ok(provider.fields.some((f) => f.groupable), 'must expose a supported group');
  assert.ok(provider.fields.some((f) => f.filterable), 'must expose a supported filter');
  for (const field of provider.fields) {
    for (const capability of ['sortable', 'groupable', 'filterable']) assert.equal(typeof field[capability], 'boolean');
    if (field.sortable) await provider.list({ ...base, sort: { fieldId: field.id, descending: false } });
    if (field.groupable) await provider.grouped({ ...base, groupBy: field.id });
    if (field.filterable) {
      const option = field.options[0] ?? { id: 'demo', name: 'demo' };
      const value = field.kind === 'user' ? [{ ...option, avatarUrl: null }] : field.kind === 'labels' ? [option] : field.kind === 'date' ? '2026-10-01' : option.id;
      await provider.list({ ...base, filters: [{ fieldId: field.id, values: [{ kind: field.kind, value }] }] });
    }
  }
});

// Catches: recorded summary/assignee disappear and option names become raw IDs.
test('recorded_detail_retains_summary_assignee_and_option_names', async () => {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/detail-recorded.json', import.meta.url), 'utf8'));
  const provider = createJiraProvider({ account, fetch: async (req) => {
    if (req.url.includes('/transitions')) return ok({ transitions: [] });
    if (req.url.includes('/comment')) return ok({ comments: [], total: 0 });
    return ok(recorded);
  } });
  const detail = await provider.detail({ ...ref, id: recorded.key });
  assert.equal(detail.item.fields.summary?.value, '[private text redacted]');
  assert.equal(detail.item.fields.assignee?.value[0].name, '[user redacted]');
  assert.equal(detail.item.itemType, 'Task');
  assert.deepEqual(detail.item.fields.priority, { kind: 'enum', value: '10000' });
  assert.equal(detail.fields.find((f) => f.id === 'priority').options.find((o) => o.id === '10000').name, '[name redacted]');

});

const recorded = JSON.parse(readFileSync(new URL('./fixtures/recorded-duedate.json', import.meta.url), 'utf8'));
const recordedFetch = () => async (req) => ok(req.body.nextPageToken ? recorded.pages[1] : recorded.pages[0]);

// Catches: the fetched duedate is mapped onto items but never declared, so the host roadmap discards it.
test('due_date_is_declared_as_a_date_field', () => {
  const provider = createJiraProvider({ account, fetch: recordedFetch() });
  const declared = provider.fields.find((f) => f.id === 'duedate');
  assert.equal(declared?.kind, 'date');
  assert.equal(declared?.name, 'Due date');
});

// Catches: the due date is lost on page two or when an undated issue shares a page with dated ones.
test('due_date_maps_on_every_page_and_undated_items_stay', async () => {
  const provider = createJiraProvider({ account, fetch: recordedFetch() });
  const first = await provider.list(query);
  assert.deepEqual(first.items.map((i) => i.fields.duedate ?? null), [{ kind: 'date', value: '2026-10-16' }, null, { kind: 'date', value: '2026-10-04' }]);
  const second = await provider.list({ ...query, cursor: first.nextCursor });
  assert.equal(second.items[0].fields.duedate.value, recorded.pages[1].issues[0].fields.duedate);

});

// Catches: board query composition treats ORDER BY inside a quoted value as sorting.
test('board_search_keeps_order_by_inside_literal_text', async () => {
  for (const [search, expected] of [
    ['text: Please ORDER BY priority', '(filter = 10010 AND ((text ~ "Please ORDER BY priority"))) ORDER BY updated DESC'],
    ['jql: summary ~ "Please ORDER BY priority"', '(filter = 10010 AND ((summary ~ "Please ORDER BY priority"))) ORDER BY updated DESC'],
  ]) {
    let sent;
    const provider = createJiraProvider({ account, fetch: fixtureFetch((req) => {
      if (req.url.includes('/search')) sent = req.body.jql;
    }) });
    await provider.board('42', { ...query, search });
    assert.equal(sent, expected, search);
  }
});

// Catches: an exclamation mark in ordinary prose disables the legacy text fallback.
test('plain_text_with_exclamation_keeps_text_search_fallback', async () => {
  const requests = [];
  const provider = createJiraProvider({ account, fetch: async (req) => {
    requests.push(req);
    return requests.length === 1 ? { status: 400 } : ok({ issues: [fixture.issue], isLast: true });
  } });
  const page = await provider.list({ ...query, search: 'Fix crash!' });
  assert.equal(requests.at(-1).body.jql, '(text ~ "Fix crash!") ORDER BY updated DESC');
  assert.equal(page.items[0].key, 'DEMO-7');

});

// Catches: the filter and group controls label Jira fields with raw JQL ids such as "issuetype".
test('list_fields_have_readable_names', () => {
  const provider = createJiraProvider({ account, fetch: fixtureFetch() });
  assert.deepEqual(provider.fields.map((f) => [f.id, f.name]), [
    ['project', 'Project'], ['status', 'Status'], ['assignee', 'Assignee'],
    ['labels', 'Labels'], ['issuetype', 'Issue type'], ['priority', 'Priority'],
  ]);

});

// Catches: a fabricated Cloud total inferred from rows/cursor, or a real DC total discarded.
test('unknown_cloud_total_and_known_dc_total_keep_their_meaning', async () => {
 for (const kind of ['basic', 'bearer']) {
  const provider = createJiraProvider({ account: { ...account, kind }, fetch: async () => ok(kind === 'basic' ? { issues: [fixture.issue], nextPageToken: 'next' } : { issues: [fixture.issue], startAt: 0, total: 120 }) });
  const result = await provider.list(query);
  assert.equal(result.total, kind === 'basic' ? undefined : 120);
  assert.equal(result.nextCursor, kind === 'basic' ? 'next' : '1');
 }
});

// Catches: Jira settable fields remain unavailable, or empty metadata grants an edit control.
test('detail_declares_edit_field_only_with_settable_metadata', async () => {
 const recorded = JSON.parse(readFileSync(new URL('./fixtures/detail-recorded.json', import.meta.url), 'utf8'));
 for (const editable of [true, false]) {
  const issue = structuredClone(recorded);
  if (!editable) issue.editmeta = { fields: {} };
  const provider = createJiraProvider({ account, fetch: async (req) => {
   if (req.url.includes('/transitions')) return ok({ transitions: [] });
   if (req.url.includes('/comment')) return ok({ comments: [], total: 0 });
   return ok(issue);
  } });
  const detail = await provider.detail({ ...ref, id: issue.key });
  assert.equal(detail.actions.some((a) => a.kind === 'edit_field' && a.enabled), editable);
 }
});

// Catches: list dates and project scope are advertised but discarded, while detail enums must remain editable.
test('list_preserves_recorded_dates_and_project_without_changing_detail_enums', async () => {
 const recorded = JSON.parse(readFileSync(new URL('./fixtures/detail-recorded.json', import.meta.url), 'utf8'));
 const provider = createJiraProvider({ account, fetch: async (req) => {
  assert.ok(req.body.fields.includes('created'));
  assert.ok(req.body.fields.includes('project'));
  return ok({ issues: [recorded], isLast: true });
 } });
 const page = await provider.list(query);
 for (const id of ['created', 'updated']) {
  assert.equal(provider.fields.find((field) => field.id === id).kind, 'date');
  assert.deepEqual(page.items[0].fields[id], recorded.fields[id] ? { kind: 'date', value: recorded.fields[id] } : null);
 }
 assert.equal(page.items[0].fields.project, null);
 assert.deepEqual(page.items[0].fields.status, { kind: 'text', value: String(recorded.fields.status.id) });
 assert.deepEqual(page.items[0].fields.priority, { kind: 'enum', value: '10000' });
});
