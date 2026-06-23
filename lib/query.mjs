// Query language parser for the Agency Session Manager.
//
// Supported syntax (whitespace-separated; double-quotes group a value):
//   bare term              fuzzy-match (ranked). Multiple terms AND together.
//   "exact phrase"         substring match (must contain), still ranked.
//   includes:foo           substring filter — session text must contain "foo".
//   excludes:foo           substring filter — session text must NOT contain "foo".
//   -foo  /  !foo          shorthand for excludes:foo.
//   +foo                   shorthand for includes:foo.
//   repo:bar branch:main   field-scoped substring filters.
//   cwd:proj  loc:thing  id:abc
//   before:<date> after:<date>   date bounds (also: until:=before, since:=after).
//
// Dates (case-insensitive), single-token or multi-word:
//   now            now-2h  now+30m  now-3d        (units: s,m,h,d,w)
//   today          today-3  today+1                (offset in days)
//   yesterday  tomorrow
//   2026-06-22     2026-06-22T15:00   2026-06-22 15:00
//   15:00                                           (today at that time)
//   june 22        jun 22 2026   june 22 15:00      (month name + day [+year] [+time])
//   "june 22 15:00"  (quote multi-word values when using the key:value form)

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

const DATE_KEYS = { before: "before", until: "before", after: "after", since: "after" };
const INC_KEYS = new Set(["includes", "include", "inc", "has"]);
const EXC_KEYS = new Set(["excludes", "exclude", "exc", "not", "without"]);
const FIELD_ALIASES = {
  repo: "repo", repository: "repo",
  branch: "branch",
  cwd: "cwd", dir: "cwd", path: "cwd",
  loc: "loc", location: "loc",
  id: "id",
};

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Parse a single date token (no spaces). Returns ms or null.
function parseDateToken(str, now) {
  str = str.trim().toLowerCase();
  if (!str) return null;
  let m;
  if (str === "now") return now;
  if ((m = str.match(/^now([+-]\d+)([smhdw])$/)))
    return now + Number(m[1]) * UNIT_MS[m[2]];
  if (str === "today") return startOfDay(now);
  if (str === "yesterday") return startOfDay(now) - UNIT_MS.d;
  if (str === "tomorrow") return startOfDay(now) + UNIT_MS.d;
  if ((m = str.match(/^today([+-]\d+)$/)))
    return startOfDay(now) + Number(m[1]) * UNIT_MS.d;
  // ISO date / datetime
  if (/^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2})?)?$/.test(str)) {
    const t = Date.parse(str.replace(" ", "T"));
    return Number.isNaN(t) ? null : t;
  }
  // bare time -> today at that time
  if ((m = str.match(/^(\d{1,2}):(\d{2})$/))) {
    const d = new Date(startOfDay(now));
    d.setHours(Number(m[1]), Number(m[2]));
    return d.getTime();
  }
  return null;
}

// Parse a date phrase from `parts` starting at index `i`.
// Returns { ms, consumed } or null. Handles "june 22 [2026] [15:00]".
function parseDatePhrase(parts, i, now) {
  const first = (parts[i] || "").toLowerCase();
  if (first in MONTHS) {
    const month = MONTHS[first];
    let consumed = 1;
    const dayTok = parts[i + consumed];
    if (!dayTok || !/^\d{1,2}$/.test(dayTok)) return null;
    const day = Number(dayTok);
    consumed++;
    let year = new Date(now).getFullYear();
    if (parts[i + consumed] && /^\d{4}$/.test(parts[i + consumed])) {
      year = Number(parts[i + consumed]);
      consumed++;
    }
    let hh = 0, mm = 0;
    const timeTok = parts[i + consumed];
    if (timeTok && /^(\d{1,2}):(\d{2})$/.test(timeTok)) {
      const [h, m2] = timeTok.split(":");
      hh = Number(h);
      mm = Number(m2);
      consumed++;
    }
    return { ms: new Date(year, month, day, hh, mm, 0, 0).getTime(), consumed };
  }
  const single = parseDateToken(parts[i], now);
  return single == null ? null : { ms: single, consumed: 1 };
}

