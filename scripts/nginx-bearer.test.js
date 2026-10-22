#!/usr/bin/env node
/**
 * Renders the nginx config the entrypoint would write, without starting nginx
 * or the gateway. Checks the bearer bypass is anchored to gateway-checked
 * routes, and that AUTH_PASSWORD unset stays byte-identical to main.
 *
 * Run: node scripts/nginx-bearer.test.js
 */

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENTRYPOINT = path.join(ROOT, "scripts", "entrypoint.sh");

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

function render(entrypoint, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-nginx-"));
  const conf = path.join(dir, "openclaw.conf");
  const script = fs.readFileSync(entrypoint, "utf8");
  const start = script.indexOf("# ── Generate nginx config");
  const end = script.indexOf("# ── Start nginx");
  if (start < 0 || end < 0) {
    throw new Error(`nginx section markers missing in ${entrypoint}`);
  }
  const body = script
    .slice(start, end)
    .replace(
      'NGINX_CONF="/etc/nginx/conf.d/openclaw.conf"',
      `NGINX_CONF=${JSON.stringify(conf)}`,
    )
    .replaceAll("/etc/nginx/.htpasswd", path.join(dir, "htpasswd"))
    .replaceAll("/usr/share/nginx/html", path.join(dir, "nginx-html"));
  const harness = `
set -euo pipefail
GATEWAY_TOKEN="\${OPENCLAW_GATEWAY_TOKEN}"
GATEWAY_PORT="\${OPENCLAW_GATEWAY_PORT:-18789}"
HOOKS_PATH="\${HOOKS_PATH:-}"
mkdir -p ${JSON.stringify(dir)}/html
# startup page writes under /usr/share; redirect that mkdir by shadowing nothing —
# the section uses absolute /usr/share/nginx/html, so stub it if unwritable.
if [ ! -w /usr/share/nginx/html ] 2>/dev/null; then
  mkdir -p ${JSON.stringify(dir)}/nginx-html
  # The heredoc target is fixed. Provide a writable stand-in via a function override
  # by rewriting the two absolute paths before execution.
  true
fi
${body.replaceAll("/usr/share/nginx/html", path.join(dir, "nginx-html"))}
`;
  execFileSync("bash", ["-c", harness], {
    env: {
      ...process.env,
      PATH: process.env.PATH,
      OPENCLAW_GATEWAY_TOKEN: "gateway-token-test",
      AUTH_PASSWORD: "",
      AUTH_USERNAME: "admin",
      PORT: "8080",
      HOOKS_PATH: "",
      ...env,
    },
  });
  return fs.readFileSync(conf, "utf8");
}

execFileSync("bash", ["-n", ENTRYPOINT]);
assert(true, "entrypoint.sh passes bash -n");

// Generated per run. A fixed password literal in this file is flagged by secret scanners.
const authPassword = crypto.randomBytes(18).toString("base64url");
const withAuth = render(ENTRYPOINT, { AUTH_PASSWORD: authPassword });
const noAuth = render(ENTRYPOINT, { AUTH_PASSWORD: "" });

