# Agency Session Manager

A **TUI session manager** plugin for Agency / GitHub Copilot CLI. Browse, search,
and resume your past sessions from one interactive terminal picker — or from chat.

It covers **every Copilot CLI session kind**: sessions started with `agency copilot`
and with plain `copilot` are persisted to the *same* unencrypted store
(`~/.copilot/session-store.db`), so a single tool manages them all.

> The encrypted GitHub Copilot **desktop app** sessions (`~/.copilot/m-sessions`) are
> intentionally out of scope.

## Features

- 🖥️ **Interactive TUI** — arrow-key navigation, live fuzzy-ish substring filtering,
  columns for age / repo·cwd / summary.
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

### Interactive TUI

```bash
node bin/session-manager.mjs
```

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `PgUp` / `PgDn` | Page up / down |
| *type* | Filter (summary, cwd, repo, branch, id) |
| `Backspace` | Edit the filter |
| `Enter` | Resume the selected session |
| `Tab` | Toggle launcher (`agency copilot` ⇄ `copilot`) |
| `Esc` / `Ctrl-C` | Quit |

### Non-interactive / scripting

```bash
# List the 20 most recent sessions
node bin/session-manager.mjs --list --limit 20

# Search
node bin/session-manager.mjs --list --search "design review"

# Machine-readable
node bin/session-manager.mjs --list --json --limit 50

# Print the resume command for a session id
node bin/session-manager.mjs --resume-cmd <session-id>            # agency copilot (default)
node bin/session-manager.mjs --resume-cmd <session-id> --copilot  # plain copilot

# Render one TUI frame (layout sanity check, no TTY needed)
node bin/session-manager.mjs --preview 12 100
```

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
lib/sessions.mjs               # read-only session-store access + helpers
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
