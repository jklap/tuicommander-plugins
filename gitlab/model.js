/** GitLab REST v4 JSON → A4 work-item shapes. Pure functions, no I/O. */
import { formatId } from './refs.js';
import { mergeBlocker } from './merge.js';

// GitLab sends `bot` only on the full user entity; note authors (basic entity) omit it, so they read false.
// DEFERRED (2026-10-13) — record a GitLab MR note by a review bot before inferring bot from the username.
export const user = (u) => ({ id: String(u.id), name: u.name || u.username, avatarUrl: u.avatar_url ?? null, bot: u.bot === true });
const label = (l) => (typeof l === 'string' ? { id: l, name: l } : { id: l.name, name: l.name });

/** `references.full` is `group/project#12`; older payloads only carry the web URL path. */
function projectPath(raw) {
  const full = raw.references?.full;
  if (typeof full === 'string') return full.replace(/[#!]\d+$/, '');
  const path = new URL(raw.web_url).pathname.split('/-/')[0];
  return decodeURIComponent(path.replace(/^\/+/, ''));
}

function state(raw, mr) {
  if (raw.state === 'merged') return { id: 'merged', name: 'Merged', tone: 'info' };
  if (raw.state === 'closed') return { id: 'closed', name: 'Closed', tone: 'neutral' };
  if (raw.state === 'locked') return { id: 'locked', name: 'Locked', tone: 'warning' };
  if (mr && raw.draft) return { id: 'opened', name: 'Draft', tone: 'neutral' };
  return { id: 'opened', name: 'Open', tone: 'success' };
}

/** `project` is the path of the project the item belongs to; GitLab omits it from list rows. */
export function toItem(raw, account, mr) {
  const project = projectPath(raw);
  const id = formatId(project, mr, raw.iid);
  const assignees = (raw.assignees ?? (raw.assignee ? [raw.assignee] : [])).map(user);
  const labels = (raw.labels ?? []).map(label);
  const fields = {
    title: { kind: 'text', value: raw.title },
    labels: { kind: 'labels', value: labels },
    assignees: { kind: 'user', value: assignees },
    project: { kind: 'text', value: project },
    author: raw.author ? { kind: 'user', value: [user(raw.author)] } : null,
    created: raw.created_at ? { kind: 'date', value: raw.created_at } : null,
    milestone: raw.milestone ? { kind: 'text', value: raw.milestone.title } : null,
    due: raw.due_date ? { kind: 'date', value: raw.due_date } : null,
  };
  if (mr) {
    fields.source_branch = { kind: 'text', value: raw.source_branch };
    fields.target_branch = { kind: 'text', value: raw.target_branch };
    fields.reviewers = { kind: 'user', value: (raw.reviewers ?? []).map(user) };
    if (raw.detailed_merge_status) {
      fields.merge_status = { kind: 'text', value: mergeBlocker(raw) ?? 'Ready to merge' };
    }
    const pipeline = raw.head_pipeline ?? raw.pipeline;
    if (pipeline) fields.pipeline = { kind: 'text', value: pipeline.status };
  }
  return {
    reference: { providerId: 'gitlab', accountId: account.id, id },
    key: raw.references?.short ? `${project.split('/').pop()}${raw.references.short}` : id,
    title: raw.title,
    itemType: mr ? 'merge_request' : 'issue',
    state: state(raw, mr),
    assignees,
    labels,
    updatedAt: raw.updated_at,
    url: raw.web_url,
    fields,
  };
}

const comment = (note) => ({
  id: String(note.id),
  author: user(note.author),
  body: note.body ?? '',
  createdAt: note.created_at,
  url: null,
});

/**
 * One discussion → its comment entries. System notes ("changed the description",
 * "added label") are GitLab activity, not conversation, and are dropped. A
 * discussion anchored to a diff position is a review thread with resolved state.
 */
export function discussionEntries(discussion) {
  const notes = (discussion.notes ?? []).filter((note) => !note.system);
  if (!notes.length) return [];
  const position = notes[0].position;
  if (position && notes[0].type === 'DiffNote') {
    return [{
      kind: 'review_thread',
      value: {
        id: String(discussion.id),
        resolved: notes.every((note) => !note.resolvable || note.resolved),
        // DEFERRED (2026-10-13) — the discussions API has no outdated flag; telling one needs the MR diff.
        outdated: false,
        path: position.new_path ?? position.old_path ?? '',
        line: position.new_line ?? position.old_line ?? null,
        originalLine: position.new_line ?? position.old_line ?? null,
        commitId: position.head_sha ?? '',
        comments: notes.map(comment),
      },
    }];
  }
  // A reply chain outside the diff keeps reading order as normal comments.
  return notes.map((note) => ({ kind: 'normal', value: comment(note) }));
}