assert(!withAuth.includes("~^/api/\""), "no broad /api/ prefix");
assert(!withAuth.includes("~^/__openclaw__/\""), "no broad /__openclaw__/ prefix");
assert(!/~\^\/rpc[^\"]/.test(withAuth), "no unanchored /rpc bypass");
assert(withAuth.includes("~^/control-ui-config\\.json$"), "bootstrap config route anchored");
assert(
  withAuth.includes("~^/__openclaw__/control-ui-config\\.json$"),
  "namespaced bootstrap config route anchored",
);
assert(withAuth.includes("~^/api/users/[^/]+/avatar$"), "user avatar route anchored");
// Kept on purpose. OpenClaw 2026.10.5's Control UI fetches this exact path
// with Authorization: Bearer (chat local-media ?meta=1, and browser
// screenshot/download in ui/src/components/browser/browser-client.ts and
// browser-panel-download.ts). A bare URL with no source is 404 from the
// gateway even with a token; requests without Bearer still require basic auth.
assert(
  withAuth.includes("~^/__openclaw__/assistant-media$"),
  "assistant media stays on the bearer map because the Control UI sends Bearer",
);
assert(withAuth.includes("~^/__openclaw__/workspace-icon/[^/]+$"), "workspace icon route anchored");
assert(withAuth.includes("~^/__openclaw__/plugin-icon/[^/]+$"), "plugin icon route anchored");
assert(
  withAuth.includes("~^/api/chat/media/outgoing/"),
  "chat outgoing media route present",
);

const routeBlock = withAuth.slice(
  withAuth.indexOf("map $ocw_path $ocw_is_gateway_route"),
  withAuth.indexOf("map \"$ocw_is_bearer$ocw_is_gateway_route\""),
);
for (const line of routeBlock.split("\n")) {
  const match = line.match(/"(~[^"]+)"/);
  if (!match) continue;
  assert(match[1].startsWith("~^"), `route regex anchored at start: ${match[1]}`);
  assert(match[1].endsWith("$"), `route regex anchored at end: ${match[1]}`);
}

assert(withAuth.includes("1       $http_authorization;"), "passthrough forwards client Authorization");
assert(
  !withAuth.includes('proxy_set_header Authorization "Bearer gateway-token-test";'),
  "location / does not hardcode the gateway token when basic auth is on",
);
assert(withAuth.includes("proxy_set_header Authorization $ocw_upstream_auth;"), "upstream auth is the map");
assert(withAuth.includes('location /browser/') && withAuth.includes('auth_basic "Openclaw";'), "browser keeps literal basic auth");
assert(
  withAuth.indexOf('auth_basic "Openclaw";') > withAuth.indexOf("location /browser/"),
  "literal basic realm belongs to the browser location",
);
assert(
  !withAuth.includes("proxy_pass http://browser:3000/"),
  "browser upstream is not resolved at nginx startup",
);
assert(withAuth.includes("resolver 127.0.0.11 valid=10s ipv6=off;"), "browser location uses a lazy resolver");
assert(
  withAuth.includes("set $ocw_browser_upstream browser:3000;"),
  "unresolved browser host stays a lazy hostname",
);
assert(
  withAuth.includes("rewrite ^/browser/(.*)$ /$1 break;"),
  "browser location strips the /browser/ prefix",
);
assert(
  withAuth.includes("proxy_pass http://$ocw_browser_upstream;"),
  "browser location proxies through the variable upstream",
);
const browserLocation = withAuth.slice(withAuth.indexOf("location /browser/"));
assert(browserLocation.includes('auth_basic "Openclaw";'), "browser location itself requires basic auth");
assert(
  browserLocation.indexOf('auth_basic "Openclaw";') < browserLocation.indexOf("proxy_pass http://$ocw_browser_upstream;"),
  "basic auth is enforced before the browser proxy",
);
assert(!routeBlock.includes("/browser"), "browser sidecar is not a bearer bypass route");
assert(!noAuth.includes("proxy_pass http://browser:3000/"), "no-auth config also avoids the startup upstream");
assert(noAuth.includes("location /browser/"), "no-auth config still exposes /browser/");
assert(
  noAuth.includes("set $ocw_browser_upstream browser:3000;"),
  "no-auth config keeps the lazy browser hostname",
);

const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-getent-"));
fs.writeFileSync(
  path.join(fakeBin, "getent"),
  "#!/bin/sh\nif [ \"$1\" = \"ahostsv4\" ] && [ \"$2\" = \"browser\" ]; then\n  echo \"10.9.8.7 STREAM browser\"\n  exit 0\nfi\nexit 2\n",
);
fs.chmodSync(path.join(fakeBin, "getent"), 0o755);
const resolved = render(ENTRYPOINT, {
  AUTH_PASSWORD: authPassword,
  PATH: `${fakeBin}:${process.env.PATH}`,
});
assert(
  resolved.includes("set $ocw_browser_upstream 10.9.8.7:3000;"),
  "--add-host / getent address is pinned into the browser upstream",
);
assert(
  !resolved.includes("set $ocw_browser_upstream browser:3000;"),
  "resolved browser host replaces the lazy hostname",
);
assert(resolved.includes('auth_basic "Openclaw";'), "pinned browser upstream still requires basic auth");
assert(withAuth.includes("proxy_set_header X-Forwarded-For $remote_addr;"), "gateway hop overwrites X-Forwarded-For");
assert(
  withAuth.includes("proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"),
  "browser sidecar still appends X-Forwarded-For",
);

assert(!noAuth.includes("ocw_is_bearer"), "no bearer map when AUTH_PASSWORD is unset");
assert(!noAuth.includes("ocw_bearer_passthru"), "no passthrough map when AUTH_PASSWORD is unset");
assert(!noAuth.includes("auth_basic"), "no basic auth when AUTH_PASSWORD is unset");
assert(
  noAuth.includes('proxy_set_header Authorization "Bearer gateway-token-test";'),
  "unset password still injects the gateway token",
);
assert(
  noAuth.includes("proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"),
  "unset password keeps the previous X-Forwarded-For",
);

const mainEntrypoint = execFileSync("git", ["show", "origin/main:scripts/entrypoint.sh"], {
  cwd: ROOT,
  encoding: "utf8",
});
const mainFile = path.join(os.tmpdir(), "entrypoint-main.sh");
fs.writeFileSync(mainFile, mainEntrypoint);
const mainNoAuth = render(mainFile, { AUTH_PASSWORD: "" });
function normalizeRendered(text) {
  return text.replace(/\/tmp\/ocw-nginx-[A-Za-z0-9]+/g, "/tmp/ocw-nginx-TEST");
}
function stripHealthz(text) {
  const stripped = text
    .replace(/\n    location = \/healthz \{[\s\S]*?\n    \}\n/, "\n    # HEALTHZ\n")
    .replace(/\n    location @healthz_fallback \{[\s\S]*?\n    \}\n/, "\n    # HEALTHZ_FALLBACK\n");
  if (stripped === text) {
    throw new Error("healthz location block not found while comparing nginx configs");
  }
  return stripped;
}
function stripBrowserLocation(text) {
  const stripped = text.replace(
    /\n    # Browser sidecar proxy \(VNC web UI\)[^\n]*\n    location \/browser\/ \{[\s\S]*?\n    \}\n/,
    "\n    # BROWSER_LOCATION\n",
  );
  if (stripped === text) {
    throw new Error("browser location block not found while comparing nginx configs");
  }
  return stripped;
}
const noAuthNorm = stripHealthz(stripBrowserLocation(normalizeRendered(noAuth)));
const mainNoAuthNorm = stripHealthz(stripBrowserLocation(normalizeRendered(mainNoAuth)));
assert(
  noAuthNorm === mainNoAuthNorm,
  "AUTH_PASSWORD unset nginx config matches main aside from /healthz and the lazy /browser/ upstream",
);
if (noAuthNorm !== mainNoAuthNorm) {
  const a = noAuthNorm.split("\n");
  const b = mainNoAuthNorm.split("\n");
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      console.error(`    line ${i + 1}\n      now:  ${a[i]}\n      main: ${b[i]}`);
    }
  }
}

