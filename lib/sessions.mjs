// Shared session-store access for the Agency Session Manager plugin.
// Zero-dependency: uses Node's built-in node:sqlite (Node >= 22.5, stable-ish in 24).
//
// Both `agency copilot` and plain `copilot` persist to the SAME store:
//   ~/.copilot/session-store.db  (table `sessions`)
// so a single reader covers every CLI session kind.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { parseQuery, isEmptyQuery } from "./query.mjs";

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
//
// Performance: inputs to the core scorer are pre-lowercased and capped; a cheap
// subsequence pre-check rejects non-matches before the DP runs; the DP reuses
// module-level scratch buffers and compares char codes (no per-char strings).
const FUZZY_FIELD_CAP = 200;
const _bufA = new Float64Array(FUZZY_FIELD_CAP);
const _bufB = new Float64Array(FUZZY_FIELD_CAP);

// Word-boundary chars: space / \ @ . _ -
function isBoundaryCode(c) {
  return (
    c === 32 || c === 47 || c === 92 || c === 64 || c === 46 || c === 95 || c === 45
  );
}

// Core scorer: assumes `query` and `text` are already lowercased and `text` is
// within FUZZY_FIELD_CAP. Not reentrant (uses shared scratch buffers).
function fuzzyCore(query, text) {
  const m = query.length;
  const n = text.length;
  if (m === 0) return 0;
  if (m > n) return -Infinity;

  // Substring fast path: the common case (users type real substrings). A full
  // contiguous match is the optimal alignment, so score it directly and skip the
  // DP. Scan every occurrence and keep the best (earliest / word-boundary wins).
  let p = text.indexOf(query);
  if (p !== -1) {
    let best = -Infinity;
    while (p !== -1) {
      const sc = contiguousScore(text, query, p);
      if (sc > best) best = sc;
      p = text.indexOf(query, p + 1);
    }
    return best - n * 0.05;
  }

  // Fast subsequence reject — avoids the DP for the common non-matching case.
  let qi = 0;
  for (let i = 0; i < n && qi < m; i++) {
    if (text.charCodeAt(i) === query.charCodeAt(qi)) qi++;
  }
  if (qi < m) return -Infinity;

  const NEG = -Infinity;
  let prev = _bufA;
  let cur = _bufB;
  for (let j = 0; j < n; j++) prev[j] = NEG;

  for (let i = 0; i < m; i++) {
    const qc = query.charCodeAt(i);
    let runningBestPrev = NEG; // best prev[0..j-1]
    for (let j = 0; j < n; j++) {
      let val = NEG;
      if (text.charCodeAt(j) === qc) {
        let bonus = 10;
        if (j === 0 || isBoundaryCode(text.charCodeAt(j - 1))) bonus += 15;
        if (j < 8) bonus += 8 - j; // earliness
        let best =
          i === 0 ? bonus : runningBestPrev === NEG ? NEG : runningBestPrev + bonus;
        if (i > 0 && j > 0 && prev[j - 1] !== NEG) {
          const contig = prev[j - 1] + bonus + 15; // strong contiguity reward
          if (contig > best) best = contig;
        }
        val = best;
      }
      cur[j] = val;
      if (i > 0 && prev[j] > runningBestPrev) runningBestPrev = prev[j];
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }

  let best = NEG;
  for (let j = 0; j < n; j++) if (prev[j] > best) best = prev[j];
  if (best === NEG) return -Infinity;
  return best - n * 0.05; // mild preference for shorter fields
}

// Score a fully-contiguous match of `query` in `text` at position `p`. Mirrors
// the DP's bonus model for a contiguous run (which is its optimal alignment).
function contiguousScore(text, query, p) {
  const m = query.length;
  let score = 0;
  for (let k = 0; k < m; k++) {
    const j = p + k;
    let bonus = 10;
    if (k === 0) {
      if (j === 0 || isBoundaryCode(text.charCodeAt(j - 1))) bonus += 15;
    } else {
      bonus += 15; // contiguity link
    }
    if (j < 8) bonus += 8 - j; // earliness
    score += bonus;
  }
  return score;
}

// Public scorer (lowercases + caps). Kept for tests and ad-hoc use.
export function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  let t = text.toLowerCase();
  if (t.length > FUZZY_FIELD_CAP) t = t.slice(0, FUZZY_FIELD_CAP);
  return fuzzyCore(q, t);
}

// Per-session search data, computed once and cached (keyed by the session object
// so it survives across keystrokes and never leaks into JSON output).
const _prepCache = new WeakMap();
function getPrep(s) {
  let prep = _prepCache.get(s);
  if (prep) return prep;
  const loc = locationLabel(s);
  const raw = [
    [s.summary, 1.0],
    [loc, 0.9],
    [s.repository, 0.8],
    [s.branch, 0.8],
    [s.cwd, 0.5],
    [s.id, 0.3],
  ];
  const fields = []; // [[lowerCapped, weight], ...] for fuzzy scoring
  const allParts = []; // full lowercased values for substring filters
  for (const [v, w] of raw) {
    if (!v) continue;
    const lv = v.toLowerCase();
    allParts.push(lv);
    fields.push([lv.length > FUZZY_FIELD_CAP ? lv.slice(0, FUZZY_FIELD_CAP) : lv, w]);
  }
  prep = {
    fields,
    allText: allParts.join(" \u0001 "),
    fieldMap: {
      repo: `${s.repository || ""} ${loc}`.toLowerCase(),
      branch: (s.branch || "").toLowerCase(),
      cwd: (s.cwd || "").toLowerCase(),
      loc: loc.toLowerCase(),
      id: (s.id || "").toLowerCase(),
    },
  };
  _prepCache.set(s, prep);
  return prep;
}

