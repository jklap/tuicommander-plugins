import { pageNumber, pageSize } from "./client.js";

export const emptyQuery = () => ({
  filters: [],
  savedFilterId: null,
  search: "",
  sort: null,
  groupBy: null,
  cursor: null,
  limit: 50,
});
export const savedFilters = [
  ["open", "Open items", "is:open"],
  ["assigned", "Assigned to me", "is:open assignee:@me"],
  ["created", "Created by me", "author:@me"],
  ["pulls", "Pull requests", "is:pr"],
].map(([id, name, search]) => ({ id, name, query: { ...emptyQuery(), search } }));

export function searchPath(repository, query) {
  const preset = query.savedFilterId ? savedFilters.find((f) => f.id === query.savedFilterId) : null;
  if (query.savedFilterId && !preset) throw new Error("Unknown saved filter");
  const parts = [`repo:${repository}`, preset?.query.search ?? "", query.search];
  const qualifiers = { labels: "label", assignees: "assignee", state: "state", itemType: "is", milestone: "milestone" };
  for (const filter of query.filters) {
    const qualifier = qualifiers[filter.fieldId];
    if (!qualifier) throw new Error("Unsupported GitHub filter");
    for (const value of filter.values) {
      const values = ["labels", "user"].includes(value.kind) ? value.value.map((v) => v.name) : [value.value];
      for (const v of values) {
        if (typeof v !== "string") throw new Error("Invalid GitHub qualifier");
        parts.push(`${qualifier}:${JSON.stringify(v)}`);
      }
    }
  }
  const parameters = new URLSearchParams({
    q: parts.filter(Boolean).join(" "),
    per_page: String(pageSize(query.limit)),
    page: String(pageNumber(query.cursor)),
  });
  if (query.sort) {
    const sort = { updatedAt: "updated", createdAt: "created", comments: "comments" }[query.sort.fieldId];
    if (!sort) throw new Error("Unsupported GitHub sort");
    parameters.set("sort", sort);
    parameters.set("order", query.sort.descending ? "desc" : "asc");
  }
  return `search/issues?${parameters}`;
}