const entrypointSource = fs.readFileSync(ENTRYPOINT, "utf8");
const gatewayTokenGate = entrypointSource.indexOf("# >>> gateway-token-gate");
const gatewayTokenGateEnd = entrypointSource.indexOf("# <<< gateway-token-gate");
const nginxConfigStart = entrypointSource.indexOf("# ── Generate nginx config");
assert(
  gatewayTokenGate > 0 && gatewayTokenGateEnd > gatewayTokenGate && gatewayTokenGateEnd < nginxConfigStart,
  "gateway token charset is validated before nginx config is generated",
);
assert(
  entrypointSource.slice(gatewayTokenGate, gatewayTokenGateEnd).includes("^[A-Za-z0-9._~-]+$"),
  "entrypoint validates OPENCLAW_GATEWAY_TOKEN against the unreserved charset",
);
const nginxSectionSource = entrypointSource.slice(
  nginxConfigStart,
  entrypointSource.indexOf("# ── Start nginx"),
);
assert(
  (nginxSectionSource.match(/\$\{GATEWAY_TOKEN\}/g) || []).length === 6,
  "all six nginx gateway-token insertions are in the generated config section",
);
assert(
  !entrypointSource.replace(nginxSectionSource, "").includes("${GATEWAY_TOKEN}"),
  "the gateway token is not interpolated outside the nginx section",
);
const healthzSource = nginxSectionSource.slice(
  nginxSectionSource.indexOf("location = /healthz"),
  nginxSectionSource.indexOf("location @healthz_fallback"),
);
assert(!healthzSource.includes("GATEWAY_TOKEN"), "/healthz does not interpolate the gateway token");
assert(
  nginxSectionSource.includes("Bearer ${GATEWAY_TOKEN}") &&
    nginxSectionSource.includes("token=${GATEWAY_TOKEN}"),
  "bearer and token= query sites are inside the validated nginx section",
);
assert(
  entrypointSource.includes("openclaw doctor --fix"),
  "entrypoint still runs doctor --fix so upgrades keep migrating",
);
assert(
  !entrypointSource.includes(".doctor-fix-version"),
  "entrypoint does not skip doctor based on a version marker",
);
const snapshotCmd = entrypointSource.indexOf("\nnode /app/scripts/preserve-hand-edits.js snapshot");
const doctorCmd = entrypointSource.indexOf("\nopenclaw doctor --fix 2>&1");
const restoreCmd = entrypointSource.indexOf("\nnode /app/scripts/preserve-hand-edits.js restore");
const gatewayCmd = entrypointSource.indexOf("\nopenclaw gateway run");
assert(snapshotCmd > 0 && doctorCmd > snapshotCmd, "hand-edited keys are snapshotted before doctor");
assert(
  restoreCmd > doctorCmd && gatewayCmd > restoreCmd,
  "unrecognized keys are parked after doctor and before the gateway starts",
);
assert(
  !entrypointSource.includes("not restoring hand-edited keys"),
  "restore is not delayed until the gateway listens",
);
assert(
  entrypointSource.includes("gateway exited with status") &&
    entrypointSource.includes("/healthz will return 503"),
  "entrypoint stays up after the gateway exits so the healthcheck can fail",
);