// Parse a date value that may itself contain spaces (from key:"..." or quoted).
function parseDateValue(str, now) {
  const parts = str.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parseDateToken(parts[0], now);
  const r = parseDatePhrase(parts, 0, now);
  return r ? r.ms : null;
}

// Tokenize, honoring double-quoted groups. Returns [{ text, quoted }].
function tokenize(input) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    if (m[1] !== undefined) tokens.push({ text: m[1], quoted: true });
    else tokens.push({ text: m[2], quoted: false });
  }
  return tokens;
}

/**
 * Parse a raw query string into a structured query.
 * @returns {{positives: {term:string, substr:boolean}[], includes:string[],
 *   negatives:string[], fields:Record<string,string[]>, before:number|null,
 *   after:number|null, errors:string[]}}
 */
export function parseQuery(input, now = Date.now()) {
  const q = {
    positives: [],
    includes: [],
    negatives: [],
    fields: {},
    before: null,
    after: null,
    errors: [],
  };
  if (!input || !input.trim()) return q;
  const tokens = tokenize(input);

  const addField = (f, v) => {
    if (!v) return;
    (q.fields[f] ||= []).push(v.toLowerCase());
  };

  for (let i = 0; i < tokens.length; i++) {
    const { text, quoted } = tokens[i];
    if (!text) continue;

    // key:value form (only when not quoted and a colon is present mid-token)
    let key = null;
    let val = null;
    if (!quoted) {
      const c = text.indexOf(":");
      if (c > 0) {
        key = text.slice(0, c).toLowerCase();
        val = text.slice(c + 1);
      }
    }
    const bare = text.toLowerCase();

    // ---- date keys (before/after/since/until)
    const dateKey =
      (key && DATE_KEYS[key]) || (key == null && DATE_KEYS[bare]) || null;
    if (dateKey) {
      if (val) {
        const ms = parseDateValue(val, now);
        if (ms == null) q.errors.push(`unrecognized date: "${val}"`);
        else q[dateKey] = ms;
      } else {
        // consume following tokens as a date phrase
        const parts = tokens.slice(i + 1).map((t) => t.text);
        const r = parseDatePhrase(parts, 0, now);
        if (!r) {
          q.errors.push(`unrecognized date after "${bare}"`);
        } else {
          q[dateKey] = r.ms;
          i += r.consumed;
        }
      }
      continue;
    }

    // ---- include / exclude keys
    if (key && (INC_KEYS.has(key) || EXC_KEYS.has(key))) {
      const v = (val || "").toLowerCase();
      if (v) (INC_KEYS.has(key) ? q.includes : q.negatives).push(v);
      continue;
    }
    if (key == null && (INC_KEYS.has(bare) || EXC_KEYS.has(bare))) {
      // bare keyword consumes the next token as its value
      const next = tokens[i + 1];
      if (next) {
        (INC_KEYS.has(bare) ? q.includes : q.negatives).push(
          next.text.toLowerCase()
        );
        i += 1;
      }
      continue;
    }

    // ---- field-scoped filters
    if (key && FIELD_ALIASES[key]) {
      addField(FIELD_ALIASES[key], val);
      continue;
    }

    // ---- prefix shorthands  -term / !term / +term
    if (!quoted && (text[0] === "-" || text[0] === "!") && text.length > 1) {
      q.negatives.push(text.slice(1).toLowerCase());
      continue;
    }
    if (!quoted && text[0] === "+" && text.length > 1) {
      q.includes.push(text.slice(1).toLowerCase());
      continue;
    }

    // ---- plain term: quoted => substring; bare => fuzzy
    q.positives.push({ term: text, substr: quoted });
  }

  return q;
}

/** True when a parsed query carries no constraints at all. */
export function isEmptyQuery(q) {
  return (
    q.positives.length === 0 &&
    q.includes.length === 0 &&
    q.negatives.length === 0 &&
    Object.keys(q.fields).length === 0 &&
    q.before == null &&
    q.after == null
  );
}
