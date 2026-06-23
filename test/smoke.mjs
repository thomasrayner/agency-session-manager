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
} from "../lib/sessions.mjs";

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
assert.ok(/Agency Session Manager/.test(preview), "preview has title");
assert.ok(/Enter resume/.test(preview), "preview has footer help");
assert.ok(/sessions/.test(preview), "preview has session count");
ok("TUI --preview renders a full frame");

console.log(`\nAll ${passed} smoke checks passed.`);
