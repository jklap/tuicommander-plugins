# Markdown Kanban

A Kanban board rendered directly from checkbox tasks in a plain Markdown file.
There's no separate task database — the board *is* your `.md` file. Drag a
card to a new column and the plugin edits that line in place; edit the file
in your own editor and the board picks it up automatically.

This is a lighter-weight alternative to `wiz-kanban`: instead of one file per
task in a `stories/`/`plans/`/`reviews/` directory, everything lives on the
checkbox line itself, in any Markdown file you choose.

## Opening the board

Three ways in, so it's never more than a click or a shortcut away:

- **Settings → Plugins → Markdown Kanban → Kanban** (dashboard button)
- **Command Palette → "Open Kanban Board"** (rebindable — see Settings → Keybindings)
- **Right-click a terminal → Kanban Board**

## Boards

A "board" is just a path to a Markdown file. The first time you open the
panel there are no boards yet — click **Add Board** and pick a `.md`/
`.markdown` file. You can add as many boards as you like; a tab strip across
the top of the panel lets you switch between them, and only the active
board's tab is watched/rendered at a time.

- The board's display name is its frontmatter `title:` if the file has one,
  otherwise the filename without its extension.
- Adding a file that's already a board switches to it instead of creating a
  duplicate.
- The board list (and each board's own "hide archived" setting) is saved and
  restored the next time you open TUICommander.
- Closing the last remaining board doesn't close the panel — it drops back to
  the same "Add Board" empty state a first-time user sees.
- **Board files must live somewhere under your home directory.** This is a
  sandbox restriction shared by every TUICommander plugin, not something
  specific to md-kanban. Picking a file outside `$HOME` shows a friendly error
  instead of adding it.

## Task syntax

Any standard Markdown checkbox becomes a card:

```markdown
- [ ] Write the release notes
```

The character inside `[ ]` decides which column the card lands in:

| Character | Column | Written when you drag a card here |
|---|---|---|
| `(space)` | Ready | ` ` |
| `x` or `X` | Done | `x` |
| `/` | In Progress | `/` |
| `-` | Won't Fix | `-` |
| `?` | Blocked | `?` |
| `+`, `i`, `I`, or `!` | Pending | `+` |

Anything else inside the brackets (a status character the board doesn't
recognize) means the line isn't treated as a task at all — it's left exactly
as it is, so you can safely mix in checkbox lines that belong to some other
tool or convention.

Note that `+`, `i`, `I`, and `!` all read as **Pending** — but dragging *any*
card back to the Pending column always rewrites it to `+`. If you'd typed
`[i]` or `[!]` by hand, that distinction is lost the moment you drag the card,
by design.

Tasks nested under headings show a small label above the card body (e.g.
`SETUP / AUTH`), built from the heading path down to that task. Tasks inside
a fenced code block (\`\`\` or `~~~`) are never treated as tasks, so example
checklists in your docs won't show up on the board.

## Inline metadata

Everything after the checkbox is free text, plus optional `key:: value`
fields written either as `[key:: value]` or `(key:: value)`. Fields can
appear anywhere in the line and in any order.

### Priority

```markdown
- [ ] Fix the flaky test  [priority:: high]
```

Recognized values (case-insensitive): `highest`, `high`, `medium`, `low`,
`lowest`. Each renders as an emoji on the card and sets sort order within a
column (highest severity first, ties broken by the task's original order in
the file):

| Value | Emoji |
|---|---|
| `highest` | 🔺 |
| `high` | ⏫ |
| `medium` | 🔼 |
| *(no priority field)* | *(no emoji)* — sorts between `low` and `medium` |
| `low` | 🔽 |
| `lowest` | ⏬ |

### Tags

```markdown
- [ ] Investigate the memory leak  #bug #backend
```

Any `#word` (letters, digits, `_`, `-`, `/`) at the start of the line or after
whitespace becomes a tag badge on the card. A `#` inside a URL is never
picked up as a tag.

### Dependencies

Give a task an id, then reference that id from a task that depends on it:

```markdown
- [ ] Design the schema  [id:: eqodx8]
- [ ] Build the API  [dependsOn:: eqodx8]
```

- Cards without an id show a small **`#`** button ("Get ID"). Click it to
  generate a fresh 6-character id, write it into the file, and copy it to
  your clipboard — paste it straight into another task's `dependsOn`.
- `dependsOn` accepts a comma-separated list (`[dependsOn:: id1, id2]`) for a
  task with multiple upstream dependencies.
- Badges on a card: **`<`** (has upstream dependencies), **`>`** (has
  downstream dependents), **`!`** (an upstream dependency is lagging — see
  below). Hovering a badge highlights the related card(s), even across
  columns.
- An id that doesn't resolve to any task on the board renders as a muted
  **`<?`** badge with the unresolved id in its tooltip, rather than an error.

**"Lagging" (`!`) means an upstream dependency hasn't kept pace:**

- An upstream task that's **Blocked** always lags its downstream — whatever
  state the downstream is in.
- Otherwise, it lags if the upstream is behind the downstream on
  Pending → Ready → In Progress → Done/Won't Fix. Two tasks at the same stage
  (including Done vs. Won't Fix) never flag each other.
- A **downstream** task that's itself Blocked is treated as "Ready" for this
  comparison — Blocked is an open, stalled state, not a stage.

### Completion / cancellation dates

Dragging a card to **Done** writes `[completion:: YYYY-MM-DD]` (today's
date); dragging to **Won't Fix** writes `[cancelled:: YYYY-MM-DD]` instead.
Moving a card to any other column removes both fields. You normally never
type these by hand — they're maintained by the drag itself.

### Anything else

A field the board doesn't recognize (`[due:: 2026-09-15]`, `[owner:: sam]`,
your own convention, anything) is preserved exactly as written on every
rewrite — the board only ever touches the specific fields it understands.

### Links

Regular Markdown links in a task's text become clickable chips on the card:

```markdown
- [ ] Review the RFC  [see the doc](https://example.com/rfc)
- [ ] Update the config  [notes](../notes.md)
```

- `http(s)://` and `mailto:` links open externally (your browser / mail
  client).
- Anything else is treated as a file path, resolved relative to the board's
  own directory if it's not absolute, and opened as a new tab inside
  TUICommander.

## Moving cards

Drag a card to a different column to change its status — press and drag past
a small threshold (a plain click does nothing, so clicking a card by mistake
is harmless). Dropping updates the checkbox character and, for Done/Won't
Fix, the completion/cancellation date, in the source file.

If the file changed on disk between when the card was drawn and when you
drop it (e.g. someone else — or you, in an editor — edited it in the
meantime), the drag is discarded, a toast says so, and the board reloads with
the current file contents instead of overwriting the newer edit.

## Filtering

- **Search box** — filters cards by their visible text or tags (case
  insensitive, matches anywhere).
- **Hide archived (>5d)** — hides Done/Won't Fix cards whose completion or
  cancellation date is more than 5 days in the past. A task with no date, or
  a date the board can't parse, is never hidden by this — it can't be proven
  old. This setting is remembered per board.
- **Open file** — opens the board's own Markdown file as a normal tab, for
  when you want to edit it directly.

## Staying in sync

The active board's directory is watched while the panel is open. Edits made
outside TUICommander — your editor, `git checkout`, a script — are picked up
and re-rendered automatically, with a short debounce so a burst of saves
doesn't cause flicker. The panel only re-renders while it's actually visible;
switching away and back replays anything that happened while it was hidden.

## Capabilities

| Capability | Used for |
|---|---|
| `fs:read` / `fs:write` | Reading and rewriting board files |
| `fs:watch` | Auto-refreshing when a board file changes on disk |
| `ui:panel` | The board panel itself |
| `ui:markdown` | Opening the board file, or a relative link in it, as a tab |
| `ui:context-menu` | The terminal right-click "Kanban Board" entry |
| `ui:external-link` | Opening `http(s)`/`mailto` links from a card |
| `ui:file-picker` | The native "Add Board" file picker |

## Example

```markdown
# Project Alpha

## Backlog

- [ ] This is a basic task
- [ ] A task with a priority  [priority:: low]
- [ ] A task with a tag #tuicommander

### Setup

- [ ] A task that has to be done first  [id:: eqodx8]
- [ ] A task that has a dependency  [dependsOn:: eqodx8]
- [/] An in-progress task
- [x] A completed task  [completion:: 2026-09-14]
- [-] A cancelled task  [cancelled:: 2026-09-14]
- [?] A blocked/open question task
```

Opened as a board, this renders three tasks in **Ready**, one each in
**In Progress**, **Done**, and **Won't Fix**, and one in **Blocked** — with
"A task that has to be done first" showing a `>` badge (something depends on
it) and "A task that has a dependency" showing a `<` badge. Both start in
Ready, so neither flags a lag yet; drag "A task that has a dependency" to
In Progress while its upstream stays in Ready, and it picks up an `!` badge
warning that the task it depends on hasn't kept pace.