// Best weighted fuzzy score for an already-lowercased term across a session's
// fields (-Infinity if it matches none).
function bestFieldFuzzyPrep(prep, lowerTerm) {
  let best = -Infinity;
  for (const [value, weight] of prep.fields) {
    const sc = fuzzyCore(lowerTerm, value);
    if (sc !== -Infinity) {
      const w = sc * weight;
      if (w > best) best = w;
    }
  }
  return best;
}

/**
 * Filter + rank sessions by a query. `query` may be a raw string (parsed with the
 * query language) or an already-parsed query object. Empty query → recency order.
 *
 * Hard filters: before/after date bounds, includes/excludes substrings,
 * field-scoped substrings, and that every fuzzy term matches some field.
 * Ranking: combined fuzzy score of positive/included terms, then recency.
 */
export function filterSessions(sessions, query) {
  const q = typeof query === "string" ? parseQuery(query) : query;
  if (!q || isEmptyQuery(q)) return sessions;

  const fieldEntries = Object.entries(q.fields);
  const posFuzzy = q.positives.filter((p) => !p.substr).map((p) => p.term.toLowerCase());
  const posSub = q.positives.filter((p) => p.substr).map((p) => p.term.toLowerCase());
  const includes = q.includes; // already lowercased by the parser
  const negatives = q.negatives;
  const hasRanking = posFuzzy.length > 0 || posSub.length > 0 || includes.length > 0;
  const out = [];

  for (const s of sessions) {
    if (q.before != null && !(s.updatedMs && s.updatedMs <= q.before)) continue;
    if (q.after != null && !(s.updatedMs && s.updatedMs >= q.after)) continue;

    const prep = getPrep(s);
    const text = prep.allText;
    let skip = false;

    for (const neg of negatives) {
      if (text.includes(neg)) {
        skip = true;
        break;
      }
    }
    if (skip) continue;

    for (const inc of includes) {
      if (!text.includes(inc)) {
        skip = true;
        break;
      }
    }
    if (skip) continue;

    for (const [field, terms] of fieldEntries) {
      const fv = prep.fieldMap[field] || "";
      for (const t of terms) {
        if (!fv.includes(t)) {
          skip = true;
          break;
        }
      }
      if (skip) break;
    }
    if (skip) continue;

    for (const ps of posSub) {
      if (!text.includes(ps)) {
        skip = true;
        break;
      }
    }
    if (skip) continue;

    // Bare fuzzy positives: each must match some field.
    let total = 0;
    for (const ft of posFuzzy) {
      const sc = bestFieldFuzzyPrep(prep, ft);
      if (sc === -Infinity) {
        skip = true;
        break;
      }
      total += sc;
    }
    if (skip) continue;

    // Quoted-substring positives + included terms also contribute to ranking.
    for (const ps of posSub) {
      const sc = bestFieldFuzzyPrep(prep, ps);
      if (sc > -Infinity) total += sc;
    }
    for (const inc of includes) {
      const sc = bestFieldFuzzyPrep(prep, inc);
      if (sc > -Infinity) total += sc;
    }

    out.push({ s, total });
  }

  if (hasRanking) {
    out.sort((a, b) => b.total - a.total || b.s.updatedMs - a.s.updatedMs);
  }
  return out.map((x) => x.s);
}

/**
 * Apply a raw stdin chunk to the TUI search string. A single keypress event can
 * deliver MANY characters (fast typing, paste, or buffered input while a slow
 * filter runs), so the whole chunk is processed: printable chars are appended,
 * embedded backspaces delete, and control/escape input is ignored.
 * @param {string} search current search text
 * @param {string} chunk raw data chunk from stdin
 * @returns {{search: string, changed: boolean}}
 */
export function appendKeyChunk(search, chunk, cursor = search.length) {
  if (chunk.startsWith("\x1b")) return { search, cursor, changed: false };
  if (cursor == null || cursor > search.length) cursor = search.length;
  if (cursor < 0) cursor = 0;
  let changed = false;
  for (const ch of chunk) {
    if (ch === "\x7f" || ch === "\b") {
      if (cursor > 0) {
        search = search.slice(0, cursor - 1) + search.slice(cursor);
        cursor -= 1;
        changed = true;
      }
    } else if (ch >= " ") {
      search = search.slice(0, cursor) + ch + search.slice(cursor);
      cursor += 1;
      changed = true;
    }
  }
  return { search, cursor, changed };
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
