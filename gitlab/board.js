/**
 * GitLab issue boards. Columns: Open (no list label), one per label list in board
 * order, Closed. A move is what the GitLab UI does: swap the source list label for
 * the target one through `add_labels`/`remove_labels`, never by rewriting the whole
 * label set (that would drop labels someone added since the board loaded).
 */
import { nextCursor, pageNumber, pageSize } from './client.js';

const OPEN = 'open';
const CLOSED = 'closed';

/** Label lists only; assignee, milestone and iteration lists are not supported. */
function columns(board) {
  const lists = (board.lists ?? []).filter((l) => l.label?.name).sort((a, b) => a.position - b.position);
  return [
    { id: OPEN, name: 'Open', label: null },
    ...lists.map((l) => ({ id: String(l.id), name: l.label.name, label: l.label.name })),
    { id: CLOSED, name: 'Closed', label: null },
  ];
}

export const moveValue = (boardId, from, to) => `board:${boardId}:${from}:${to}`;

export function parseMove(value) {
  const match = /^board:([1-9]\d{0,15}):(open|closed|[1-9]\d{0,15}):(open|closed|[1-9]\d{0,15})$/.exec(value);
  return match ? { boardId: match[1], from: match[2], to: match[3] } : null;
}

/** The issue edit for a move between two columns of `board`. */
export function moveEdit(board, from, to) {
  const cols = columns(board);
  const source = cols.find((c) => c.id === from);
  const target = cols.find((c) => c.id === to);
  if (!source || !target) throw new Error('The GitLab board changed; reload it');
  if (from === to) throw new Error('The card is already in that column');
  const edit = {};
  if (target.label) edit.add_labels = target.label;
  if (source.label) edit.remove_labels = source.label;
  if (to === CLOSED) edit.state_event = 'close';
  if (from === CLOSED) edit.state_event = 'reopen';
  return edit;
}

export function boardPort({ request, project, toItem, issueParams }) {
  const projectPath = () => {
    if (!project) throw new Error('GitLab boards need a configured project');
    return encodeURIComponent(project);
  };
  async function load(id, signal) {
    if (!/^[1-9]\d{0,15}$/.test(id)) throw new Error('Invalid GitLab board');
    return (await request(`projects/${projectPath()}/boards/${id}`, { signal })).json;
  }
  async function board(id, query, signal) {
    const raw = await load(id, signal);
    const cols = columns(raw);
    const listLabels = cols.filter((c) => c.label).map((c) => c.label);
    const page = pageNumber(query.cursor);
    const base = { ...issueParams(query), per_page: String(pageSize(query.limit)), page: String(page) };
    const lanes = await Promise.all(cols.map(async (col) => {
      const params = new URLSearchParams(base);
      params.set('state', col.id === CLOSED ? 'closed' : 'opened');
      if (col.label) params.set('labels', [base.labels, col.label].filter(Boolean).join(','));
      if (col.id === OPEN && listLabels.length) params.set('not[labels]', listLabels.join(','));
      const { json, headers } = await request(`projects/${projectPath()}/issues?${params}`, { signal });
      return { col, issues: json, more: nextCursor(headers) != null };
    }));
    const descriptor = {
      id: String(raw.id), name: raw.name, fieldId: 'labels',
      columns: cols.map((c) => ({ id: c.id, name: c.name, action: null })),
    };
    return {
      board: descriptor,
      lanes: lanes.map(({ col, issues }) => ({
        columnId: col.id,
        cards: issues.map((issue) => ({
          item: toItem(issue),
          moves: cols.filter((c) => c.id !== col.id).map((c) => ({
            columnId: c.id, action: { kind: 'transition', value: moveValue(raw.id, col.id, c.id) },
          })),
        })),
      })),
      nextCursor: lanes.some((l) => l.more) ? String(page + 1) : null,
    };
  }
  /** Re-reads the board so a renamed or deleted list never applies a stale label. */
  async function move(itemPath, value, signal) {
    const parsed = parseMove(value);
    if (!parsed) return false;
    const edit = moveEdit(await load(parsed.boardId, signal), parsed.from, parsed.to);
    await request(itemPath, { method: 'PUT', body: edit, signal });
    return true;
  }
  return { board, move };
}
