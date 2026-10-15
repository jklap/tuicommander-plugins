/** ADF ↔ Markdown subset: paragraphs, marks, links, lists, quotes, headings and code. */
export function adfToMarkdown(node) {
  if (typeof node === 'string') return node;
  if (!node) return '';
  const children = () => (node.content ?? []).map(adfToMarkdown).join('');
  switch (node.type) {
    case 'doc': return children().trimEnd();
    case 'text': {
      let text = node.text ?? '';
      for (const mark of node.marks ?? []) {
        if (mark.type === 'strong') text = `**${text}**`;
        else if (mark.type === 'em') text = `*${text}*`;
        else if (mark.type === 'strike') text = `~~${text}~~`;
        else if (mark.type === 'code') text = `\`${text}\``;
        else if (mark.type === 'link') text = `[${text}](${mark.attrs.href})`;
      }
      return text;
    }
    case 'paragraph': return `${children()}\n\n`;
    case 'heading': return `${'#'.repeat(node.attrs?.level ?? 1)} ${children()}\n\n`;
    case 'hardBreak': return '  \n';
    case 'rule': return '---\n\n';
    case 'codeBlock': {
      const text = (node.content ?? []).map((n) => n.text ?? '').join('');
      const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((s) => s.length + 1)));
      return `${fence}${node.attrs?.language ?? ''}\n${text}\n${fence}\n\n`;
    }
    case 'bulletList': case 'orderedList':
      return (node.content ?? []).map((item, i) => {
        const prefix = node.type === 'bulletList' ? '- ' : `${(node.attrs?.order ?? 1) + i}. `;
        return prefix + adfToMarkdown(item).trimEnd().replace(/\n/g, `\n${' '.repeat(prefix.length)}`) + '\n';
      }).join('') + '\n';
    case 'listItem': return children();
    case 'blockquote': return children().trimEnd().split('\n').map((s) => `> ${s}`).join('\n') + '\n\n';
    case 'mention': return node.attrs?.text ?? node.attrs?.id ?? '';
    case 'inlineCard': return node.attrs?.url ?? '';
    default: return children();
  }
}

function inline(text) {
  const pattern = /(\*\*(.+?)\*\*|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*([^*]+)\*)/g;
  const content = []; let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) content.push({ type: 'text', text: text.slice(offset, match.index) });
    const mark = match[2] ? { type: 'strong' } : match[3] ? { type: 'strike' } : match[4] ? { type: 'code' } : match[5] ? { type: 'link', attrs: { href: match[6] } } : { type: 'em' };
    content.push({ type: 'text', text: match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[7], marks: [mark] });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) content.push({ type: 'text', text: text.slice(offset) });
  return content;
}

export function markdownToAdf(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const content = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const code = []; i++;
      while (i < lines.length && !lines[i].startsWith(fence[1])) code.push(lines[i++]);
      if (i < lines.length) i++;
      content.push({ type: 'codeBlock', attrs: { language: fence[2].trim() }, content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { content.push({ type: 'heading', attrs: { level: heading[1].length }, content: inline(heading[2]) }); i++; continue; }
    if (/^> ?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^> ?/.test(lines[i])) quote.push(lines[i++].replace(/^> ?/, ''));
      content.push({ type: 'blockquote', content: markdownToAdf(quote.join('\n')).content }); continue;
    }
    const list = line.match(/^(\s*)([-+*]|\d+\.)\s+(.*)$/);
    if (list) {
      const ordered = /^\d/.test(list[2]); const items = [];
      while (i < lines.length) {
        const item = lines[i].match(/^(\s*)([-+*]|\d+\.)\s+(.*)$/);
        if (!item || item[1].length !== list[1].length || /^\d/.test(item[2]) !== ordered) break;
        const body = [item[3]]; i++;
        while (i < lines.length && lines[i].startsWith(' '.repeat(list[1].length + 2))) body.push(lines[i++].slice(list[1].length + 2));
        items.push({ type: 'listItem', content: markdownToAdf(body.join('\n')).content });
      }
      content.push({ type: ordered ? 'orderedList' : 'bulletList', ...(ordered ? { attrs: { order: parseInt(list[2], 10) } } : {}), content: items }); continue;
    }
    if (/^---+$/.test(line)) { content.push({ type: 'rule' }); i++; continue; }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|[-+*]\s|\d+\.\s|`{3,}|~{3,})/.test(lines[i])) paragraph.push(lines[i++]);
    const parts = paragraph.join('\n').split(/ {2,}\n/);
    content.push({ type: 'paragraph', content: parts.flatMap((part, index) => [
      ...(index ? [{ type: 'hardBreak' }] : []), ...inline(part),
    ]) });
  }
  return { type: 'doc', version: 1, content };
}
