import { buildJql, presets, search } from './query.js';

/** Four workers bound transition lookups for a page; no per-card cache can go stale. */
async function mapCards(items, project) {
  const results = new Array(items.length); let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await project(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  return results;
}

export function boardPort(client, toItem) {
  async function configuration(id) {
    if (!/^\d+$/.test(id)) throw new Error('Invalid Jira board ID');
    const config = await client.request(`/rest/agile/1.0/board/${id}/configuration`);
    if (!Array.isArray(config?.columnConfig?.columns) || !config.filter?.id) throw new Error('Invalid Jira board configuration');
    return config;
  }
  function columns(config) {
    return config.columnConfig.columns.map((column, index) => ({
      id: String(index), name: column.name,
      action: null,
    }));
  }
  function transitionFor(column, available) {
    const statuses = new Set(column.statuses.map((s) => String(s.id)));
    return available.find((t) => statuses.has(String(t.to.id)));
  }
  async function board(id, query) {
    const config = await configuration(id);
    // The board's saved filter owns membership; user's query only narrows it.
    // A selected preset supplies the narrowing; 'id IS NOT EMPTY' keeps resolved cards when neither is set.
    const hasPreset = presets.some((p) => p.id === query.savedFilterId);
    const jql = buildJql({ ...query, search: query.search || (hasPreset ? '' : 'id IS NOT EMPTY') });
    const orderAt = jql.search(/\s+ORDER\s+BY\s+/i);
    const predicate = orderAt < 0 ? jql : jql.slice(0, orderAt);
    const order = orderAt < 0 ? '' : jql.slice(orderAt);
    const page = await search(client, { ...query, filters: [], search: `filter = ${Number(config.filter.id)} AND (${predicate})${order}` }, false);
    const cards = await mapCards(page.issues, async (issue) => {
      const available = await client.request(`${client.api}/issue/${encodeURIComponent(issue.key)}/transitions`);
      return {
        item: toItem(issue),
        moves: config.columnConfig.columns.flatMap((column, index) => {
          const transition = transitionFor(column, available.transitions);
          return transition ? [{ columnId: String(index), action: { kind: 'transition', value: String(transition.id) } }] : [];
        }),
      };
    });
    const descriptors = columns(config);
    return {
      board: { id: String(config.id), name: config.name, fieldId: 'status', columns: descriptors },
      lanes: descriptors.map((column, index) => ({
        columnId: column.id,
        cards: cards.filter((card) => config.columnConfig.columns[index].statuses.some((s) => String(s.id) === card.item.state.id)),
      })), nextCursor: page.nextCursor,
    };
  }
  return { board };
}
