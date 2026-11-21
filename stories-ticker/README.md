# Stories Ticker

Shows the active repository's open story count from the same selected backend and Rust projection as Plans and Stories: all non-archived plans, open non-archived stories, with no story-type filter.

Automatic Wiz selection reads through the approved installed connector. An explicit native override counts native records. Custom story directories, linked worktrees, status parsing and closed/archive scope are handled by the backend, not inferred from filenames by the plugin.

The count refreshes on repository revisions, story and workflow changes, backend selection/approval changes, and browser reconnect. Zero, unavailable backends and failed reads clear the ticker; there is no filesystem or native fallback. Repository changes and unload invalidate late reads and dispose the old subscription.

## Capabilities

- `stories:read` — read backend identity and aggregate open count, and subscribe to invalidations; no story content or writes
- `ui:ticker` — publish the count in the shared status bar ticker
