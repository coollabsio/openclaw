#!/usr/bin/env node
// Park unrecognized top-level keys outside openclaw.json.
//
// `openclaw doctor --fix` rewrites openclaw.json through a strict schema and
// drops top-level keys it does not know. Putting those keys back into
// openclaw.json keeps the file invalid: the gateway only skips a reload once
// it is already up, and CLI commands (devices list, devices approve, sessions)
// exit 1 with "Unrecognized key".
//
// Snapshot before doctor, including keys already parked and an unrestored
// stash from a start that died in between. After doctor, keys that disappeared
// are written to openclaw.extra.json. openclaw.json is left as doctor wrote
// it, so the gateway and the CLI both load. Nested keys doctor changed stay
// changed. A volume that still has the unknown keys inside openclaw.json (the
// previous image wrote them back after listen) migrates on the next start:
// doctor removes them, and this script parks them.

const fs = require("fs");
const path = require("path");

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STATE_DIR = (process.env.OPENCLAW_STATE_DIR || "/data/.openclaw").replace(/\/+$/, "");
const CONFIG_FILE = process.env.OPENCLAW_CONFIG_PATH || path.join(STATE_DIR, "openclaw.json");
const STASH = process.env.OPENCLAW_HAND_EDIT_STASH || path.join(STATE_DIR, ".hand-edit-stash.json");
const EXTRA = process.env.OPENCLAW_EXTRA_CONFIG || path.join(STATE_DIR, "openclaw.extra.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readObject(file) {
  if (!fs.existsSync(file)) return null;
  const value = readJson(file);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(file + " must be a JSON object");
  }
  return value;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  fs.chmodSync(file, 0o600);
}

function copyOwn(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    target[key] = source[key];
  }
}

const action = process.argv[2];
if (action === "snapshot") {
  // Current openclaw.json wins over the parked file, which wins over an
  // unrestored stash. A hand edit still in openclaw.json is the value doctor
  // is about to strip. A crash between snapshot and restore leaves the stash
  // in place so the next snapshot does not forget those keys.
  const merged = Object.create(null);
  copyOwn(merged, readObject(STASH));
  copyOwn(merged, readObject(EXTRA));
  copyOwn(merged, readObject(CONFIG_FILE));
  writeJson(STASH, merged);
  process.exit(0);
}

if (action === "restore") {
  if (!fs.existsSync(STASH)) process.exit(0);
  const before = readObject(STASH);
  const after = readObject(CONFIG_FILE);
  const parked = Object.create(null);
  const restored = [];
  for (const key of Object.keys(before)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(after, key)) {
      parked[key] = before[key];
      restored.push(key);
    }
  }
  if (restored.length > 0) {
    writeJson(EXTRA, parked);
    console.log("[preserve-hand-edits] parked top-level keys in " + EXTRA + ": " + restored.join(", "));
  } else if (fs.existsSync(EXTRA)) {
    fs.unlinkSync(EXTRA);
    console.log("[preserve-hand-edits] no top-level keys to park; removed " + EXTRA);
  } else {
    console.log("[preserve-hand-edits] no top-level keys to park");
  }
  fs.unlinkSync(STASH);
  process.exit(0);
}

console.error("usage: preserve-hand-edits.js snapshot|restore");
process.exit(2);
