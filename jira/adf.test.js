import assert from 'node:assert/strict';
import test from 'node:test';
import { adfToMarkdown, markdownToAdf } from './adf.js';

// Catches: editing a paragraph flattens its hard break into a text newline.
test('adf_roundtrip_keeps_paragraph_hard_breaks', () => {
  const paragraph = {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'First', marks: [{ type: 'strong' }] },
      { type: 'hardBreak' },
      { type: 'text', text: 'Second' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Third', marks: [{ type: 'em' }] },
    ],
  };
  for (const block of [
    paragraph,
    { type: 'blockquote', content: [paragraph] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph] }] },
  ]) {
    const doc = { type: 'doc', version: 1, content: [block] };
    assert.deepEqual(markdownToAdf(adfToMarkdown(doc)), doc);
  }
});

// Catches: recognizing hard breaks also changes ordinary soft newlines.
test('markdown_soft_newlines_stay_text', () => {
  assert.deepEqual(markdownToAdf('First\nSecond'), {
    type: 'doc', version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First\nSecond' }] }],
  });
});
