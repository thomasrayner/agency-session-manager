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
// fzf-style fuzzy scorer using O(m*n) dynamic programming to find the OPTIMAL
// match (not a greedy first-match). Returns a score (higher = better) or
// -Infinity when `query` is not a subsequence of `text`. Rewards contiguous
// runs, matches at word boundaries, and early matches. Long fields are capped
// so a verbose summary can't dominate ranking purely by length.
const FUZZY_FIELD_CAP = 200;

function matchBonus(text, j) {
  let bonus = 10;
  const before = j === 0 ? "" : text[j - 1];
  if (j === 0 || /[\s/\\@._-]/.test(before)) bonus += 15; // word boundary
  bonus += Math.max(0, 8 - j); // earliness
  return bonus;
}

export function fuzzyScore(query, text) {
  if (!query) return 0;
  query = query.toLowerCase();
  text = text.toLowerCase();
  if (text.length > FUZZY_FIELD_CAP) text = text.slice(0, FUZZY_FIELD_CAP);
  const m = query.length;
  const n = text.length;
  if (m > n) return -Infinity;

  const NEG = -Infinity;
  let prev = new Array(n).fill(NEG); // best score matching q[0..i-1] ending at j
  for (let i = 0; i < m; i++) {
    const cur = new Array(n).fill(NEG);
    let runningBestPrev = NEG; // best prev[0..j-1]
    for (let j = 0; j < n; j++) {
      if (text[j] === query[i]) {
        const base = matchBonus(text, j);
        // Non-contiguous placement (or the first query char).
        let best =
          i === 0 ? base : runningBestPrev === NEG ? NEG : runningBestPrev + base;
        // Contiguous extension of the previous char.
        if (i > 0 && j > 0 && prev[j - 1] !== NEG) {
          const contig = prev[j - 1] + base + 15; // strong contiguity reward
          if (contig > best) best = contig;
        }
        cur[j] = best;
      }
      if (i > 0 && prev[j] > runningBestPrev) runningBestPrev = prev[j];
    }
    prev = cur;
  }

  let best = NEG;
  for (let j = 0; j < n; j++) if (prev[j] > best) best = prev[j];
  if (best === NEG) return -Infinity;
  return best - text.length * 0.05; // mild preference for shorter fields
}

// Weighted fields searched for each session. A term must match within a single
// field (not scattered across fields), which avoids spurious cross-field matches
// like "tui" pairing a "t" from the summary with a "u" from the cwd path.
function searchFields(s) {
  return [
    [s.summary, 1.0],
    [locationLabel(s), 0.9],
    [s.repository, 0.8],
    [s.branch, 0.8],
    [s.cwd, 0.5],
    [s.id, 0.3],
  ].filter(([v]) => v);
}

/**
 * Fuzzy-filter sessions by a (possibly multi-term) query.
 * Empty query → original (recency) order. Otherwise every whitespace-separated
 * term must fuzzy-match at least one field; results are sorted by combined score,
 * then recency.
 */
export function filterSessions(sessions, query) {
  const q = (query || "").trim();
  if (!q) return sessions;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const s of sessions) {
    const fields = searchFields(s);
    let total = 0;
    let ok = true;
    for (const term of terms) {
      let best = -Infinity;
      for (const [value, weight] of fields) {
        const sc = fuzzyScore(term, value);
        if (sc !== -Infinity) best = Math.max(best, sc * weight);
      }
      if (best === -Infinity) {
        ok = false;
        break;
      }
      total += best;
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
