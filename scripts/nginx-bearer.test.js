#!/usr/bin/env node
/**
 * Renders the nginx config the entrypoint would write, without starting nginx
 * or the gateway. Checks the bearer bypass is anchored to gateway-checked
 * routes, and that AUTH_PASSWORD unset stays byte-identical to main.
 *
 * Run: node scripts/nginx-bearer.test.js
 */

const { execFileSync } = require("child_process");
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

const withAuth = render(ENTRYPOINT, { AUTH_PASSWORD: "s3cret" });
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
assert(withAuth.includes("~^/__openclaw__/assistant-media$"), "assistant media route anchored");
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
const noAuthNorm = normalizeRendered(noAuth);
const mainNoAuthNorm = normalizeRendered(mainNoAuth);
assert(noAuthNorm === mainNoAuthNorm, "AUTH_PASSWORD unset nginx config is byte-identical to main");
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
