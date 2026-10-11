import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitLabProvider } from './provider.js';

const HOST = 'https://gitlab.example.invalid:8443';
const account = { id: 'gl-work', host: HOST, login: 'root' };
const query = (filters) => ({ filters, savedFilterId: null, search: '', sort: null, groupBy: null, cursor: null, limit: 20 });
const labelFilter = (...names) => ({ fieldId: 'labels', values: [{ kind: 'labels', value: names.map((name) => ({ id: name, name })) }] });

// GitLab REST v4 `GET /projects/:id/issues`: `labels` is a comma-separated list and an
// issue must carry every label in it. The board below has one label list, "Doing".
test('board_label_filter_applies_to_label_lanes — catches: a list lane replaces the user label filter with its own label', async () => {
  const requests = [];
  const fetch = async ({ url }) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.pathname.endsWith('/boards/5')) {
      return { status: 200, headers: {}, json: { id: 5, name: 'Development', lists: [{ id: 12, position: 0, label: { id: 2, name: 'Doing' } }] } };
    }
    return { status: 200, headers: {}, json: [] };
  };
  const provider = createGitLabProvider({ account, fetch, project: 'demo/widgets' });

  await provider.board('5', query([labelFilter('bug')]), undefined);

  const lanes = requests.filter((url) => url.pathname.endsWith('/issues'));
  assert.equal(lanes.length, 3, 'Open, Doing and Closed lanes');
  for (const lane of lanes) {
    const labels = (lane.searchParams.get('labels') ?? '').split(',');
    assert.ok(labels.includes('bug'), `lane ${lane.search} lost the user label filter`);
  }
  const doing = lanes.find((lane) => (lane.searchParams.get('labels') ?? '').split(',').includes('Doing'));
  assert.ok(doing, 'the Doing lane still asks for its list label');
});
