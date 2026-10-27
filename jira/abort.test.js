import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createJiraProvider } from './provider.js';

// Existing response fixtures exercise request composition, not live Jira acceptance.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/cloud-contract.json', import.meta.url), 'utf8'));
const account = { id: 'site-one', host: 'https://jira.example.invalid', kind: 'basic' };
const ref = { providerId: 'jira', accountId: account.id, id: 'DEMO-7' };
const query = { search: '', filters: [], savedFilterId: null, sort: null, cursor: null, limit: 25, groupBy: 'status' };
const ok = (json) => ({ status: 200, headers: {}, json: structuredClone(json) });
function response(req) {
  if (req.url.includes('/user/')) return ok([]);
  if (req.url.includes('/createmeta/')) return ok(req.url.includes('/issuetypes?') ? { issueTypes: [{ id: '10004', name: 'Task' }], isLast: true } : fixture.createmeta);
  if (req.url.includes('/configuration')) return ok(fixture.board);
  if (req.url.includes('/search')) return ok({ issues: [fixture.issue], isLast: true, total: 1 });
  if (req.method !== 'GET') return ok({ key: 'DEMO-7' });
  if (req.url.includes('/transitions')) return ok(fixture.transitions);
  if (req.url.includes('/comment')) return ok(fixture.comments);
  if (req.url.endsWith('/editmeta')) return ok(fixture.issue.editmeta);
  if (req.url.includes('/issue/DEMO-7')) return ok(fixture.issue);
  throw new Error(`Unexpected request: ${req.method} ${req.url}`);
}
const operations = [
  ['list', (p, signal) => p.list(query, signal), 1],
  ['grouped', (p, signal) => p.grouped(query, signal), 1],
  ['board', (p, signal) => p.board('42', query, signal), 3],
  ['createFields', (p, signal) => p.createFields('10004', signal), 1],
  ['createTypes', (p, signal) => p.createFields(undefined, signal), 1],
  ['assignee', (p, signal) => p.lookupUsers('assignee', 'review', signal), 1],
  ['reporter', (p, signal) => p.lookupUsers('reporter', 'review', signal), 1],
  ['transition', (p, signal) => p.act(ref, { kind: 'transition', value: '91' }, signal), 5],
  ['comment', (p, signal) => p.act(ref, { kind: 'comment', value: 'Review' }, signal), 4],
  ['edit', (p, signal) => p.act(ref, { kind: 'edit_field', value: { fieldId: 'summary', value: { kind: 'text', value: 'Changed' } } }, signal), 5],
  ['create', (p, signal) => p.act(null, { kind: 'create', value: { title: 'Title', body: '', itemType: '10004', fields: {} } }, signal), 5],
];
for (const kind of ['basic', 'bearer']) {
  for (const [name, run, count] of operations) {
    // Catches: a non-detail operation or one of its follow-up requests drops cancellation.
    test(`caller_signal_reaches_every_${kind}_${name}_request`, async () => {
      const requests = [];
      const signal = new AbortController().signal;
      const provider = createJiraProvider({ account: { ...account, kind }, projectId: '10000', fetch: async (req) => {
        requests.push(req);
        return response(req);
      } });
      await run(provider, signal);
      assert.equal(requests.length, count);
      assert.deepEqual(requests.filter((req) => req.signal !== signal).map((req) => req.url), []);
    });
    // Catches: already superseded operations still send Jira requests (including writes).
    test(`preaborted_${kind}_${name}_never_fetches`, async () => {
      const controller = new AbortController();
      controller.abort();
      let calls = 0;
      const provider = createJiraProvider({ account: { ...account, kind }, projectId: '10000', fetch: async (req) => {
        calls++;
        return response(req);
      } });
      await assert.rejects(run(provider, controller.signal), (error) => error === controller.signal.reason);
      assert.equal(calls, 0);
    });
  }
  // Catches: absent project configuration is stringified into project=undefined.
  test(`assignee_without_project_${kind}_fails_before_fetch`, async () => {
    let calls = 0;
    const provider = createJiraProvider({ account: { ...account, kind }, fetch: async () => { calls++; return ok([]); } });
    await assert.rejects(provider.lookupUsers('assignee', 'review'), /Jira project is required/);
    assert.equal(calls, 0);
    assert.deepEqual(await provider.lookupUsers('reporter', 'review'), []);
    assert.equal(calls, 1);
  });
}

for (const operation of ['list', 'board']) {
  // Catches: cancellation between a rejected JQL request and its fallback sends another search.
  test(`abort_stops_${operation}_text_fallback`, async () => {
    const controller = new AbortController();
    let searches = 0;
    const provider = createJiraProvider({ account, fetch: async (req) => {
      if (!req.url.includes('/search')) return response(req);
      searches++;
      controller.abort();
      return { status: 400 };
    } });
    const input = { ...query, search: 'ordinary words' };
    const pending = operation === 'list' ? provider.list(input, controller.signal) : provider.board('42', input, controller.signal);
    await assert.rejects(pending, (error) => error === controller.signal.reason);
    assert.equal(searches, 1);
  });
}

for (const itemType of [undefined, '10004']) {
  // Catches: cancellation after metadata page one still fetches page two.
  test(`abort_stops_metadata_pagination_${itemType ?? 'types'}`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider = createJiraProvider({ account, projectId: '10000', fetch: async () => {
      calls++;
      controller.abort();
      return ok({ issueTypes: [{ id: '10004', name: 'Task' }], fields: fixture.createmeta.fields, isLast: calls === 2 });
    } });
    await assert.rejects(provider.createFields(itemType, controller.signal), (error) => error === controller.signal.reason);
    assert.equal(calls, 1);
  });
}
