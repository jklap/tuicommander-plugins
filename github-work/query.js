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
  const qualifiers = { labels: "label", assignees: "assignee", state: "state", itemType: "is" };
  const itemTypes = { pull: "pr", issue: "issue" };
  const text = (v) => {
    if (typeof v !== "string") throw new Error("Invalid GitHub qualifier");
    return JSON.stringify(v);
  };
  for (const filter of query.filters) {
    const qualifier = qualifiers[filter.fieldId];
    if (!qualifier) throw new Error("Unsupported GitHub filter");
    const multi = ["labels", "assignees"].includes(filter.fieldId);
    if (multi) {
      // Values are alternatives (ORed): GitHub ORs only inside one comma-joined qualifier.
      const groups = filter.values.map((v) => (["labels", "user"].includes(v.kind) ? v.value.map((x) => x.name) : [v.value]));
      const names = groups.flat();
      if (!names.length) {
        parts.push(`no:${qualifier}`); // An empty filter means "unset".
      } else if (groups.length === 1) {
        for (const n of names) parts.push(`${qualifier}:${text(n)}`); // One value = a set that must all match.
      } else if (groups.some((g) => g.length !== 1)) {
        throw new Error("Unsupported GitHub filter: alternatives of multi-value sets");
      } else {
        parts.push(`${qualifier}:${names.map(text).join(",")}`);
      }
    } else if (filter.fieldId === "itemType") {
      if (filter.values.length !== 1) throw new Error("Unsupported GitHub filter: one item type only");
      const type = itemTypes[filter.values[0].value];
      if (!type) throw new Error("Invalid GitHub qualifier");
      parts.push(`is:${type}`);
    } else {
      for (const value of filter.values) parts.push(`${qualifier}:${text(value.value)}`);
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
