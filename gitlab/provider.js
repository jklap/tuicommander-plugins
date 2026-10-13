import { createClient, nextCursor, pageNumber, pageSize, GitLabError } from './client.js';
import { parseId, itemPath, idFromUrl, idFromReference } from './refs.js';
import { toItem as mapItem, discussionEntries } from './model.js';
import { mergeActions, mergeBody } from './merge.js';
import { latestPipeline, jobsMarkdown, pipelineActions, retryPath, cleanTrace } from './pipelines.js';
import { boardPort } from './board.js';
import { listFields, presets, issueParams, search } from './query.js';

const transition = (id, name) => ({ id, name, kind: 'transition', enabled: true, disabledReason: null });
const schema = (id, name, kind, options = [], required = false) => ({ id, name, kind, required, editable: true, sortable: false, groupable: false, filterable: false, options });

/** Readable failures of the merge endpoints (`PUT …/merge`, `PUT …/rebase`). */
const MERGE_ERRORS = {
  401: 'GitLab rejected the account token',
  403: 'You cannot merge this merge request',
  405: 'GitLab cannot merge it in its current state; reload to see the blocker',
  406: 'The merge request has conflicts or cannot be merged',
  409: 'The source branch changed since you loaded it; reload and review the new commits',
  422: 'GitLab refused the merge; reload to see the blocker',
};