function healthzBlock(conf) {
  const start = conf.indexOf("location = /healthz");
  const end = conf.indexOf("location @healthz_fallback");
  const fallbackEnd = conf.indexOf("location ", end + 1);
  return {
    location: conf.slice(start, end),
    fallback: conf.slice(end, fallbackEnd === -1 ? undefined : fallbackEnd),
  };
}
for (const [label, conf] of [["auth", withAuth], ["no-auth", noAuth]]) {
  const block = healthzBlock(conf);
  assert(
    block.location.includes("proxy_pass http://127.0.0.1:18789;"),
    `${label} /healthz proxies the gateway without rewriting the URI`,
  );
  assert(
    !block.location.includes("proxy_pass http://127.0.0.1:18789/;"),
    `${label} /healthz does not rewrite the URI to /`,
  );
  assert(!block.location.includes("auth_basic"), `${label} /healthz is not behind basic auth`);
  assert(block.fallback.includes('return 503 \''), `${label} /healthz fallback returns 503`);
  assert(!block.fallback.includes("return 200"), `${label} /healthz fallback is not 200`);
  assert(
    block.fallback.includes('{"ok":false,"status":"unavailable"}'),
    `${label} /healthz fallback is not a live probe body`,
  );
}

const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
assert(dockerfile.includes("curl -f http://localhost:${PORT:-8080}/healthz"), "HEALTHCHECK uses curl -f on /healthz");
assert(dockerfile.includes("--start-period=300s"), "HEALTHCHECK start-period covers first boot");
assert(!dockerfile.includes("--start-period=10s"), "HEALTHCHECK no longer uses the 10s start period");

