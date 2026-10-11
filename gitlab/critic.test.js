import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitLabProvider } from './provider.js';

// Recorded from GitLab CE and scrubbed (fixtures/recorded.json, provenance inside).
const fixture = JSON.parse(readFileSync(new URL('./fixtures/recorded.json', import.meta.url), 'utf8'));
const HOST = 'https://gitlab.example.invalid:8443';
const account = { id: 'gl-work', host: HOST, login: fixture.user.username };
const query = (filters) => ({ filters, savedFilterId: null, search: '', sort: null, groupBy: null, cursor: null, limit: 20 });
const labelFilter = (...names) => ({ fieldId: 'labels', values: [{ kind: 'labels', value: names.map((name) => ({ id: name, name })) }] });

// GitLab REST v4 `GET /projects/:id/issues`: `labels` is a comma-separated list and an
// issue must carry every label in it. The recorded board has two label lists, "To Do" and "Doing".
test('board_label_filter_applies_to_label_lanes — catches: a list lane replaces the user label filter with its own label', async () => {
  const requests = [];
  const fetch = async ({ url }) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.pathname.endsWith(`/boards/${fixture.board.id}`)) {
      return { status: 200, headers: {}, json: fixture.board };
    }
    return { status: 200, headers: {}, json: [] };
  };
  const provider = createGitLabProvider({ account, fetch, project: 'demo/widgets' });

  await provider.board(String(fixture.board.id), query([labelFilter('bug')]), undefined);

  const lanes = requests.filter((url) => url.pathname.endsWith('/issues'));
  assert.equal(lanes.length, fixture.board.lists.length + 2, 'Open, one lane per label list, and Closed');
  for (const lane of lanes) {
    const labels = (lane.searchParams.get('labels') ?? '').split(',');
    assert.ok(labels.includes('bug'), `lane ${lane.search} lost the user label filter`);
  }
  const doing = lanes.find((lane) => (lane.searchParams.get('labels') ?? '').split(',').includes('Doing'));
  assert.ok(doing, 'the Doing lane still asks for its list label');
});

// Catches: several pending to-dos on one item (assigned, mentioned, ...) listing the item once per to-do.
test('todo_list_shows_one_row_per_item — catches: duplicate rows with the same reference', async () => {
  const issueTodos = fixture.todos.filter((todo) => todo.target_type === 'Issue');
  assert.ok(issueTodos.length >= 2 && new Set(issueTodos.map((todo) => todo.target.iid)).size === 1, 'the recording holds several to-dos on one issue');
  const fetch = async () => ({ status: 200, headers: {}, json: issueTodos });
  const provider = createGitLabProvider({ account, fetch });
  const page = await provider.list({ ...query([]), savedFilterId: 'todos' });
  assert.deepEqual(page.items.map((i) => i.reference.id), [fixture.issue.references.full]);
});
