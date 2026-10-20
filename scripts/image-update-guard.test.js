#!/usr/bin/env node
/**
 * Argv checks for the in-container update refusal.
 * Run: node scripts/image-update-guard.test.js
 */

const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const GUARD = path.join(ROOT, "scripts", "image-update-guard.sh");
const OPENCLAW_BIN = path.join(ROOT, "scripts", "openclaw-bin.sh");
const NPM_GUARD = path.join(ROOT, "scripts", "npm-guard.sh");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function bash(script) {
  return execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH },
  });
}

function predicate(fn, args) {
  const quoted = args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
  const script = `
set -euo pipefail
. ${JSON.stringify(GUARD)}
if ${fn} ${quoted}; then
  echo yes
else
  echo no
fi
`;
  return bash(script).trim();
}

function expectUpdate(args, want, label) {
  const got = predicate("image_update_openclaw_is_update", args);
  assert(got === (want ? "yes" : "no"), `${label} → ${got}`);
}

function expectNpm(args, want, label) {
  const got = predicate("image_update_npm_is_openclaw_global", args);
  assert(got === (want ? "yes" : "no"), `${label} → ${got}`);
}

execFileSync("bash", ["-n", GUARD]);
execFileSync("bash", ["-n", OPENCLAW_BIN]);
execFileSync("bash", ["-n", NPM_GUARD]);
assert(true, "guard scripts pass bash -n");

expectUpdate(["--version"], false, "openclaw --version");
expectUpdate(["-V"], false, "openclaw -V");
expectUpdate(["-v"], false, "openclaw -v");
expectUpdate(["gateway", "run"], false, "openclaw gateway run");
expectUpdate(["doctor", "--fix"], false, "openclaw doctor --fix");
expectUpdate(["devices", "list"], false, "openclaw devices list");
expectUpdate(["--profile", "prod", "devices", "list"], false, "profile then devices");
expectUpdate(["help", "update"], false, "help update");
expectUpdate(["gateway", "--update"], false, "gateway --update is not the root flag");
expectUpdate(["--", "--update"], false, "literal --update is not the update command");

expectUpdate(["update"], true, "openclaw update");
expectUpdate(["update", "status", "--json"], true, "openclaw update status");
expectUpdate(["update", "--channel", "beta"], true, "openclaw update --channel");
expectUpdate(["--update"], true, "openclaw --update");
expectUpdate(["--profile", "prod", "update"], true, "profile then update");
expectUpdate(["--profile=prod", "--update"], true, "profile= then --update");
expectUpdate(["--log-level", "debug", "update", "--dry-run"], true, "log-level then update");
expectUpdate(["--dev", "--no-color", "update"], true, "boolean root flags then update");
expectUpdate(["--container", "box", "--update"], true, "container then --update");
expectUpdate(["--", "update"], true, "literal update command");

expectNpm(["--version"], false, "npm --version");
expectNpm(["install", "cowsay"], false, "local install of another package");
expectNpm(["install", "openclaw"], false, "local install of openclaw");
expectNpm(["i", "-g", "cowsay"], false, "global install of another package");
expectNpm(["i", "-g", "openclaw-tools"], false, "package name prefix is not the CLI");
expectNpm(["i", "-g", "@openclaw/plugin"], false, "scoped package");
expectNpm(["view", "openclaw", "version"], false, "npm view");
expectNpm(["update", "-g"], false, "global update with no package name");
expectNpm(["uninstall", "-g", "openclaw"], false, "uninstall is not an upgrade");
expectNpm(["config", "set", "prefix", "/usr/local"], false, "npm config");

expectNpm(["i", "-g", "openclaw"], true, "npm i -g openclaw");
expectNpm(["install", "-g", "openclaw@latest"], true, "npm install -g openclaw@latest");
expectNpm(["install", "-g", "--force", "openclaw@2026.10.5"], true, "npm install -g --force");
expectNpm(["install", "--global", "openclaw@latest", "--no-fund", "--no-audit"], true, "installer-style flags");
expectNpm(["install", "openclaw@latest", "-g"], true, "package before -g");
expectNpm(["update", "-g", "openclaw"], true, "npm update -g openclaw");
expectNpm(["upgrade", "--location=global", "openclaw@beta"], true, "location=global");
expectNpm(["--prefix", "/usr/local", "install", "-g", "openclaw@latest"], true, "prefix before command");
expectNpm(["i", "-g", "--registry", "https://registry.npmjs.org", "openclaw"], true, "registry value skipped");
expectNpm(["i", "-g", "cowsay", "openclaw@latest"], true, "openclaw among other packages");

function runWrapper(script, args) {
  try {
    const stdout = execFileSync("bash", [script, ...args], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

for (const [script, args, label] of [
  [OPENCLAW_BIN, ["update"], "openclaw-bin.sh update"],
  [OPENCLAW_BIN, ["--profile", "prod", "--update"], "openclaw-bin.sh --update"],
  [NPM_GUARD, ["i", "-g", "openclaw@latest"], "npm-guard.sh i -g openclaw@latest"],
  [NPM_GUARD, ["install", "--global", "--force", "openclaw"], "npm-guard.sh install --global --force"],
]) {
  const result = runWrapper(script, args);
  assert(result.status === 1, `${label} exits 1 (status ${result.status})`);
  assert(result.stdout === "", `${label} writes nothing to stdout`);
  assert(
    result.stderr.includes("pulling a newer image tag"),
    `${label} names the image-tag update path`,
  );
  assert(result.stderr.includes("coollabsio/openclaw:<version>"), `${label} names the image tag`);
}

const versionAttempt = runWrapper(OPENCLAW_BIN, ["--version"]);
assert(
  !versionAttempt.stderr.includes("pulling a newer image tag"),
  "openclaw --version does not print the update refusal",
);
assert(
  !versionAttempt.stdout.includes("pulling a newer image tag"),
  "openclaw --version does not write the refusal to stdout",
);

if (failed > 0) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
