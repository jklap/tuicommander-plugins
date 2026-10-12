/** Merge request actions: merge method, rebase, approval. Readable blockers from `detailed_merge_status`. */
const BLOCKERS = {
  not_open: 'The merge request is not open',
  draft_status: 'The merge request is a draft',
  checking: 'GitLab is still checking whether it can merge',
  unchecked: 'GitLab has not checked mergeability yet',
  preparing: 'GitLab is still preparing the merge request',
  approvals_syncing: 'GitLab is still syncing approvals',
  ci_must_pass: 'The pipeline must succeed first',
  ci_still_running: 'The pipeline is still running',
  discussions_not_resolved: 'All threads must be resolved',
  not_approved: 'Required approvals are missing',
  requested_changes: 'A reviewer requested changes',
  need_rebase: 'The source branch must be rebased',
  conflict: 'The merge request has conflicts',
  broken_status: 'The source branch cannot be merged',
  blocked_status: 'Another merge request blocks this one',
  external_status_checks: 'External status checks must pass',
  jira_association_missing: 'The title or description must name a Jira issue',
  merge_request_blocked: 'Merging is blocked by a dependency',
  merge_time: 'Merging is not allowed before the scheduled time',
  security_policy_violations: 'Security policies block the merge',
  commits_status: 'The source branch has no commits or its commits are invalid',
  locked_paths: 'Paths in the change are locked',
  locked_lfs_files: 'LFS files in the change are locked',
  title_regex: 'The title does not match the required format',
};

/** Null when GitLab reports the merge request mergeable; otherwise a sentence for the user. */
export function mergeBlocker(mr) {
  const status = mr.detailed_merge_status;
  if (mr.state !== 'opened') return BLOCKERS.not_open;
  if (status === 'mergeable') return null;
  return BLOCKERS[status] ?? `GitLab cannot merge it yet (${status ?? 'unknown status'})`;
}

const action = (id, name, disabledReason = null) => ({ id, name, kind: 'transition', enabled: disabledReason == null, disabledReason });

const METHOD_NAMES = { merge: 'Merge commit', rebase_merge: 'Merge (semi-linear history)', ff: 'Fast-forward merge' };

/**
 * Transition descriptors for one MR. `approvals` is the `/approvals` response and
 * `project` the project (its `merge_method` and `squash_option` decide which
 * choices GitLab accepts). Merge ids carry the head sha the user is looking at.
 */
export function mergeActions(mr, approvals, project) {
  if (mr.state !== 'opened') return [];
  const permission = mr.user?.can_merge === false ? 'You cannot merge into the target branch' : null;
  const blocker = permission ?? mergeBlocker(mr);
  const sha = mr.diff_refs?.head_sha ?? mr.sha;
  const squash = project?.squash_option;
  const actions = [
    action(`merge:merge:${sha}`, METHOD_NAMES[project?.merge_method] ?? 'Merge',
      blocker ?? (squash === 'always' ? 'The project requires squashing' : null)),
    action(`merge:squash:${sha}`, 'Squash and merge',
      blocker ?? (squash === 'never' ? 'The project does not allow squashing' : null)),
  ];
  if (mr.detailed_merge_status === 'need_rebase') actions.push(action('rebase', 'Rebase source branch'));
  if (approvals) {
    if (approvals.user_has_approved) actions.push(action('unapprove', 'Revoke approval'));
    else actions.push(action('approve', 'Approve', approvals.user_can_approve === false ? 'You cannot approve this merge request' : null));
  }
  return actions;
}

/**
 * The merge write for a `merge:<method>:<sha>` transition. `sha` pins the merge to
 * the head the user reviewed: after a new push GitLab answers 409 instead of
 * merging commits nobody saw.
 */
export function mergeBody(transition) {
  const match = /^merge:(merge|squash):([0-9a-f]{7,64})$/.exec(transition);
  if (!match) throw new Error('Unknown GitLab merge method or head');
  return { squash: match[1] === 'squash', sha: match[2] };
}