// doctor --fix drops unrecognized top-level keys. The helper parks only those
// keys in the sidecar and leaves openclaw.json, including nested migrations, alone.
function runPreserve(action, dir, config) {
  const configPath = path.join(dir, "openclaw.json");
  const stash = path.join(dir, "stash.json");
  const extraPath = path.join(dir, "openclaw.extra.json");
  if (config) fs.writeFileSync(configPath, JSON.stringify(config));
  const stdout = execFileSync("node", [path.join(ROOT, "scripts/preserve-hand-edits.js"), action], {
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HAND_EDIT_STASH: stash,
      OPENCLAW_EXTRA_CONFIG: extraPath,
      OPENCLAW_STATE_DIR: dir,
    },
    encoding: "utf8",
  });
  return {
    config: JSON.parse(fs.readFileSync(configPath, "utf8")),
    configBytes: fs.readFileSync(configPath),
    stashExists: fs.existsSync(stash),
    extra: fs.existsSync(extraPath) ? JSON.parse(fs.readFileSync(extraPath, "utf8")) : null,
    stdout,
  };
}

const doctorConfig = {
  gateway: { auth: { mode: "token", token: "from-env" }, port: 18789 },
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
};
const handDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-hand-"));
runPreserve("snapshot", handDir, {
  "x-hand-edit": { note: "keep-me", n: 7 },
  gateway: { auth: { mode: "token", token: "from-env" }, port: 18789 },
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } },
});
// What doctor --fix does: drop the unknown top-level key and migrate a nested value.
const doctorPath = path.join(handDir, "openclaw.json");
fs.writeFileSync(doctorPath, JSON.stringify(doctorConfig));
const doctorBytes = fs.readFileSync(doctorPath);
const restored = runPreserve("restore", handDir);
assert(restored.config["x-hand-edit"] === undefined, "unknown top-level key is not written back into openclaw.json");
assert(restored.extra["x-hand-edit"].note === "keep-me", "unknown top-level key is parked in the sidecar");
assert(restored.extra["x-hand-edit"].n === 7, "parked top-level value is unchanged");
assert(!Object.prototype.hasOwnProperty.call(restored.extra, "gateway"), "schema keys are not copied into the sidecar");
assert(restored.configBytes.equals(doctorBytes), "restore does not rewrite openclaw.json");
assert(
  restored.config.agents.defaults.model.primary === "anthropic/claude-sonnet-4-6",
  "doctor migration of an env-driven nested setting is kept",
);
assert(restored.config.gateway.auth.token === "from-env", "env-driven gateway token is kept");
assert(!restored.stashExists, "hand-edit stash is removed after restore");
const second = runPreserve("restore", handDir);
assert(second.config["x-hand-edit"] === undefined, "restore is safe when the stash is already gone");
assert(second.extra["x-hand-edit"].note === "keep-me", "a second restore leaves the parked key in place");
assert(second.config.gateway.auth.token === "from-env", "a second restore does not rewrite env settings");

// Next boot: the sidecar is merged into the snapshot, doctor never sees the key,
// and the key is parked again. openclaw.json stays schema-valid.
runPreserve("snapshot", handDir);
fs.writeFileSync(doctorPath, JSON.stringify(doctorConfig));
const againBytes = fs.readFileSync(doctorPath);
const again = runPreserve("restore", handDir);
assert(again.extra["x-hand-edit"].note === "keep-me", "parked key survives another doctor run");
assert(again.config["x-hand-edit"] === undefined, "a later doctor run does not put the key back");
assert(again.configBytes.equals(againBytes), "a later restore still does not rewrite openclaw.json");

// Editing the sidecar is what a restart preserves.
fs.writeFileSync(
  path.join(handDir, "openclaw.extra.json"),
  JSON.stringify({ "x-hand-edit": { note: "edited-in-sidecar", n: 9 } }),
);
runPreserve("snapshot", handDir);
fs.writeFileSync(doctorPath, JSON.stringify(doctorConfig));
const edited = runPreserve("restore", handDir);
assert(edited.extra["x-hand-edit"].note === "edited-in-sidecar", "a sidecar edit survives the next start");
assert(edited.extra["x-hand-edit"].n === 9, "a sidecar edit keeps its new value");

