/** Merge request pipelines: latest pipeline, its jobs, retry and job logs. */
const RETRYABLE = new Set(['failed', 'canceled']);
const TRACE_LIMIT = 256 * 1024;
const MAX_JOB_ACTIONS = 10;

/** Newest pipeline of the MR and its jobs, or null when the MR never ran CI. */
export async function latestPipeline(request, project, iid, signal) {
  const { json } = await request(`projects/${project}/merge_requests/${iid}/pipelines?per_page=1`, { signal });
  const pipeline = Array.isArray(json) ? json[0] : null;
  if (!pipeline) return null;
  const jobs = await request(`projects/${project}/pipelines/${pipeline.id}/jobs?per_page=100`, { signal });
  return { pipeline, jobs: Array.isArray(jobs.json) ? jobs.json : [] };
}

const cell = (text) => String(text ?? '').replace(/[|\\`*_[\]<>]/g, (c) => `\\${c}`).replace(/\s+/g, ' ');

export function jobsMarkdown({ pipeline, jobs }) {
  const rows = jobs.map((job) => `| ${cell(job.stage)} | [${cell(job.name)}](${job.web_url}) | ${cell(job.status)}${job.allow_failure ? ' (allowed to fail)' : ''} |`);
  return [`Pipeline [#${pipeline.id}](${pipeline.web_url}): **${cell(pipeline.status)}**`, '', '| Stage | Job | Status |', '|---|---|---|', ...rows].join('\n');
}

const action = (id, name) => ({ id, name, kind: 'transition', enabled: true, disabledReason: null });

export function pipelineActions(latest) {
  if (!latest) return [];
  const actions = RETRYABLE.has(latest.pipeline.status) ? [action(`pipeline:retry:${latest.pipeline.id}`, 'Retry failed jobs')] : [];
  for (const job of latest.jobs.filter((j) => RETRYABLE.has(j.status)).slice(0, MAX_JOB_ACTIONS)) {
    actions.push(action(`job:retry:${job.id}`, `Retry job ${job.name}`));
  }
  return actions;
}

/** `pipeline:retry:<id>` / `job:retry:<id>` → the POST path inside the MR project. */
export function retryPath(project, transition) {
  const match = /^(pipeline|job):retry:([1-9]\d{0,15})$/.exec(transition);
  if (!match) return null;
  return `projects/${project}/${match[1] === 'job' ? 'jobs' : 'pipelines'}/${match[2]}/retry`;
}

/**
 * Plain-text job log, tail-capped. GitLab traces carry ANSI colours and
 * `section_start:`/`section_end:` folding markers; both are terminal chrome.
 */
export function cleanTrace(text) {
  const raw = String(text ?? '');
  const tail = raw.length > TRACE_LIMIT ? raw.slice(-TRACE_LIMIT) : raw;
  return tail
    .replace(/section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]]*\])?\r?/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r(?!\n)/g, '\n');
}