/** One provider instance per core account. `project` (path) scopes boards, create and `!N` references. */
export function createGitLabProvider(options) {
  const { account, project = null } = options;
  const { base, request } = createClient(options);
  const toItem = (raw, mr) => mapItem(raw, account, mr);
  const boards = boardPort({ request, project, toItem: (raw) => toItem(raw, false), issueParams });
  function checkRef(ref) {
    if (!ref || ref.providerId !== 'gitlab' || ref.accountId !== account.id) throw new Error('GitLab item belongs to another account');
    return { ...parseId(ref.id), path: itemPath(ref.id), encoded: encodeURIComponent(parseId(ref.id).project) };
  }
  async function comments(ref, cursor = null, limit = 20, signal) {
    const { path } = checkRef(ref);
    const params = new URLSearchParams({ per_page: String(pageSize(limit)), page: String(pageNumber(cursor)) });
    const { json, headers } = await request(`${path}/discussions?${params}`, { signal });
    if (!Array.isArray(json)) throw new Error('Invalid GitLab discussions response');
    return { entries: json.flatMap(discussionEntries), nextCursor: nextCursor(headers) };
  }
  async function projectOptions(encoded, signal) {
    const [labels, members] = await Promise.all([
      request(`projects/${encoded}/labels?per_page=100`, { signal }),
      request(`projects/${encoded}/members/all?per_page=100`, { signal }),
    ]);
    return {
      labels: labels.json.map((l) => ({ id: l.name, name: l.name })),
      users: members.json.map((m) => ({ id: String(m.id), name: m.name || m.username })),
    };
  }
  async function detail(ref, signal) {
    const { mr, path, encoded, iid } = checkRef(ref);
    const [raw, page, choices] = await Promise.all([
      request(path, { signal }).then((r) => r.json), comments(ref, null, 20, signal), projectOptions(encoded, signal),
    ]);
    const item = toItem(raw, mr);
    const actions = [];
    if (raw.state === 'opened') actions.push(transition('close', 'Close'));
    if (raw.state === 'closed') actions.push(transition('reopen', 'Reopen'));
    if (mr) {
      const [approvals, proj, latest] = await Promise.all([
        request(`${path}/approvals`, { signal }).then((r) => r.json),
        request(`projects/${encoded}`, { signal }).then((r) => r.json),
        latestPipeline(request, encoded, iid, signal),
      ]);
      actions.push(...mergeActions(raw, approvals, proj), ...pipelineActions(latest));
      if (latest) item.fields.jobs = { kind: 'markdown', value: jobsMarkdown(latest) };
    }
    actions.push({ id: 'comment', name: 'Add comment', kind: 'comment', enabled: true, disabledReason: null });
    actions.push({ id: 'start_work', name: 'Start work', kind: 'start_work', enabled: raw.state === 'opened', disabledReason: raw.state === 'opened' ? null : 'The item is not open' });
    return {
      item, body: raw.description ?? '', actions, comments: page,
      fields: [
        schema('title', 'Title', 'text', [], true), schema('description', 'Description', 'markdown'),
        schema('labels', 'Labels', 'labels', choices.labels), schema('assignees', 'Assignees', 'user', choices.users),
        ...(mr ? [] : [schema('due', 'Due date', 'date')]),
      ],
    };
  }
  /** Untyped: the type picker. Typed: the fields besides the form's fixed Title and Body. */
  async function createFields(itemType, signal) {
    if (itemType == null) return [{ ...schema('itemType', 'Type', 'enum', [{ id: 'issue', name: 'Issue' }], true) }];
    if (itemType !== 'issue') throw new Error('GitLab creates issues only');
    if (!project) throw new Error('GitLab create needs a configured project');
    const choices = await projectOptions(encodeURIComponent(project), signal);
    return [schema('labels', 'Labels', 'labels', choices.labels), schema('assignees', 'Assignees', 'user', choices.users), schema('due', 'Due date', 'date')];
  }
  function editBody(fieldId, value) {
    if (fieldId === 'title') {
      if (value?.kind !== 'text' || !value.value.trim()) throw new Error('GitLab title cannot be empty');
      return { title: value.value };
    }
    if (fieldId === 'description') return { description: value?.value ?? '' };
    if (fieldId === 'labels') return { labels: (value?.value ?? []).map((l) => l.name).join(',') };
    if (fieldId === 'assignees') return { assignee_ids: (value?.value ?? []).map((u) => Number(u.id)).filter(Number.isSafeInteger) };
    if (fieldId === 'due') return { due_date: value?.value ?? null };
    throw new Error(`GitLab field ${fieldId} is not editable`);
  }
  async function transitionItem(target, value, signal) {
    const { mr, path, encoded } = target;
    if (value === 'close' || value === 'reopen') return request(path, { method: 'PUT', body: { state_event: value }, signal });
    if (!mr) {
      if (target.project !== project) throw new Error('GitLab board moves need the configured project');
      if (await boards.move(path, value, signal)) return null;
      throw new Error('Unknown GitLab transition');
    }
    if (value === 'approve' || value === 'unapprove') return request(`${path}/${value}`, { method: 'POST', signal });
    const retry = retryPath(encoded, value);
    if (retry) return request(retry, { method: 'POST', signal });
    if (value !== 'rebase' && !value.startsWith('merge:')) throw new Error('Unknown GitLab transition');
    try {
      return value === 'rebase'
        ? await request(`${path}/rebase`, { method: 'PUT', signal })
        : await request(`${path}/merge`, { method: 'PUT', body: mergeBody(value), signal });
    } catch (error) {
      if (error instanceof GitLabError && MERGE_ERRORS[error.status]) throw new GitLabError(error.status, null, MERGE_ERRORS[error.status]);
      throw error;
    }
  }
  async function act(ref, action, signal) {
    if (action.kind === 'create') {
      const value = action.value;
      if (!project) throw new Error('GitLab create needs a configured project');
      if (!value.title.trim()) throw new Error('GitLab issue title is required');
      const body = { title: value.title, description: value.body ?? '' };
      for (const [fieldId, field] of Object.entries(value.fields ?? {})) if (field) Object.assign(body, editBody(fieldId, field));
      const { json } = await request(`projects/${encodeURIComponent(project)}/issues`, { method: 'POST', body, signal });
      return { kind: 'item', value: await detail({ providerId: 'gitlab', accountId: account.id, id: `${project}#${json.iid}` }, signal) };
    }
    const target = checkRef(ref);
    if (action.kind === 'start_work') return { kind: 'start_work', value: action.value };
    if (action.kind === 'comment') {
      if (!action.value.trim()) throw new Error('GitLab comment cannot be empty');
      await request(`${target.path}/notes`, { method: 'POST', body: { body: action.value }, signal });
    } else if (action.kind === 'edit_field') {
      if (target.mr && action.value.fieldId === 'due') throw new Error('GitLab merge requests have no due date');
      await request(target.path, { method: 'PUT', body: editBody(action.value.fieldId, action.value.value), signal });
    } else if (action.kind === 'transition') {
      await transitionItem(target, action.value, signal);
    } else throw new Error('Unsupported GitLab action');
    return { kind: 'item', value: await detail(ref, signal) };
  }
  async function list(query, signal) {
    const direct = idFromUrl(base, query.search?.trim() ?? '') ?? idFromReference(query.search, project);
    if (direct && !query.cursor) {
      try {
        return { items: [toItem((await request(itemPath(direct), { signal })).json, parseId(direct).mr)], nextCursor: null };
      } catch (error) {
        if (!(error instanceof GitLabError) || error.status !== 404) throw error;
      }
    }
    const page = await search(request, query, { project, login: account.login }, signal);
    return { items: page.rows.map(({ raw, mr }) => toItem(raw, mr)), nextCursor: page.nextCursor };
  }
  async function grouped(query, signal) {
    const page = await list({ ...query, groupBy: null }, signal);
    const key = {
      state: (i) => [i.state.id, i.state.name], type: (i) => [i.itemType, i.itemType === 'issue' ? 'Issues' : 'Merge requests'],
      labels: (i) => [i.labels[0]?.id ?? '', i.labels[0]?.name ?? 'No label'],
      assignee: (i) => [i.assignees[0]?.id ?? '', i.assignees[0]?.name ?? 'Unassigned'],
      author: (i) => [i.fields.author?.value[0]?.id ?? '', i.fields.author?.value[0]?.name ?? 'Unknown'],
    }[query.groupBy];
    if (!key) throw new Error(`GitLab cannot group by ${query.groupBy}`);
    const groups = new Map();
    for (const item of page.items) {
      const [id, name] = key(item);
      if (!groups.has(id)) groups.set(id, { id, name, items: [] });
      groups.get(id).items.push(item);
    }
    return { groups: [...groups.values()], nextCursor: page.nextCursor };
  }
  return {
    providerId: 'gitlab', accountId: account.id, name: `GitLab · ${account.label ?? base}`,
    fields: listFields, savedFilters: presets(account.login), boards: options.boards ?? [],
    list, grouped, detail, comments, act, createFields, board: boards.board,
    /** Plain-text log of one job of a merge request pipeline; ANSI and folding markers removed. */
    async jobTrace(ref, jobId, signal) {
      const { mr, encoded } = checkRef(ref);
      if (!mr || !/^[1-9]\d{0,15}$/.test(String(jobId))) throw new Error('Job logs belong to merge request pipelines');
      return cleanTrace((await request(`projects/${encoded}/jobs/${jobId}/trace`, { signal, text: true })).text);
    },
    resolveUrl(url) {
      const id = idFromUrl(base, url);
      return id ? { providerId: 'gitlab', accountId: account.id, id } : null;
    },
  };
}
