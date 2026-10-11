export const field = (id, name, kind, editable = true, options = []) => ({
  id,
  name,
  kind,
  required: false,
  editable,
  options,
});
export const FIELDS = [
  field("title", "Title", "text"),
  field("body", "Description", "markdown"),
  field("state", "State", "enum", false, [
    { id: "open", name: "Open" },
    { id: "closed", name: "Closed" },
  ]),
  field("assignees", "Assignees", "user"),
  field("labels", "Labels", "labels"),
  field("milestone", "Milestone", "enum"),
  field("url", "URL", "link", false),
];
export const user = (value) => ({
  id: String(value?.id ?? value?.login ?? "deleted"),
  name: value?.login ?? "Deleted user",
  avatarUrl: value?.avatar_url ?? value?.avatarUrl ?? null,
});
export const comment = (value) => ({
  id: String(value.id),
  author: user(value.user ?? value.author),
  body: value.body ?? "",
  createdAt: value.created_at ?? value.submitted_at ?? value.createdAt,
  url: value.html_url ?? value.url ?? null,
});

export function identity(repository, kind, number) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) ||
    [".", ".."].includes(repository.split("/")[1]) ||
    !["issue", "pull"].includes(kind) ||
    !/^[1-9]\d*$/.test(String(number))
  ) {
    throw new Error("Invalid GitHub item identity");
  }
  return `${repository}/${kind}/${number}`;
}

export function parseReference(reference, accountId) {
  if (reference?.providerId !== "github" || reference.accountId !== accountId)
    throw new Error("Item belongs to another provider/account");
  const parts = reference.id.split("/");
  if (parts.length !== 4) throw new Error("Invalid GitHub item identity");
  const repository = `${parts[0]}/${parts[1]}`;
  identity(repository, parts[2], parts[3]);
  return { repository, kind: parts[2], number: Number(parts[3]), path: `repos/${repository}/issues/${parts[3]}` };
}

export function item(value, accountId, repository, kind) {
  if (
    !value ||
    !Number.isInteger(value.number) ||
    typeof value.title !== "string" ||
    !["open", "closed"].includes(value.state)
  ) {
    throw new Error("Malformed GitHub item");
  }
  const url = new URL(value.html_url);
  const repo = repository ?? url.pathname.split("/").slice(1, 3).join("/");
  const type = kind ?? (value.pull_request || url.pathname.includes("/pull/") ? "pull" : "issue");
  const assignees = (value.assignees ?? []).map(user);
  const labels = (value.labels ?? []).map((l) => ({ id: l.name, name: l.name }));
  return {
    reference: { providerId: "github", accountId, id: identity(repo, type, value.number) },
    key: `${repo}#${value.number}`,
    title: value.title,
    itemType: type,
    state: {
      id: value.state,
      name: value.state === "open" ? "Open" : value.merged_at ? "Merged" : "Closed",
      tone: value.state === "open" ? "info" : "success",
    },
    assignees,
    labels,
    updatedAt: value.updated_at,
    url: value.html_url,
    fields: {
      title: { kind: "text", value: value.title },
      body: { kind: "markdown", value: value.body ?? "" },
      state: { kind: "enum", value: value.state },
      assignees: { kind: "user", value: assignees },
      labels: { kind: "labels", value: labels },
      url: { kind: "link", value: value.html_url },
      milestone: value.milestone ? { kind: "enum", value: String(value.milestone.number) } : null,
    },
  };
}

export function resolveUrl(value, accountId, webOrigin = "https://github.com") {
  const url = new URL(value);
  if (url.origin !== new URL(webOrigin).origin || url.username || url.password)
    throw new Error("URL is outside the GitHub account host");
  const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (!match) throw new Error("URL is not a GitHub issue or pull request");
  return {
    providerId: "github",
    accountId,
    id: identity(`${match[1]}/${match[2]}`, match[3] === "pull" ? "pull" : "issue", match[4]),
  };
}
