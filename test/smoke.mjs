#!/usr/bin/env node
// Smoke tests for the Agency Session Manager.
// Run: node test/smoke.mjs
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  relativeAge,
  locationLabel,
  resumeCommand,
  fuzzyScore,
  filterSessions,
} from "../lib/sessions.mjs";
import { parseQuery } from "../lib/query.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "bin", "session-manager.mjs");
let passed = 0;
function ok(name) {
  passed++;
  console.log("  \u2713", name);
}

// --- relativeAge
const now = Date.UTC(2026, 0, 1, 12, 0, 0);
assert.equal(relativeAge(now - 30_000, now), "30s");
assert.equal(relativeAge(now - 5 * 60_000, now), "5m");
assert.equal(relativeAge(now - 3 * 3600_000, now), "3h");
assert.equal(relativeAge(now - 5 * 86400_000, now), "5d");
assert.equal(relativeAge(0, now), "?");
ok("relativeAge buckets");

// --- locationLabel
assert.equal(
  locationLabel({ repository: "C:/r/swarm-x", branch: "main" }),
  "swarm-x @ main"
);
assert.equal(locationLabel({ cwd: "C:/a/b/proj" }), "proj");
assert.equal(locationLabel({}), "\u2014");
ok("locationLabel formatting");

// --- resumeCommand
assert.deepEqual(resumeCommand("abc", "agency"), {
  cmd: "agency",
  args: ["copilot", "--resume=abc"],
  display: "agency copilot --resume=abc",
});
assert.deepEqual(resumeCommand("abc", "copilot"), {
  cmd: "copilot",
  args: ["--resume=abc"],
  display: "copilot --resume=abc",
});
ok("resumeCommand builds agency + copilot variants");

// --- CLI: --resume-cmd
const out1 = execFileSync("node", [bin, "--resume-cmd", "xyz"], {
  encoding: "utf8",
}).trim();
assert.equal(out1, "agency copilot --resume=xyz");
const out2 = execFileSync("node", [bin, "--resume-cmd", "xyz", "--copilot"], {
  encoding: "utf8",
}).trim();
assert.equal(out2, "copilot --resume=xyz");
ok("CLI --resume-cmd (agency default + --copilot)");

// --- CLI: --list --json returns valid JSON array
const jsonOut = execFileSync("node", [bin, "--list", "--json", "--limit", "2"], {
  encoding: "utf8",
});
const parsed = JSON.parse(jsonOut);
assert.ok(Array.isArray(parsed), "json output is an array");
assert.ok(parsed.length <= 2, "limit respected");
if (parsed.length) {
  for (const k of ["id", "summary", "updatedMs"])
    assert.ok(k in parsed[0], `session has ${k}`);
}
ok("CLI --list --json is valid + shaped");

// --- no experimental SQLite warning leaks to stdout
const res = execFileSync("node", [bin, "--list", "--json", "--limit", "1"], {
  encoding: "utf8",
});
assert.ok(!/experimental/i.test(res), "no warning text in stdout");
ok("no experimental warning in stdout");

// --- TUI preview renders a frame with header + footer
const preview = execFileSync("node", [bin, "--preview", "10", "90"], {
  encoding: "utf8",
});
assert.ok(/Sessions/.test(preview), "preview has title");
assert.ok(/Enter resume/.test(preview), "preview has footer help");
assert.ok(/sessions/.test(preview), "preview has session count");
ok("TUI --preview renders a full frame");

// --- fuzzyScore: subsequence matching + ranking
assert.equal(fuzzyScore("", "anything"), 0, "empty query scores 0");
assert.equal(fuzzyScore("xyz", "abc"), -Infinity, "non-subsequence is -Infinity");
assert.ok(fuzzyScore("swrm", "swarm") > -Infinity, "swrm matches swarm");
// Contiguous + earlier match should outrank scattered/later match.
assert.ok(
  fuzzyScore("tui", "tui plugin") > fuzzyScore("tui", "the user interface"),
  "contiguous/early beats scattered"
);
ok("fuzzyScore subsequence + ranking");

// --- filterSessions: multi-term AND, ranking, empty passthrough
const sample = [
  { summary: "Create TUI Session Manager Plugin", cwd: "", repository: "", branch: "", id: "a" },
  { summary: "swarm agentic review", cwd: "C:/r/swarm", repository: "swarm", branch: "main", id: "b" },
  { summary: "unrelated note", cwd: "", repository: "", branch: "", id: "c" },
];
const empty = filterSessions(sample, "");
assert.equal(empty.length, 3, "empty query returns all");
const tuiHits = filterSessions(sample, "tui plugin");
assert.equal(tuiHits[0].id, "a", "best multi-term match ranks first");
assert.ok(
  !tuiHits.some((s) => s.id === "c"),
  "non-matching session excluded"
);
const swarmHits = filterSessions(sample, "swrm");
assert.equal(swarmHits[0].id, "b", "fuzzy term matches across fields");
ok("filterSessions multi-term AND + ranking");

// --- query language: parsing
const NOW = Date.parse("2026-06-23T12:00:00-07:00");
const pq = parseQuery(
  "includes:csat excludes:automated before:today-3 after june 22 15:00",
  NOW
);
assert.deepEqual(pq.includes, ["csat"], "includes: parsed");
assert.deepEqual(pq.negatives, ["automated"], "excludes: parsed");
assert.equal(
  new Date(pq.before).getDate(),
  20,
  "before:today-3 → 3 days before the 23rd"
);
assert.equal(new Date(pq.after).getHours(), 15, "after june 22 15:00 → 15:00");
assert.equal(new Date(pq.after).getMonth(), 5, "month june → 5");
const pq2 = parseQuery("repo:swarm -automated +csat \"exact phrase\" review", NOW);
assert.deepEqual(pq2.fields.repo, ["swarm"], "repo: field filter");
assert.deepEqual(pq2.negatives, ["automated"], "-term shorthand");
assert.deepEqual(pq2.includes, ["csat"], "+term shorthand");
assert.ok(
  pq2.positives.some((p) => p.term === "exact phrase" && p.substr),
  "quoted phrase is a substring positive"
);
ok("parseQuery operators + dates");

// --- query language: filtering against sample sessions
const qSample = [
  { summary: "csat survey results", cwd: "", repository: "metrics", branch: "main", id: "x", updatedMs: NOW - 1000 },
  { summary: "csat automated export", cwd: "", repository: "metrics", branch: "main", id: "y", updatedMs: NOW - 2000 },
  { summary: "unrelated", cwd: "", repository: "other", branch: "dev", id: "z", updatedMs: NOW - 3000 },
];
const inc = filterSessions(qSample, "includes:csat");
assert.equal(inc.length, 2, "includes:csat keeps only csat sessions");
const exc = filterSessions(qSample, "includes:csat excludes:automated");
assert.deepEqual(exc.map((s) => s.id), ["x"], "excludes:automated drops the automated one");
const fld = filterSessions(qSample, "repo:metrics branch:dev");
assert.equal(fld.length, 0, "field filters AND together");
const dated = filterSessions(qSample, "after:2026-06-23T11:00:00");
assert.ok(dated.length >= 1 && dated.every((s) => s.updatedMs >= Date.parse("2026-06-23T11:00:00")), "after: date bound");
ok("filterSessions honors query operators");

console.log(`\nAll ${passed} smoke checks passed.`);
