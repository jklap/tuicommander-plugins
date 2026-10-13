import { createClient, nextPage, pageNumber, pageSize } from "./client.js";
import { FIELDS, LIST_FIELDS, comment, field, identity, item, parseReference, resolveUrl } from "./model.js";
import { searchPath, savedFilters } from "./query.js";
import { Projects } from "./projects.js";

export function createGitHubProvider({ accountId, repository, fetch, apiUrl, webOrigin, core }) {
  identity(repository, "issue", 1);
  if (typeof accountId !== "string" || !accountId.trim() || typeof fetch !== "function")
    throw new Error("Account and fetch port are required");
  const client = createClient(fetch, apiUrl);
  const projects = new Projects(client, accountId);
  const compose = (mapped, json, kind, comments) => {
    const actions = [
      { id: "comment", name: "Comment", kind: "comment" },
      { id: "start-work", name: "Start work", kind: "start_work" },
      ...(mapped.state.id === "open"
        ? [
            { id: "close:completed", name: "Close as completed", kind: "transition" },
            ...(kind === "issue"
              ? [{ id: "close:not_planned", name: "Close as not planned", kind: "transition" }]
              : []),
          ]
        : json.merged_at
          ? []
          : [{ id: "reopen", name: "Reopen", kind: "transition" }]),
    ].map((a) => ({ ...a, enabled: true, disabledReason: null }));
    return {
      item: mapped,
      body: json.body ?? "",
      fields: [...FIELDS, ...[...projects.fields.values()].map((v) => v.schema)],
      actions,
      comments,
    };
  };
  const provider = {
    providerId: "github",
    accountId,
    name: "GitHub",
    get fields() {
      return [...LIST_FIELDS, ...[...projects.fields.values()].map((v) => v.schema)];
    },
    savedFilters,
    boards: [],
    resolveUrl: (url) => resolveUrl(url, accountId, webOrigin),
    async list(query, signal) {
      const { json, headers } = await client.request(searchPath(repository, query), "GET", undefined, signal);
      if (!Array.isArray(json?.items) || typeof json.total_count !== "number")
        throw new Error("Malformed GitHub search response");
      if (json.incomplete_results) throw new Error("GitHub search returned incomplete results; narrow the query");
      const current = pageNumber(query.cursor);
      return { items: json.items.map((v) => item(v, accountId)), nextCursor: nextPage(headers, current) };
    },
    async duplicates(title, signal) {
      if (!title.trim()) return { items: [], nextCursor: null };
      return this.list(
        {
          filters: [],
          savedFilterId: null,
          search: `${JSON.stringify(title)} in:title is:issue`,
          sort: null,
          groupBy: null,
          cursor: null,
          limit: 10,
        },
        signal,
      );
    },
    /** Untyped: the type picker. Typed: the fields besides the form's fixed Title and Body. */
    async createFields(itemType, signal) {
      if (itemType == null) return [{ ...field("itemType", "Type", "enum", true, [{ id: "issue", name: "Issue" }]), required: true }];
      if (itemType !== "issue") throw new Error("Pull requests are created through the core PR flow");
      const options = async (endpoint, map) => {
        const values = [];
        let cursor = 1;
        do {
          const { json, headers } = await client.request(
            `repos/${repository}/${endpoint}?per_page=100&page=${cursor}`,
            "GET",
            undefined,
            signal,
          );
          if (!Array.isArray(json)) throw new Error("Malformed GitHub create metadata");
          values.push(...json.map(map));
          cursor = nextPage(headers, cursor) ? cursor + 1 : null;
        } while (cursor);
        return values;
      };
      const labels = await options("labels", (l) => ({ id: l.name, name: l.name }));
      const milestones = await options("milestones", (m) => ({ id: String(m.number), name: m.title }));
      return [
        field("labels", "Labels", "labels", true, labels),
        field("milestone", "Milestone", "enum", true, milestones),
        field("assignees", "Assignees", "user"),
      ];
    },
    async detail(reference, signal) {
      const ref = parseReference(reference, accountId);
      const path = ref.kind === "pull" ? `repos/${ref.repository}/pulls/${ref.number}` : ref.path;
      const { json } = await client.request(path, "GET", undefined, signal);
      const mapped = item(json, accountId, ref.repository, ref.kind);
      if (mapped.reference.id !== reference.id) throw new Error("GitHub returned a different item");
      return compose(mapped, json, ref.kind, await this.comments(reference, null, 50, signal));
    },
    async comments(reference, cursor, limit, signal) {
      const ref = parseReference(reference, accountId);
      const segments = (cursor ?? "normal:1").split(":");
      if (segments.length !== 2) throw new Error("Invalid comment cursor");
      const [source, rawPage] = segments;
      if (!["normal", "reviews", "threads"].includes(source) || !rawPage) throw new Error("Invalid comment cursor");
      if (source === "threads") {
        if (!core?.reviewThreads) throw new Error("Core review-thread port is unavailable");
        const page = await core.reviewThreads(
          reference,
          rawPage === "first" ? null : decodeURIComponent(rawPage),
          limit,
          signal,
        );
        return {
          entries: page.threads.map((thread) => ({
            kind: "review_thread",
            value: {
              id: thread.id,
              resolved: thread.isResolved,
              outdated: thread.isOutdated === true,
              path: thread.path,
              // GitHub nulls `line` once the code moved; the stale position stays in originalLine.
              line: thread.line ?? null,
              originalLine: thread.originalLine ?? null,
              commitId: page.headSha,
              comments: thread.comments.nodes.map(comment),
              // Parsed by the core port from untrusted bot text; passed through, never interpreted.
              finding: thread.finding ?? null,
            },
          })),
          nextCursor: page.hasNextPage ? `threads:${encodeURIComponent(page.endCursor)}` : null,
        };
      }
      if (source === "reviews" && ref.kind !== "pull") throw new Error("Issues have no PR reviews");
      const page = pageNumber(rawPage);
      const path = source === "normal" ? `${ref.path}/comments` : `repos/${ref.repository}/pulls/${ref.number}/reviews`;
      const { json, headers } = await client.request(
        `${path}?per_page=${pageSize(limit)}&page=${page}`,
        "GET",
        undefined,
        signal,
      );
      if (!Array.isArray(json)) throw new Error("Malformed GitHub comments");
      const entries = json.map((v) =>
        source === "normal"
          ? { kind: "normal", value: comment(v) }
          : { kind: "review_summary", value: { comment: comment(v), state: v.state, commitId: v.commit_id } },
      );
      const next = nextPage(headers, page);
      const nextCursor = next
        ? `${source}:${next}`
        : ref.kind !== "pull"
          ? null
          : source === "normal"
            ? "reviews:1"
            : core?.reviewThreads
              ? "threads:first"
              : null;
      return { entries, nextCursor };
    },
    async grouped(query, signal) {
      const page = await this.list(query, signal);
      const groups = new Map();
      if (!["state", "itemType"].includes(query.groupBy)) throw new Error("Unsupported GitHub grouping");
      for (const value of page.items) {
        const id = query.groupBy === "state" ? value.state.id : value.itemType;
        if (!groups.has(id)) groups.set(id, { id, name: id, items: [] });
        groups.get(id).items.push(value);
      }
      return { groups: [...groups.values()], nextCursor: page.nextCursor };
    },
    async board(projectId, query, signal) {
      const page = await projects.read(projectId, query, signal);
      const status = page.schemas.find((f) => f.name === "Status" && f.kind === "enum");
      if (!status) throw new Error("Project has no single-select Status field");
      const columns = [
        { id: "", name: "No status", action: { kind: "edit_field", value: { fieldId: status.id, value: null } } },
        ...status.options.map((o) => ({
          id: o.id,
          name: o.name,
          action: { kind: "edit_field", value: { fieldId: status.id, value: { kind: "enum", value: o.id } } },
        })),
      ];
      const board = { id: projectId, name: page.project.title, fieldId: status.id, columns };
      const index = this.boards.findIndex((b) => b.id === projectId);
      if (index < 0) this.boards.push(board);
      else this.boards[index] = board;
      const lanes = columns.map((c) => ({
        columnId: c.id,
        cards: page.items
          .filter((i) => (i.fields[status.id]?.value ?? "") === c.id)
          .map((i) => ({
            item: i,
            moves: columns
              .filter((other) => other.id !== c.id)
              .map((other) => ({ columnId: other.id, action: other.action })),
          })),
      }));
      return { board, lanes, nextCursor: page.nextCursor };
    },
    async projectItems(projectId, query, signal) {
      const page = await projects.read(projectId, query, signal);
      return { items: page.items, nextCursor: page.nextCursor, fields: page.schemas };
    },
    async runPrAction(reference, action, payload, signal) {
      if (parseReference(reference, accountId).kind !== "pull") throw new Error("PR actions require a pull request");
      if (!core?.prAction) throw new Error("Core PR-action port is unavailable");
      // Core owns head pinning, merge queue policy, review validation and request budgets.
      return core.prAction(reference, action, payload, signal);
    },
    async act(reference, action, signal) {
      signal?.throwIfAborted();
      if (action.kind === "create") {
        if (reference || action.value.itemType !== "issue" || !action.value.title.trim())
          throw new Error("Create requires an issue title and no existing reference");
        const body = { title: action.value.title, body: action.value.body, ...editFields(action.value.fields) };
        const { json } = await client.request(`repos/${repository}/issues`, "POST", body, signal);
        const created = item(json, accountId, repository, "issue");
        // No reload after the write: a failed read would surface as a failed create and invite a duplicate.
        return { kind: "item", value: compose(created, json, "issue", { entries: [], nextCursor: null }) };
      }
      const ref = parseReference(reference, accountId);
      if (action.kind === "start_work") {
        const v = action.value;
        if (!v.repoPath?.trim() || !v.branch?.trim() || !v.prompt?.trim() || !["draft", "submit"].includes(v.delivery))
          throw new Error("Invalid start-work intent");
        return { kind: "start_work", value: v };
      }
      if (action.kind === "edit_field" && action.value.fieldId.startsWith("project:")) {
        await projects.edit(reference, action.value, signal);
      } else if (action.kind === "edit_field") {
        await client.request(ref.path, "PATCH", editFields({ [action.value.fieldId]: action.value.value }), signal);
      } else if (action.kind === "comment") {
        if (!action.value.trim()) throw new Error("Comment cannot be empty");
        await client.request(`${ref.path}/comments`, "POST", { body: action.value }, signal);
      } else if (action.kind === "transition") {
        const transitions = {
          reopen: { state: "open" },
          "close:completed": { state: "closed", state_reason: "completed" },
          "close:not_planned": { state: "closed", state_reason: "not_planned" },
        };
        const body = transitions[action.value];
        if (!body || (ref.kind === "pull" && action.value === "close:not_planned"))
          throw new Error("Invalid GitHub transition");
        await client.request(ref.path, "PATCH", ref.kind === "pull" ? { state: body.state } : body, signal);
      } else throw new Error("Unsupported GitHub action");
      return { kind: "item", value: await this.detail(reference, signal) };
    },
  };
  return provider;
}

function editFields(fields) {
  const body = {};
  for (const [id, value] of Object.entries(fields)) {
    const kind = { title: "text", body: "markdown", labels: "labels", assignees: "user", milestone: "enum" }[id];
    if (!kind || (value !== null && value.kind !== kind)) throw new Error("Unsupported GitHub field");
    if (["title", "body"].includes(id)) {
      if (value && typeof value.value !== "string") throw new Error("Invalid text field");
      if (id === "title" && !value?.value.trim()) throw new Error("Title cannot be empty");
      body[id] = value?.value ?? "";
    } else if (id === "milestone") {
      if (value && !/^[1-9]\d*$/.test(value.value)) throw new Error("Invalid milestone");
      body.milestone = value ? Number(value.value) : null;
    } else {
      if (value && !Array.isArray(value.value)) throw new Error("Invalid list field");
      body[id] = (value?.value ?? []).map((v) => {
        if (typeof v.name !== "string" || !v.name.trim()) throw new Error("Invalid field option");
        return v.name;
      });
    }
  }
  return body;
}
