import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createJiraProvider } from './provider.js';
import { adfToMarkdown, markdownToAdf } from './adf.js';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/cloud.json', import.meta.url), 'utf8'));
const account = { id: 'critic', host: 'https://jira.example.invalid', kind: 'basic' };
const ref = { providerId: 'jira', accountId: account.id, id: recorded.issue.key };
const ok = (json) => ({ status: 200, json: structuredClone(json) });

// Catches: exposing an empty editor overwrites existing description and custom values.
test('detail_editors_preserve_description_and_custom_values', async () => {
  const issue = structuredClone(recorded.issue);
  issue.fields.customfield_text = 'Existing text';
  issue.fields.customfield_number = 0;
  issue.fields.customfield_option = { id: '7', value: 'Seven' };
  issue.fields.customfield_empty = null;
  issue.fields.customfield_complex = { nested: 'Do not erase' };
  for (const [id, schema, allowedValues] of [
    ['customfield_text', { type: 'string' }],
    ['customfield_number', { type: 'number' }],
    ['customfield_option', { type: 'option' }, [{ id: '7', value: 'Seven' }]],
    ['customfield_empty', { type: 'string' }],
    ['customfield_complex', { type: 'object' }],
    ['customfield_missing', { type: 'string' }],
  ]) issue.editmeta.fields[id] = { name: id, schema, allowedValues, operations: ['set'] };
  const provider = createJiraProvider({ account, fetch: async (req) => {
    if (req.url.includes('/transitions')) return ok({ transitions: [] });
    if (req.url.includes('/comment')) return ok({ comments: [], total: 0 });
    return ok(issue);
  } });
  const detail = await provider.detail(ref);
  assert.deepEqual(detail.item.fields.description, { kind: 'markdown', value: detail.body });
  assert.deepEqual(detail.item.fields.customfield_text, { kind: 'text', value: 'Existing text' });
  assert.deepEqual(detail.item.fields.customfield_number, { kind: 'number', value: 0 });
  assert.deepEqual(detail.item.fields.customfield_option, { kind: 'enum', value: '7' });
  assert.equal(detail.item.fields.customfield_empty, null);
  for (const id of ['customfield_complex', 'customfield_missing']) assert.equal(detail.fields.find((f) => f.id === id).editable, false);
});

// Catches: unmarked Markdown syntax becomes formatting, HTML, or loses literal punctuation on save.
test('adf_literal_text_roundtrip_does_not_become_markdown_syntax', () => {
  for (const text of ['*literal*', '**strong** and ~~strike~~', '# heading', '> quote', '- list', '1. item', '---', '<tag>&value', '[label](url)', '`code`', String.raw`back\slash and \*stars\*`, 'a_b ![image](url)']) {
    const doc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
    const markdown = adfToMarkdown(doc);
    assert.deepEqual(markdownToAdf(markdown), doc, text);
    if (text === '<tag>&value') assert.ok(!markdown.includes('<tag>'));
  }
});

// Catches: description requiredness is discarded before provider create validation.
test('required_description_blocks_empty_create_before_jira_write', async () => {
  for (const body of ['', '   ', '\n']) {
    let writes = 0;
    const provider = createJiraProvider({ account, projectId: '10001', fetch: async (req) => {
      if (req.method === 'POST') { writes++; throw new Error('Unexpected write'); }
      return ok({ isLast: true, fields: [{ fieldId: 'description', name: 'Description', required: true, schema: { type: 'string' }, operations: ['set'] }] });
    } });
    assert.equal((await provider.createFields('10004')).find((field) => field.id === 'description')?.required, true);
    await assert.rejects(provider.act(null, { kind: 'create', value: { title: 'Title', body, itemType: '10004', fields: {} } }), /required field: Description/);
    assert.equal(writes, 0);
  }
});
