import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// Catches: runner tokens, nested token fields and tokens in free text written verbatim.
test('recorder_redacts_tokens_before_writing_recorded_fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-recorder-'));
  try {
    const recorder = join(dir, 'record.mjs');
    copyFileSync(new URL('./fixtures/record.mjs', import.meta.url), recorder);
    const fixtureUrl = new URL('./fixtures/recorded.json', import.meta.url).href;
    const script = `
      import { readFileSync } from 'node:fs';
      const fixture = JSON.parse(readFileSync(new URL(${JSON.stringify(fixtureUrl)}), 'utf8'));
      const keys = ['version', 'mr', 'user', 'issue', 'closedIssue', 'approvals', 'project', 'pipelines', 'jobs', 'trace', 'discussions', 'issueDiscussions', 'labels', 'members', 'board', 'todos', 'staleMerge', 'issuesPage'];
      let index = 0;
      globalThis.fetch = async () => {
        const key = keys[index++];
        const value = key === 'version' ? {version: 'test', revision: 'test'} : structuredClone(fixture[key]);
        if (key === 'project') {
          value.runners_token = 'runner-secret';
          value.nested = [{AccessToken: 'nested-secret', token_count: 3, token_data: {secret: 'object-secret'}, null_token: null}];
          value.description = 'before glpat-' + 'a'.repeat(20) + ' middle glrt-' + 'b'.repeat(20) + ' after GR1348941' + 'c'.repeat(20) + '.';
        }
        return {ok: true, status: value?.status ?? 200, headers: {get: () => ''}, json: async () => value?.body ?? value, text: async () => value};
      };
      await import(${JSON.stringify(pathToFileURL(recorder).href)});
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, GITLAB_URL: 'http://localhost:8929', GITLAB_TOKEN: 'synthetic-auth-secret' },
      stdio: 'pipe',
    });
    const text = readFileSync(join(dir, 'recorded.json'), 'utf8');
    const output = JSON.parse(text);
    // Boolean assertions prevent an accidental failure from printing credential values.
    assert.equal(output.project.runners_token === 'REDACTED', true, 'runner token must be redacted');
    assert.deepEqual(output.project.nested, [{AccessToken: 'REDACTED', token_count: 'REDACTED', token_data: 'REDACTED', null_token: 'REDACTED'}]);
    assert.equal(output.project.description === 'before REDACTED middle REDACTED after REDACTED.', true, 'free-text token prefixes must be redacted');
    assert.equal(text.includes('synthetic-auth-secret'), false, 'request authentication must not be recorded');
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/recorded.json', import.meta.url), 'utf8'));
    assert.deepEqual(output.issue, fixture.issue);
    assert.equal(output.project.id, fixture.project.id);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
