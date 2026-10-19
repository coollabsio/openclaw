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
const noAuthNorm = stripBrowserLocation(normalizeRendered(noAuth));
const mainNoAuthNorm = stripBrowserLocation(normalizeRendered(mainNoAuth));
assert(
  noAuthNorm === mainNoAuthNorm,
  "AUTH_PASSWORD unset nginx config matches main aside from the lazy /browser/ upstream",
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
assert(
  entrypointSource.includes("openclaw doctor --fix"),
  "entrypoint still runs doctor --fix so upgrades keep migrating",
);
assert(
  !entrypointSource.includes(".doctor-fix-version"),
  "entrypoint does not skip doctor based on a version marker",
);
assert(
  entrypointSource.includes("preserve-hand-edits.js snapshot") &&
    entrypointSource.includes("preserve-hand-edits.js restore"),
  "hand-edited keys are snapshotted before doctor and restored after the gateway listens",
);

// doctor --fix drops unrecognized top-level keys. The helper puts only those
// keys back and leaves nested env/migration edits alone.
function runPreserve(action, dir, config) {
  const configPath = path.join(dir, "openclaw.json");
  const stash = path.join(dir, "stash.json");
  if (config) fs.writeFileSync(configPath, JSON.stringify(config));
  execFileSync("node", [path.join(ROOT, "scripts/preserve-hand-edits.js"), action], {
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HAND_EDIT_STASH: stash,
      OPENCLAW_STATE_DIR: dir,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return {
    config: JSON.parse(fs.readFileSync(configPath, "utf8")),
    stashExists: fs.existsSync(stash),
  };
}

const handDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-hand-"));
runPreserve("snapshot", handDir, {
  "x-hand-edit": { note: "keep-me", n: 7 },
  gateway: { auth: { mode: "token", token: "from-env" }, port: 18789 },
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } },
});
// What doctor --fix does: drop the unknown top-level key and migrate a nested value.
fs.writeFileSync(
  path.join(handDir, "openclaw.json"),
  JSON.stringify({
    gateway: { auth: { mode: "token", token: "from-env" }, port: 18789 },
    agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
  }),
);
const restored = runPreserve("restore", handDir);
assert(restored.config["x-hand-edit"].note === "keep-me", "unknown top-level key is restored");
assert(restored.config["x-hand-edit"].n === 7, "restored top-level value is unchanged");
assert(
  restored.config.agents.defaults.model.primary === "anthropic/claude-sonnet-4-6",
  "doctor migration of an env-driven nested setting is kept",
);
assert(restored.config.gateway.auth.token === "from-env", "env-driven gateway token is kept");
assert(!restored.stashExists, "hand-edit stash is removed after restore");
const second = runPreserve("restore", handDir);
assert(!second.config["x-hand-edit"] || second.config["x-hand-edit"].note === "keep-me", "restore is safe when the stash is already gone");
assert(second.config.gateway.auth.token === "from-env", "a second restore does not rewrite env settings");

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
