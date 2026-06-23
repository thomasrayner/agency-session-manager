#!/usr/bin/env node
// Agency Session Manager — interactive TUI to browse & resume Copilot CLI sessions.
//
// Covers every CLI session kind (`agency copilot` and plain `copilot`) since they
// share ~/.copilot/session-store.db.
//
// Modes:
//   (default)                 launch the interactive TUI
//   --list [--json]           print sessions (non-interactive; used by the skill)
//   --resume-cmd <id>         print the resume command for a session id
// Flags: --limit N  --search Q  --copilot (default launcher = agency)
//
// Zero dependencies: built-in node:sqlite + raw TTY + ANSI.

import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  loadSessions,
  filterSessions,
  relativeAge,
  locationLabel,
  resumeCommand,
  appendKeyChunk,
} from "../lib/sessions.mjs";

// ---------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const out = { _: [], limit: 0, search: "", json: false, copilot: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--preview") out.preview = true;
    else if (a === "--resume-cmd") out.resumeCmd = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--copilot") out.copilot = true;
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10) || 0;
    else if (a === "--search") out.search = argv[++i] || "";
    else if (a === "-h" || a === "--help") out.help = true;
    else out._.push(a);
  }
  return out;
}

const HELP = `Agency Session Manager

Usage:
  session-manager                 Interactive TUI (browse & resume)
  session-manager --list [--json] [--limit N] [--search Q]
  session-manager --resume-cmd <id> [--copilot]

Keys (TUI):
  ↑/↓            move        PgUp/PgDn   page
  type           filter      Backspace   edit filter
  Enter          resume selected session
  Tab            toggle launcher (agency copilot ⇄ copilot)
  Esc / Ctrl-C   quit
`;

