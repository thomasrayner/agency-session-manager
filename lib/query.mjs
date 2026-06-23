// Query language parser for the Agency Session Manager.
//
// Supported syntax (whitespace-separated; double-quotes group a value):
//   bare term              fuzzy-match (ranked). Multiple terms AND together.
//   "exact phrase"         substring match (must contain), still ranked.
//   includes:foo           substring filter — session text must contain "foo".
//   includes:"two words"   quote the value to include a phrase with spaces.
//   excludes:foo           substring filter — session text must NOT contain "foo".
//   excludes:"two words"   quote the value to exclude a phrase with spaces.
//   -foo  /  !foo          shorthand for excludes:foo  (-"two words" also works).
//   +foo                   shorthand for includes:foo  (+"two words" also works).
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
const INC_KEYS = new Set(["includes", "include", "incl", "inc", "has", "with"]);
const EXC_KEYS = new Set(["excludes", "exclude", "excl", "exc", "not", "without", "no"]);
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
  if (str == null) return null;
  str = String(str).trim().toLowerCase();
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
  if (!parts || parts[i] == null) return null;
  const first = String(parts[i]).toLowerCase();
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
  if (str == null) return null;
  const parts = String(str).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parseDateToken(parts[0], now);
  const r = parseDatePhrase(parts, 0, now);
  return r ? r.ms : null;
}

// Strip grouping double-quotes from a value fragment.
function stripQuotes(s) {
  return s.replace(/"/g, "");
}

// Split a value on top-level commas — those outside double-quotes and outside
// `{ }` braces. Lets `"a,b","c"` -> ['"a,b"','"c"'] and `Test{1,2}` stay intact.
function splitTopLevelCommas(str) {
  const out = [];
  let cur = "";
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') { inQuote = !inQuote; cur += ch; continue; }
    if (inQuote) { cur += ch; continue; }
    if (ch === "{") { depth++; cur += ch; continue; }
    if (ch === "}") { if (depth > 0) depth--; cur += ch; continue; }
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// Bash-style brace expansion: `Test{1,2,3}` -> [Test1,Test2,Test3], with
// prefix/suffix and nesting (`a{b,c{d,e}}`). Braces inside quotes are literal.
// A brace group needs >=2 comma-separated parts to expand; otherwise it's kept.
function expandBraces(str, guard = 0) {
  if (guard > 1000) return [str];
  let inQuote = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (inQuote) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        const inner = str.slice(start + 1, i);
        const parts = splitTopLevelCommas(inner);
        if (parts.length < 2) { start = -1; continue; } // not an expansion
        const pre = str.slice(0, start);
        const post = str.slice(i + 1);
        const results = [];
        for (const tail of expandBraces(post, guard + 1)) {
          for (const part of parts) {
            for (const ph of expandBraces(part, guard + 1)) {
              results.push(pre + ph + tail);
            }
          }
        }
        return results;
      }
    }
  }
  return [str];
}

// Expand a raw key value into a list of concrete values, applying top-level
// comma splitting and brace expansion, then stripping grouping quotes.
// `"You are","Clawpilot"` -> ["You are","Clawpilot"]; `Test{1,2}` -> [Test1,Test2].
export function expandValueList(rawVal) {
  if (rawVal == null) return [];
  const out = [];
  for (const seg of splitTopLevelCommas(rawVal)) {
    for (const ex of expandBraces(seg)) {
      const v = stripQuotes(ex).trim();
      if (v) out.push(v);
    }
  }
  return out;
}

// Tokenize, honoring double-quoted groups. A quote may wrap a whole token
// ("exact phrase") or just the value of a key (incl:"some phrase"), and a token
// continues across quoted spaces until the next *unquoted* whitespace.
// Returns [{ text, quoted, key, val, raw, rawVal }] where:
//   text   = full token content with quotes removed
//   quoted = token began with a quote (a bare "exact phrase")
//   key    = lowercased key when a colon appears in the unquoted prefix, else null
//   val    = substring after that colon (quotes removed, spaces preserved)
//   raw    = original input slice for the token (quotes preserved)
//   rawVal = original input slice after the key colon (quotes preserved) or null
function tokenize(input) {
  const tokens = [];
  const n = input.length;
  let i = 0;
  const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (i < n) {
    while (i < n && isSpace(input[i])) i++;
    if (i >= n) break;
    const tokStart = i;
    const startedWithQuote = input[i] === '"';
    let text = "";
    let colonAt = -1; // index within `text` of the key-separating colon
    let colonInputAt = -1; // index within `input` of that colon
    let inPrefix = true; // still scanning the leading unquoted run (for key detection)
    while (i < n && !isSpace(input[i])) {
      const ch = input[i];
      if (ch === '"') {
        inPrefix = false; // a quote terminates key-prefix scanning
        i++;
        while (i < n && input[i] !== '"') {
          text += input[i];
          i++;
        }
        if (i < n) i++; // skip closing quote
        continue;
      }
      if (ch === ":" && inPrefix && colonAt === -1) {
        colonAt = text.length;
        colonInputAt = i;
      }
      text += ch;
      i++;
    }
    const raw = input.slice(tokStart, i);
    let key = null;
    let val = null;
    let rawVal = null;
    if (colonAt > 0 && !startedWithQuote) {
      key = text.slice(0, colonAt).toLowerCase();
      val = text.slice(colonAt + 1);
      rawVal = input.slice(colonInputAt + 1, i);
    }
    tokens.push({ text, quoted: startedWithQuote, key, val, raw, rawVal });
  }
  return tokens;
}

/**
 * Parse a raw query string into a structured query.
 * @returns {{positives: {term:string, substr:boolean}[], includes:string[][],
 *   negatives:string[], fields:Record<string,string[]>, before:number|null,
 *   after:number|null, errors:string[]}}
 *   `includes` is a list of OR-groups: a session must contain at least one value
 *   from every group (AND across groups, OR within a group).
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
  const lc = (s) => s.toLowerCase();

  const addField = (f, v) => {
    if (!v) return;
    (q.fields[f] ||= []).push(v.toLowerCase());
  };

  for (let i = 0; i < tokens.length; i++) {
    const { text, quoted, key, val, raw, rawVal } = tokens[i];
    if (!text) continue;
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

    // ---- include / exclude keys (values may be comma lists / brace expansions)
    if (key && (INC_KEYS.has(key) || EXC_KEYS.has(key))) {
      const vals = expandValueList(rawVal).map(lc);
      if (vals.length) {
        if (INC_KEYS.has(key)) q.includes.push(vals); // OR-group
        else q.negatives.push(...vals); // each excluded independently
      }
      continue;
    }
    if (key == null && (INC_KEYS.has(bare) || EXC_KEYS.has(bare))) {
      // bare keyword consumes the next token as its (expandable) value
      const next = tokens[i + 1];
      if (next) {
        const vals = expandValueList(next.raw).map(lc);
        if (vals.length) {
          if (INC_KEYS.has(bare)) q.includes.push(vals);
          else q.negatives.push(...vals);
        }
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
      q.negatives.push(...expandValueList(raw.slice(1)).map(lc));
      continue;
    }
    if (!quoted && text[0] === "+" && text.length > 1) {
      const vals = expandValueList(raw.slice(1)).map(lc);
      if (vals.length) q.includes.push(vals);
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