// Existing volume: the previous image wrote the unknown key back into openclaw.json.
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-hand-legacy-"));
runPreserve("snapshot", legacyDir, {
  "x-hand-edit": { note: "legacy-volume", n: 3 },
  gateway: { port: 18789 },
});
fs.writeFileSync(path.join(legacyDir, "openclaw.json"), JSON.stringify({ gateway: { port: 18789 } }));
const legacy = runPreserve("restore", legacyDir);
assert(legacy.config["x-hand-edit"] === undefined, "legacy unknown key is removed from openclaw.json");
assert(legacy.extra["x-hand-edit"].note === "legacy-volume", "legacy unknown key is migrated into the sidecar");

// Crash between snapshot and restore must not drop the key on the next start.
const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-hand-crash-"));
runPreserve("snapshot", crashDir, {
  "x-hand-edit": { note: "survive-crash" },
  gateway: { port: 18789 },
});
fs.writeFileSync(path.join(crashDir, "openclaw.json"), JSON.stringify({ gateway: { port: 18789 } }));
runPreserve("snapshot", crashDir);
fs.writeFileSync(path.join(crashDir, "openclaw.json"), JSON.stringify({ gateway: { port: 18789 } }));
const crashed = runPreserve("restore", crashDir);
assert(crashed.extra["x-hand-edit"].note === "survive-crash", "an unrestored stash is merged into the next snapshot");
assert(crashed.config["x-hand-edit"] === undefined, "crash recovery still leaves openclaw.json schema-valid");

// Unsafe keys are not parked.
const unsafeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-hand-unsafe-"));
runPreserve("snapshot", unsafeDir, {
  constructor: { admin: true },
  gateway: { port: 18789 },
});
fs.writeFileSync(path.join(unsafeDir, "openclaw.json"), JSON.stringify({ gateway: { port: 18789 } }));
const unsafe = runPreserve("restore", unsafeDir);
assert(unsafe.extra === null, "unsafe top-level keys are not parked");

// trustedProxies default, and a custom list is preserved.
function runConfigure(extraEnv, custom) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-cfg-"));
  const configPath = path.join(dir, "openclaw.json");
  const customPath = path.join(dir, "custom.json");
  if (custom) fs.writeFileSync(customPath, JSON.stringify(custom));
  execFileSync("node", [path.join(ROOT, "scripts/configure.js")], {
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_TOKEN: "tok",
      ANTHROPIC_API_KEY: "sk-test",
      OPENCLAW_STATE_DIR: path.join(dir, "state"),
      OPENCLAW_WORKSPACE_DIR: path.join(dir, "workspace"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_CUSTOM_CONFIG: custom ? customPath : path.join(dir, "missing.json"),
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

const configured = runConfigure();
assert(
  JSON.stringify(configured.gateway.trustedProxies) === JSON.stringify(["127.0.0.1", "::1"]),
  "trustedProxies defaults to the nginx loopback hops",
);
assert(configured.gateway.auth.mode === "token", "auth mode stays token");
assert(
  configured.gateway.controlUi.allowInsecureAuth === undefined,
  "allowInsecureAuth is not written; OpenClaw 2026.10.5 rejects it",
);
const custom = runConfigure(
  {},
  { gateway: { trustedProxies: ["10.0.0.1"], auth: { mode: "token", token: "from-json" } } },
);
assert(
  JSON.stringify(custom.gateway.trustedProxies) === JSON.stringify(["10.0.0.1"]),
  "custom trustedProxies is not overwritten",
);

if (process.env.DUMP_NGINX === "1") {
  fs.writeFileSync("/tmp/nginx-with-auth.conf", withAuth);
  fs.writeFileSync("/tmp/nginx-no-auth.conf", noAuth);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
