// Records fixtures/recorded.json from a live GitLab CE and scrubs it.
// Usage: GITLAB_URL=http://localhost:8929 GITLAB_TOKEN=<pat> node record.mjs
// The token is read from the environment, sent as a bearer header and never written.
// Seed state expected: see README "Fixtures". Responses are stored as GitLab sent them;
// only the scrub rules below change them.
import { writeFileSync } from 'node:fs';

const base = process.env.GITLAB_URL;
const token = process.env.GITLAB_TOKEN;
if (!base || !token) throw new Error('GITLAB_URL and GITLAB_TOKEN are required');
const P = 'projects/demo%2Fwidgets';

/** Raw exchange for a request whose status and headers matter: `{status, headers, body}`. */
async function exchange(method, path, body) {
  const res = await fetch(`${base}/api/v4/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
  return { status: res.status, headers: { 'x-next-page': res.headers.get('x-next-page') ?? '', 'x-total': res.headers.get('x-total') ?? '' }, body: await res.json() };
}

async function get(path, text = false) {
  const res = await fetch(`${base}/api/v4/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return text ? res.text() : res.json();
}

const version = await get('version');
const mr = await get(`${P}/merge_requests/1`);
const recorded = {
  user: await get('user'),
  issue: await get(`${P}/issues/1`),
  closedIssue: await get(`${P}/issues/2`),
  mr,
  approvals: await get(`${P}/merge_requests/1/approvals`),
  project: await get(P),
  pipelines: await get(`${P}/merge_requests/1/pipelines`),
  jobs: await get(`${P}/pipelines/${mr.head_pipeline.id}/jobs`),
  trace: await get(`${P}/jobs/2/trace`, true),
  discussions: await get(`${P}/merge_requests/1/discussions`),
  issueDiscussions: await get(`${P}/issues/1/discussions`),
  labels: await get(`${P}/labels`),
  members: await get(`${P}/members/all`),
  board: await get(`${P}/boards/1`),
  todos: await get('todos?state=pending'),
  // A merge pinned to a head sha that is not the source branch head: GitLab refuses it and merges nothing.
  staleMerge: await exchange('PUT', `${P}/merge_requests/1/merge`, { sha: '0'.repeat(40) }),
  issuesPage: await exchange('GET', `${P}/issues?state=opened&per_page=1&page=1`),
};

// Scrub rules: instance origin, avatar URLs (gravatar hashes derive from e-mail), e-mail addresses.
const ORIGIN = 'https://gitlab.example.invalid:8443';
const scrub = (value) => {
  if (typeof value === 'string') {
    return value.replaceAll(base, ORIGIN)
      .replaceAll(new URL(base).hostname, 'gitlab.example.invalid')
      .replace(/https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]+\?[^"\s]*/g, `${ORIGIN}/avatar.png`)
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'user@example.invalid');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
};

const out = {
  _provenance: {
    source: 'GitLab CE recorded over REST v4 from a throwaway container',
    gitlab: `${version.version} (${version.revision})`,
    image: process.env.GITLAB_IMAGE ?? 'gitlab/gitlab-ce:latest',
    recordedAt: new Date().toISOString(),
    scrubbed: ['instance origin -> ' + ORIGIN, 'bare hostname (ssh URLs)', 'gravatar avatar URLs', 'e-mail addresses'],
    note: 'Pipeline and job rows were driven to success/failed through the Rails console (no runner); the trace is served by the real trace endpoint.',
  },
  ...scrub(recorded),
};
writeFileSync(new URL('./recorded.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log('recorded', Object.keys(out).length - 1, 'fixtures');
