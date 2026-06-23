# Agency Session Manager

A **TUI session manager** plugin for Agency / GitHub Copilot CLI. Browse, search,
and resume your past sessions from one interactive terminal picker — or from chat.

It covers **every Copilot CLI session kind**: sessions started with `agency copilot`
and with plain `copilot` are persisted to the *same* unencrypted store
(`~/.copilot/session-store.db`), so a single tool manages them all.

> The encrypted GitHub Copilot **desktop app** sessions (`~/.copilot/m-sessions`) are
> intentionally out of scope.

## Features

- ⚡ **Instant & AI-free** — the TUI reads the SQLite store directly and renders in
  milliseconds. It never calls a model, so there's no spin-up latency.
- 🖥️ **Interactive TUI** — arrow-key + paging navigation that scrolls your entire
  session history, with columns for age / date / repo·cwd / summary.
- 🔎 **Powerful query language** — beyond plain fuzzy matching: `includes:`/`excludes:`,
  `-term`/`!term` negation, field filters (`repo:`/`branch:`/`cwd:`), and date bounds
  `before:`/`after:` (`since:`/`until:`) with flexible dates (`today-3`, `now-2h`,
  `june 22 15:00`, ISO). Bare words still fuzzy-match and rank by relevance.
- 🔁 **One-key resume** — `Enter` drops you straight into the selected session.
- 🔀 **Launcher toggle** — `Tab` switches between `agency copilot` (default, re-applies
  your Agency plugins/skills) and plain `copilot`.
- 💬 **In-chat mode** — a bundled skill lets Copilot list/search/resume sessions for you
  conversationally ("resume my session about the design review").
- 📦 **Zero dependencies** — pure Node using the built-in `node:sqlite`. Nothing to
  `npm install`.

## Requirements

- **Node.js ≥ 22.5** (for built-in `node:sqlite`; developed against Node 24).
- A Copilot CLI session store at `~/.copilot/session-store.db` (created automatically
  the first time you run `copilot` / `agency copilot`).

## Usage

### Interactive TUI (recommended — instant, no AI)

Launch the full-screen picker directly. It loads near-instantly and never invokes a
model:

```bash
node bin/session-manager.mjs
# or the bundled wrappers:
bin/picksession.cmd        # Windows
bin/picksession.ps1        # PowerShell / cross-platform
```

For one-keystroke access, add a shell alias pointing at `bin/session-manager.mjs`
(e.g. a PowerShell `$PROFILE` function named `picksession`).

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `PgUp` / `PgDn` | Page up / down |
| `Home` / `End` | Jump to first / last |
| *type* | **Search** with the query language below |
| `Backspace` | Edit the filter |
| `Enter` | Resume the selected session |
| `Tab` | Toggle launcher (`agency copilot` ⇄ `copilot`) |
| `Esc` / `Ctrl-C` | Quit |

### Query language

The search box (and `--search`) accept a small query language. Tokens are
space-separated; wrap a multi-word value in `"double quotes"`.

| Syntax | Meaning |
| --- | --- |
| `design review` | bare words **fuzzy-match** and rank by relevance (AND) |
| `"exact phrase"` | quoted = **substring** match (must contain) |
| `includes:csat` / `+csat` | substring filter — text **must contain** `csat` |
| `includes:"two words"` / `+"two words"` | quote the value to match a **phrase with spaces** |
| `excludes:automated` / `-automated` / `!automated` | substring filter — must **not** contain |
| `excludes:"two words"` / `-"two words"` | quote to exclude a **phrase with spaces** |
| `repo:swarm` | field filter on repo/location |
| `branch:main` | field filter on branch |
| `cwd:proj` | field filter on the working directory path |
| `id:042c` | field filter on session id |
| `before:<date>` / `until:<date>` | only sessions updated at/before the date |
| `after:<date>` / `since:<date>` | only sessions updated at/after the date |

**Dates** (case-insensitive) accept: `now`, `now-2h`, `now+30m` (units `s m h d w`);
`today`, `today-3`, `today+1`, `yesterday`, `tomorrow`; ISO `2026-06-22` /
`2026-06-22T15:00`; a bare time `15:00` (today); or a month phrase `june 22`,
`jun 22 2026`, `june 22 15:00`. For the `key:value` form with a spaced date, quote
it: `before:"june 22 15:00"` — or use the spaced form `before june 22 15:00`.

Example:

```bash
node bin/session-manager.mjs --list \
  --search 'includes:csat excludes:automated before:today-3 after june 22 15:00'
```

### Non-interactive / scripting

```bash
# List the 20 most recent sessions
node bin/session-manager.mjs --list --limit 20

# Search (query language: fuzzy + operators)
node bin/session-manager.mjs --list --search "repo:swarm -security review"

# Machine-readable
node bin/session-manager.mjs --list --json --limit 50

# Print the resume command for a session id
node bin/session-manager.mjs --resume-cmd <session-id>            # agency copilot (default)
node bin/session-manager.mjs --resume-cmd <session-id> --copilot  # plain copilot

# Render one TUI frame (layout sanity check, no TTY needed)
node bin/session-manager.mjs --preview 12 100
```

### In-chat (conversational)

The bundled skill lets Copilot find and resume sessions for you from chat — e.g.
"list my recent sessions" or "resume my session about the design review". This path
*does* use the model; for an instant pick, run the TUI above.

## How it works

`agency copilot` launches the GitHub Copilot CLI binary (cached by Agency) which
reads/writes `~/.copilot/session-store.db` — exactly the same store plain `copilot`
uses. This tool opens that SQLite DB **read-only** and lists the `sessions` table
(id, cwd, repository, branch, summary, timestamps), then resumes a chosen session via
`agency copilot --resume=<id>` or `copilot --resume=<id>`.

Override the store location with the `COPILOT_SESSION_STORE` environment variable.

## Project layout

```
bin/session-manager.mjs        # TUI + CLI entry point
bin/picksession.cmd            # instant launcher (Windows)
bin/picksession.ps1            # instant launcher (PowerShell)
lib/sessions.mjs               # read-only session-store access + fuzzy matching
lib/query.mjs                  # search query-language parser (operators + dates)
skills/session-manager/SKILL.md# in-chat skill (list/search/resume)
test/smoke.mjs                 # smoke tests (logic + CLI surface)
.claude-plugin/plugin.json     # plugin manifest
agency.json                    # Agency plugin manifest
```

## Development

```bash
node test/smoke.mjs   # or: npm test
```

## Installing as an Agency plugin

From a local checkout:

```bash
agency plugin install --help   # see options for installing from a local dir / marketplace
```

Or load the skill ad hoc with the Copilot CLI:

```bash
copilot --plugin-dir .
```

## License

MIT
