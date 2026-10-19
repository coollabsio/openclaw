#!/usr/bin/env node
// Snapshot openclaw.json before `doctor --fix`, then put back top-level keys
// the rewrite removed. Doctor runs on every start so env-driven migrations
// still apply. The gateway rejects unrecognized keys at process start and only
// skips reload once it is already up, so the entrypoint calls `restore` after
// the gateway is listening.
//
// Nested keys are left as doctor wrote them. That keeps env-driven settings
// and schema migrations. Only a top-level key that disappeared is restored.

const fs = require("fs");
const path = require("path");

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STATE_DIR = (process.env.OPENCLAW_STATE_DIR || "/data/.openclaw").replace(/\/+$/, "");
const CONFIG_FILE = process.env.OPENCLAW_CONFIG_PATH || path.join(STATE_DIR, "openclaw.json");
const STASH = process.env.OPENCLAW_HAND_EDIT_STASH || path.join(STATE_DIR, ".hand-edit-stash.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
  fs.chmodSync(file, 0o600);
}

const action = process.argv[2];
if (action === "snapshot") {
  writeJson(STASH, readJson(CONFIG_FILE));
  process.exit(0);
}

if (action === "restore") {
  if (!fs.existsSync(STASH)) process.exit(0);
  const before = readJson(STASH);
  const after = readJson(CONFIG_FILE);
  const restored = [];
  for (const key of Object.keys(before)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(after, key)) {
      after[key] = before[key];
      restored.push(key);
    }
  }
  if (restored.length > 0) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(after, null, 2) + "\n");
    fs.chmodSync(CONFIG_FILE, 0o600);
    console.log("[preserve-hand-edits] restored top-level keys: " + restored.join(", "));
  } else {
    console.log("[preserve-hand-edits] no top-level keys to restore");
  }
  fs.unlinkSync(STASH);
  process.exit(0);
}

console.error("usage: preserve-hand-edits.js snapshot|restore");
process.exit(2);
