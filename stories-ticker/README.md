# Stories Ticker

Shows the number of open Markdown stories in the active repository's `stories/` directory.

Files containing `-complete-` or `-wontfix-` in their names are considered closed. The count refreshes when the active repository changes or its stories directory is modified.

## Capabilities

- `fs:list` — count Markdown story files
- `fs:watch` — react to story directory changes
- `ui:ticker` — publish the count in the shared status bar ticker