// ----------------------------------------------------------- non-interactive
function runList(args) {
  const sessions = loadSessions({
    limit: args.limit || 50,
    search: args.search,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
    return;
  }
  if (!sessions.length) {
    process.stdout.write("No sessions found.\n");
    return;
  }
  const launcher = args.copilot ? "copilot" : "agency";
  const dim = process.stdout.isTTY ? "\x1b[2m" : "";
  const reset = process.stdout.isTTY ? "\x1b[0m" : "";
  sessions.forEach((s, i) => {
    const n = String(i + 1).padStart(2);
    const age = relativeAge(s.updatedMs).padStart(4);
    const loc = locationLabel(s);
    let sum = s.summary || "(no summary)";
    if (sum.length > 100) sum = sum.slice(0, 99) + "\u2026";
    const { display } = resumeCommand(s.id, launcher);
    process.stdout.write(`${n}. ${age}  ${loc}  \u2014  ${sum}\n`);
    process.stdout.write(`    ${dim}${display}${reset}\n`);
  });
  process.stdout.write(
    `\n${dim}Copy a resume command above and run it to resume that session.${reset}\n`
  );
}

function runResumeCmd(args) {
  const id = args.resumeCmd;
  if (!id) {
    process.stderr.write("error: --resume-cmd requires a session id\n");
    process.exit(2);
  }
  const launcher = args.copilot ? "copilot" : "agency";
  process.stdout.write(resumeCommand(id, launcher).display + "\n");
}

// ------------------------------------------------------------------ ANSI/TUI
const ESC = "\x1b";
const ansi = {
  altOn: `${ESC}[?1049h`,
  altOff: `${ESC}[?1049l`,
  clear: `${ESC}[2J${ESC}[H`,
  home: `${ESC}[H`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  inverse: `${ESC}[7m`,
  cyan: `${ESC}[36m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  gray: `${ESC}[90m`,
};

function visibleSlice(str, width) {
  // Plain truncation (content is ASCII-ish); guard against undefined.
  str = String(str ?? "");
  if (str.length <= width) return str.padEnd(width);
  if (width <= 1) return str.slice(0, width);
  return str.slice(0, width - 1) + "…";
}

// Visible length of a string ignoring ANSI escape sequences.
function stripLen(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Compact local date label, e.g. "Jun 17 14:32" or "2025 Jun 17" for old items.
function shortDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const mon = d.toLocaleString("en-US", { month: "short" });
  const day = String(d.getDate()).padStart(2, " ");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  if (sameYear) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${mon} ${day} ${hh}:${mm}`;
  }
  return `${d.getFullYear()} ${mon} ${day}`;
}

// Pure frame builder — assembles the screen as a string. No IO, so it is
// directly testable and reused by both the live TUI and `--preview`.
function buildFrame(state, cols, rows) {
  const { all, filtered, selected, scroll, search, launcher } = state;
  const win = Math.max(3, rows - 3); // header(2) + footer(1)
  const lines = [];

  const launcherLabel = launcher === "agency" ? "agency copilot" : "copilot";
  const title = `${ansi.bold}${ansi.cyan}▌Sessions${ansi.reset}`;
  const right = `${ansi.dim}↵ resumes via ${ansi.reset}${ansi.green}${launcherLabel}${ansi.reset} ${ansi.dim}· Tab toggles${ansi.reset}`;
  lines.push(` ${title}  ${right}`);

  // Search / status line: live query + position + count.
  const pos = filtered.length ? `${selected + 1}/${filtered.length}` : "0/0";
  const matchInfo =
    search && filtered.length !== all.length
      ? `${filtered.length} of ${all.length}`
      : `${all.length}`;
  const prompt = `${ansi.yellow}🔍 ${search}${ansi.reset}${ansi.dim}▏${ansi.reset}`;
  const status = `${ansi.dim}${pos} · ${matchInfo} sessions${ansi.reset}`;
  const padN = Math.max(1, cols - stripLen(prompt) - stripLen(status) - 2);
  lines.push(` ${prompt}${" ".repeat(padN)}${status}`);

  // Columns: marker(2) age(5) date(11) loc summary
  const ageW = 5;
  const dateW = 12;
  const locW = Math.min(28, Math.max(12, Math.floor(cols * 0.24)));
  const sumW = Math.max(10, cols - 2 - ageW - dateW - locW - 5);

  if (filtered.length === 0) {
    lines.push("");
    lines.push(`   ${ansi.dim}No sessions match “${search}”.${ansi.reset}`);
    while (lines.length < win + 2) lines.push("");
  } else {
    for (let i = 0; i < win; i++) {
      const idx = scroll + i;
      if (idx >= filtered.length) {
        lines.push("");
        continue;
      }
      const s = filtered[idx];
      const age = visibleSlice(relativeAge(s.updatedMs), ageW);
      const date = visibleSlice(shortDate(s.updatedMs), dateW);
      const loc = visibleSlice(locationLabel(s), locW);
      const sum = visibleSlice(s.summary || "(no summary)", sumW);
      if (idx === selected) {
        const raw = `▶ ${age} ${date} ${loc} ${sum}`;
        lines.push(`${ansi.inverse}${raw}${ansi.reset}`);
      } else {
        lines.push(
          `  ${ansi.gray}${age}${ansi.reset} ${ansi.dim}${date}${ansi.reset} ${ansi.green}${loc}${ansi.reset} ${sum}`
        );
      }
    }
  }

  const help = `${ansi.dim} ↑/↓ PgUp/PgDn Home/End · type to search · incl:/excl:/repo:/before:/after: · Enter resume · Tab launcher · Esc quit${ansi.reset}`;
  lines.push(help);
  return lines.join("\r\n");
}

// Render one frame to stdout without entering raw mode — used to sanity-check
// layout in non-interactive environments.
function runPreview(args) {
  const rows = args._[0] ? parseInt(args._[0], 10) : 12;
  const cols = args._[1] ? parseInt(args._[1], 10) : 100;
  const all = loadSessions({});
  const filtered = filterSessions(all, args.search || "");
  const state = {
    all,
    filtered,
    selected: 0,
    scroll: 0,
    search: args.search || "",
    launcher: args.copilot ? "copilot" : "agency",
  };
  process.stdout.write(buildFrame(state, cols, rows) + "\n");
}


function runTui() {
  const { stdin, stdout } = process;
  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write(
      "The TUI requires an interactive terminal. Use --list for non-interactive output.\n"
    );
    process.exit(1);
  }

  let all = loadSessions({});
  let launcher = "agency"; // default per design
  let search = "";
  let filtered = all;
  let selected = 0;
  let scroll = 0;

  function applyFilter() {
    filtered = filterSessions(all, search);
    // Keep selection in range; jump to top when actively filtering.
    if (search) {
      selected = 0;
      scroll = 0;
    } else if (selected >= filtered.length) {
      selected = Math.max(0, filtered.length - 1);
    }
  }

  function rowsAvailable() {
    return Math.max(3, (stdout.rows || 24) - 3); // header(2) + footer(1)
  }

  function ensureVisible() {
    const win = rowsAvailable();
    if (selected < scroll) scroll = selected;
    else if (selected >= scroll + win) scroll = selected - win + 1;
    if (scroll < 0) scroll = 0;
  }

  function render() {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    ensureVisible();
    const frame = buildFrame(
      { all, filtered, selected, scroll, search, launcher },
      cols,
      rows
    );
    stdout.write(ansi.home + ansi.clear + frame);
  }

  function cleanup() {
    try {
      stdin.setRawMode(false);
    } catch {}
    stdin.pause();
    stdout.write(ansi.showCursor + ansi.altOff);
  }

  function quit(code = 0) {
    cleanup();
    process.exit(code);
  }

  function resumeSelected() {
    if (!filtered.length) return;
    const s = filtered[selected];
    const { cmd, args, display } = resumeCommand(s.id, launcher);
    cleanup();
    process.stdout.write(`\nResuming: ${display}\n\n`);
    const res = spawnSync(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    process.exit(res.status ?? 0);
  }

  // --- input handling
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.write(ansi.altOn + ansi.hideCursor);
  applyFilter();
  render();

  stdout.on("resize", render);

  stdin.on("data", (key) => {
    // Ctrl-C
    if (key === "\x03") return quit(0);
    // Escape (bare)
    if (key === "\x1b") return quit(0);

    // Escape sequences (arrows, page, home/end)
    if (key.startsWith("\x1b[") || key.startsWith("\x1bO")) {
      const code = key.slice(2);
      const win = rowsAvailable();
      switch (code) {
        case "A": // up
          selected = Math.max(0, selected - 1);
          break;
        case "B": // down
          selected = Math.min(filtered.length - 1, selected + 1);
          break;
        case "5~": // PgUp
          selected = Math.max(0, selected - win);
          break;
        case "6~": // PgDn
          selected = Math.min(filtered.length - 1, selected + win);
          break;
        case "H": // Home
        case "1~":
          selected = 0;
          break;
        case "F": // End
        case "4~":
          selected = Math.max(0, filtered.length - 1);
          break;
        default:
          return; // ignore other sequences
      }
      return render();
    }

    // Enter
    if (key === "\r" || key === "\n") return resumeSelected();

    // Tab — toggle launcher
    if (key === "\t") {
      launcher = launcher === "agency" ? "copilot" : "agency";
      return render();
    }

    // Backspace / Delete
    if (key === "\x7f" || key === "\b") {
      if (search.length) {
        search = search.slice(0, -1);
        applyFilter();
        render();
      }
      return;
    }

    // vi-style nav is intentionally NOT bound: printable keys build the live
    // filter instead, which is the primary navigation aid.
    if (key === "\x0b") return; // ignore Ctrl-K

    // Printable text -> append to the search filter. A single `data` event can
    // carry MANY characters (fast typing, paste, or buffered input), so process
    // the whole chunk rather than only single keystrokes.
    const res = appendKeyChunk(search, key);
    if (res.changed) {
      search = res.search;
      applyFilter();
      render();
    }
    return;
  });
}

// --------------------------------------------------------------------- main
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
} else if (args.list) {
  runList(args);
} else if (args.preview) {
  runPreview(args);
} else if (args.resumeCmd) {
  runResumeCmd(args);
} else {
  runTui();
}
