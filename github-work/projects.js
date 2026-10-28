import { field, item } from "./model.js";
import { GitHubError, pageSize } from "./client.js";

const PROJECT = `query Project($id:ID!,$after:String,$limit:Int!) { node(id:$id) { ... on ProjectV2 {
 id title fields(first:100) { nodes { ... on ProjectV2Field { id name dataType }
 ... on ProjectV2SingleSelectField { id name dataType options { id name } } } }
 items(first:$limit,after:$after) { pageInfo { hasNextPage endCursor } nodes { id
 content { ... on Issue { number title url state updatedAt repository { nameWithOwner }
 assignees(first:100) { nodes { id login avatarUrl } } labels(first:100) { nodes { id name } } }
 ... on PullRequest { number title url state updatedAt repository { nameWithOwner }
 assignees(first:100) { nodes { id login avatarUrl } } labels(first:100) { nodes { id name } } } }
 fieldValues(first:100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2SingleSelectField { id } } }
 ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { id } } }
 ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id } } }
 ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { id } } } } } } } } } }`;

const SCOPE_MESSAGE = "Projects writes require the project scope. Log in again in Settings > Git & GitHub, or update your token and grant organization access.";
const ACCESS_MESSAGE = "GitHub denied writes to this project. Grant project write and organization access, or log in again with the project scope. Reload Tasks after updating access.";

/** Projects metadata is always read from GitHub, never inferred from issue state. */
export class Projects {
  constructor(client, accountId) {
    this.client = client;
    this.accountId = accountId;
    this.memberships = new Map();
    this.fields = new Map();
    this.writeDenials = new Map();
  }
  writeDisabledReason(projectId) {
    if (this.client.oauthScopes && !this.client.oauthScopes.includes("project")) return SCOPE_MESSAGE;
    return this.writeDenials.get(projectId) ?? null;
  }
  async list(signal) {
    const boards = [];
    const cursors = new Set();
    let after = null;
    do {
      const data = await this.client.graphql(
        'query UserProjects($after:String) { viewer { projectsV2(first:100,after:$after) { nodes { id title } pageInfo { hasNextPage endCursor } } } }',
        { after }, signal,
      );
      const page = data.viewer?.projectsV2;
      if (!Array.isArray(page?.nodes) || !page.pageInfo) throw new Error('Invalid GitHub Projects response');
      for (const node of page.nodes) {
        if (typeof node?.id !== 'string' || typeof node.title !== 'string') throw new Error('Invalid GitHub project');
        if (!boards.some((board) => board.id === node.id)) boards.push({ id: node.id, name: node.title, fieldId: '', columns: [] });
      }
      if (!page.pageInfo.hasNextPage) return boards;
      after = page.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw new Error('GitHub Projects cursor did not advance');
      cursors.add(after);
    } while (cursors.size <= 100);
    throw new Error('GitHub Projects discovery exceeds 100 pages');
  }
  async read(projectId, query, signal) {
    // Projects filtering/search differs from issue search; do not silently ignore a query.
    if (query.search || query.filters.length || query.savedFilterId || query.sort)
      throw new Error("Projects query filters are not supported");
    const data = await this.client.graphql(
      PROJECT,
      { id: projectId, after: query.cursor, limit: pageSize(query.limit) },
      signal,
    );
    const project = data.node;
    if (!project?.items?.nodes || !project.fields?.nodes) throw new Error("Missing GitHub project");
    const schemas = project.fields.nodes.flatMap((f) => {
      const kind = { TEXT: "text", DATE: "date", NUMBER: "number", SINGLE_SELECT: "enum" }[f.dataType];
      if (!kind) return [];
      const schema = field(`project:${projectId}:${f.id}`, f.name, kind, !this.writeDisabledReason(projectId), f.options ?? []);
      this.fields.set(schema.id, { projectId, fieldId: f.id, schema });
      return [schema];
    });
    const items = project.items.nodes.flatMap((node) => {
      const c = node.content;
      if (!c?.repository) return []; // Draft issues have no repository item identity.
      const mapped = item(
        {
          number: c.number,
          title: c.title,
          html_url: c.url,
          state: c.state === "OPEN" ? "open" : "closed",
          // Projects reports MERGED as a state; the item model reads merged_at.
          merged_at: c.state === "MERGED" ? c.updatedAt : null,
          updated_at: c.updatedAt,
          labels: c.labels.nodes,
          assignees: c.assignees.nodes,
        },
        this.accountId,
        c.repository.nameWithOwner,
      );
      this.memberships.set(`${projectId}:${mapped.reference.id}`, node.id);
      for (const value of node.fieldValues.nodes) {
        const id = `project:${projectId}:${value.field?.id}`;
        const definition = this.fields.get(id);
        if (!definition) continue;
        const raw = value.optionId ?? value.date ?? value.number ?? value.text;
        mapped.fields[id] = raw == null ? null : { kind: definition.schema.kind, value: raw };
      }
      return [mapped];
    });
    const page = project.items.pageInfo;
    return { project, schemas, items, nextCursor: page.hasNextPage ? page.endCursor : null };
  }
  // DEFERRED (2026-10-25) — live mutation round trip needs an explicitly authorized scratch project.
  async mutate(projectId, query, variables, signal) {
    try {
      return await this.client.graphql(query, variables, signal);
    } catch (error) {
      // A project-local authorization rejection must never disable repository actions.
      if (error instanceof GitHubError && (
        error.types.some((type) => ["FORBIDDEN", "INSUFFICIENT_SCOPES"].includes(type)) ||
        (error.status === 403 && /resource not accessible|forbidden|not authorized|permission|SAML|SSO/i.test(error.message))
      )) {
        this.writeDenials.set(projectId, ACCESS_MESSAGE);
        for (const field of this.fields.values()) if (field.projectId === projectId) field.schema.editable = false;
        throw new Error(`${this.writeDisabledReason(projectId)} ${error.message}`);
      }
      throw error;
    }
  }
  async edit(reference, edit, signal) {
    const definition = this.fields.get(edit.fieldId);
    if (!definition) throw new Error("Load the project before editing its fields");
    const { projectId, fieldId, schema } = definition;
    const reason = this.writeDisabledReason(projectId);
    if (reason) throw new Error(reason);
    const itemId = this.memberships.get(`${projectId}:${reference.id}`);
    if (!itemId) throw new Error("Item is not a loaded member of this project");
    const input = { projectId, itemId, fieldId };
    if (edit.value === null) {
      return this.mutate(projectId,
        "mutation Clear($input:ClearProjectV2ItemFieldValueInput!) { clearProjectV2ItemFieldValue(input:$input) { projectV2Item { id } } }",
        { input },
        signal,
      );
    }
    if (edit.value.kind !== schema.kind) throw new Error("Project field kind mismatch");
    const v = edit.value.value;
    if (schema.kind === "enum" && !schema.options.some((o) => o.id === v)) throw new Error("Unknown project option");
    if (schema.kind === "number" ? !Number.isFinite(v) : typeof v !== "string")
      throw new Error("Invalid project value");
    if (schema.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("Invalid project date");
    input.value = { [{ enum: "singleSelectOptionId", date: "date", number: "number", text: "text" }[schema.kind]]: v };
    return this.mutate(projectId,
      "mutation Move($input:UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input:$input) { projectV2Item { id } } }",
      { input },
      signal,
    );
  }
}
