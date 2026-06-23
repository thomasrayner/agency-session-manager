// Shared session-store access for the Agency Session Manager plugin.
// Zero-dependency: uses Node's built-in node:sqlite (Node >= 22.5, stable-ish in 24).
//
// Both `agency copilot` and plain `copilot` persist to the SAME store:
//   ~/.copilot/session-store.db  (table `sessions`)
// so a single reader covers every CLI session kind.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Silence only the "SQLite is an experimental feature" notice so --json/--list
// output and the TUI stay clean. Installed before the import that triggers it.
const _origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const msg = typeof warning === "string" ? warning : warning?.message || "";
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return _origEmitWarning(warning, ...rest);
};

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (err) {
  throw new Error(
    "node:sqlite is unavailable. Node 22.5+ (ideally 24+) is required for the session manager.\n" +
      `Underlying error: ${err.message}`
  );
}

export function defaultDbPath() {
  return (
    process.env.COPILOT_SESSION_STORE ||
    path.join(os.homedir(), ".copilot", "session-store.db")
  );
}

// Open the store read-only so we never interfere with a live CLI session.
export function openDb(dbPath = defaultDbPath()) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `Copilot session store not found at: ${dbPath}\n` +
        "Run a Copilot CLI session first, or set COPILOT_SESSION_STORE."
    );
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function toTime(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Load sessions, newest first.
 * @param {object} opts
 * @param {string} [opts.dbPath]
 * @param {number} [opts.limit]            cap rows returned (0 = no cap)
 * @param {string} [opts.search]           case-insensitive substring filter
 * @param {boolean} [opts.includeEmpty]    include sessions with no summary/cwd (default true)
 * @returns {Array<Session>}
 */
export function loadSessions(opts = {}) {
  const { dbPath, limit = 0, search = "", includeEmpty = true } = opts;
  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT id, cwd, repository, host_type, branch, summary, created_at, updated_at
           FROM sessions
          ORDER BY updated_at DESC`
      )
      .all();

    let sessions = rows.map((r) => ({
      id: r.id,
      cwd: r.cwd || "",
      repository: r.repository || "",
      branch: r.branch || "",
      hostType: r.host_type || "",
      summary: (r.summary || "").replace(/\s+/g, " ").trim(),
      createdAt: r.created_at || "",
      updatedAt: r.updated_at || "",
      updatedMs: toTime(r.updated_at),
    }));

    if (!includeEmpty) {
      sessions = sessions.filter((s) => s.summary || s.cwd);
    }

    if (search) {
      sessions = filterSessions(sessions, search);
    }

    if (limit > 0) sessions = sessions.slice(0, limit);
    return sessions;
  } finally {
    db.close();
  }
}

/** Human-friendly relative age, e.g. "3m", "2h", "5d". */
export function relativeAge(ms, now = Date.now()) {
  if (!ms) return "?";
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d`;
  const wk = Math.round(day / 7);
  if (wk < 9) return `${wk}w`;
  const mo = Math.round(day / 30);
  if (mo < 24) return `${mo}mo`;
  return `${Math.round(day / 365)}y`;
}

/** Short label for the cwd/repo column. */
export function locationLabel(s) {
  if (s.repository) {
    const base = s.repository.split(/[\\/]/).filter(Boolean).pop();
    return s.branch ? `${base} @ ${s.branch}` : base || s.repository;
  }
  if (s.cwd) return s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd;
  return "—";
}

// ----------------------------------------------------------------- fuzzy match
// Lightweight fzf-style subsequence scorer. Returns a score (higher = better)
// or -Infinity when `query` is not a subsequence of `text`. Rewards contiguous
// runs, matches at word boundaries, and early matches.
export function fuzzyScore(query, text) {
  if (!query) return 0;
  query = query.toLowerCase();
  text = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let run = 0;
  let prev = -1;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      let bonus = 10;
      if (prev === ti - 1) {
        run += 1;
        bonus += run * 5; // contiguity bonus, grows with run length
      } else {
        run = 0;
      }
      const before = ti === 0 ? "" : text[ti - 1];
      if (ti === 0 || /[\s/\\@._-]/.test(before)) bonus += 15; // word boundary
      bonus += Math.max(0, 8 - ti); // earliness
      score += bonus;
      prev = ti;
      qi++;
    }
  }
  if (qi < query.length) return -Infinity; // not all chars matched
  score -= text.length * 0.05; // mild preference for shorter haystacks
  return score;
}

// Build the searchable haystack for a session.
function haystack(s) {
  return [s.summary, locationLabel(s), s.repository, s.branch, s.cwd, s.id]
    .filter(Boolean)
    .join(" \u0001 ");
}

/**
 * Fuzzy-filter sessions by a (possibly multi-term) query.
 * Empty query → original (recency) order. Otherwise every whitespace-separated
 * term must fuzzy-match; results are sorted by combined score, then recency.
 */
export function filterSessions(sessions, query) {
  const q = (query || "").trim();
  if (!q) return sessions;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const s of sessions) {
    const hay = haystack(s);
    let total = 0;
    let ok = true;
    for (const term of terms) {
      const sc = fuzzyScore(term, hay);
      if (sc === -Infinity) {
        ok = false;
        break;
      }
      total += sc;
    }
    if (ok) scored.push({ s, total });
  }
  scored.sort((a, b) => b.total - a.total || b.s.updatedMs - a.s.updatedMs);
  return scored.map((x) => x.s);
}


/**
 * Build the resume command for a session.
 * @param {string} id
 * @param {"agency"|"copilot"} launcher
 * @returns {{cmd: string, args: string[], display: string}}
 */
export function resumeCommand(id, launcher = "agency") {
  if (launcher === "copilot") {
    return {
      cmd: "copilot",
      args: [`--resume=${id}`],
      display: `copilot --resume=${id}`,
    };
  }
  return {
    cmd: "agency",
    args: ["copilot", `--resume=${id}`],
    display: `agency copilot --resume=${id}`,
  };
}
