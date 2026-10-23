#!/usr/bin/env bash
set -e

# >>> gateway-token-gate
# nginx copies this value into double-quoted strings (the Bearer header and the
# token= query) when it writes openclaw.conf. A quote, backslash, dollar,
# semicolon, brace, or space breaks that config and nginx exits with an
# "unexpected" error that does not name the token. Reject anything outside
# ^[A-Za-z0-9._~-]+$ before the config is generated and before volume setup.
# openssl rand -hex 32 matches. Nothing in this image generates a token.
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  echo "[entrypoint] ERROR: OPENCLAW_GATEWAY_TOKEN is required."
  echo "[entrypoint] Allowed characters: A-Z, a-z, 0-9, and . _ ~ -"
  echo "[entrypoint] Generate one with: openssl rand -hex 32"
  exit 1
fi
if ! [[ "${OPENCLAW_GATEWAY_TOKEN}" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "[entrypoint] ERROR: OPENCLAW_GATEWAY_TOKEN contains characters that are not allowed."
  echo "[entrypoint] Allowed characters: A-Z, a-z, 0-9, and . _ ~ -"
  echo "[entrypoint] Generate one with: openssl rand -hex 32"
  exit 1
fi
GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN"
# <<< gateway-token-gate

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

echo "[entrypoint] state dir: $STATE_DIR"
echo "[entrypoint] workspace dir: $WORKSPACE_DIR"

# ── Setup Persistent Storage for Tools ────────────────────────────────────────

echo "[entrypoint] setting up persistent tool storage in /data..."
UV_TOOL_DIR="${UV_TOOL_DIR:-/data/uv/tools}"
UV_TOOL_BIN_DIR="${UV_TOOL_BIN_DIR:-/data/uv/bin}"
UV_CACHE_DIR="${UV_CACHE_DIR:-/data/uv/cache}"
UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-/data/uv/python}"
# VIRTUAL_ENV is set in the image so docker exec and login shells see the venv.
# Keep it on /data: this script deletes and recreates the directory when the
# interpreter no longer runs.
PYTHON_VENV="${VIRTUAL_ENV:-/data/venv}"
case "$PYTHON_VENV" in
  /data/*) ;;
  *)
    echo "[entrypoint] ERROR: Python venv must live under /data (got $PYTHON_VENV)"
    exit 1
    ;;
esac
export UV_TOOL_DIR UV_TOOL_BIN_DIR UV_CACHE_DIR UV_PYTHON_INSTALL_DIR VIRTUAL_ENV="$PYTHON_VENV"
mkdir -p "$NPM_CONFIG_PREFIX/bin" "$UV_TOOL_DIR" "$UV_TOOL_BIN_DIR" "$UV_CACHE_DIR" "$UV_PYTHON_INSTALL_DIR" "$GOPATH/bin"

# Debian's python3 has no pip and refuses system installs (PEP 668). A venv on
# the volume provides python3, pip, and pip3. Packages installed with those
# commands survive container recreation. Replace the venv only when its
# interpreter does not run, such as after a Python minor version change.
if [ -x "$PYTHON_VENV/bin/python3" ] && "$PYTHON_VENV/bin/python3" -c 'import sys' >/dev/null 2>&1; then
  echo "[entrypoint] using persistent Python venv at $PYTHON_VENV"
else
  if [ -e "$PYTHON_VENV" ]; then
    echo "[entrypoint] replacing unusable Python venv at $PYTHON_VENV"
    rm -rf "$PYTHON_VENV"
  else
    echo "[entrypoint] creating persistent Python venv at $PYTHON_VENV"
  fi
  /usr/bin/python3 -m venv "$PYTHON_VENV"
fi

# Linuxbrew persistence and symlinking
BREW_PERSIST_DIR="/data/linuxbrew"
if [ ! -d "$BREW_PERSIST_DIR" ]; then
    echo "[entrypoint] Initializing persistent linuxbrew storage..."
    mkdir -p "$BREW_PERSIST_DIR"
    if [ -d "/home/linuxbrew/.linuxbrew" ] && [ ! -L "/home/linuxbrew/.linuxbrew" ]; then
        cp -a /home/linuxbrew/.linuxbrew/* "$BREW_PERSIST_DIR/" || true
        cp -a /home/linuxbrew/.linuxbrew/.[!.]* "$BREW_PERSIST_DIR/" 2>/dev/null || true
    fi
    chown -R linuxbrew:linuxbrew "$BREW_PERSIST_DIR"
fi

if [ ! -L "/home/linuxbrew/.linuxbrew" ]; then
    rm -rf /home/linuxbrew/.linuxbrew
    ln -s "$BREW_PERSIST_DIR" /home/linuxbrew/.linuxbrew
    chown -h linuxbrew:linuxbrew /home/linuxbrew/.linuxbrew
fi

# Ensure tool paths survive login-shell PATH reset (/etc/profile overwrites PATH)
cat << 'EOF' > /etc/profile.d/custom-tools.sh
export NPM_CONFIG_PREFIX="/data/npm-global"
export UV_TOOL_DIR="/data/uv/tools"
export UV_TOOL_BIN_DIR="/data/uv/bin"
export UV_CACHE_DIR="/data/uv/cache"
export UV_PYTHON_INSTALL_DIR="/data/uv/python"
export VIRTUAL_ENV="/data/venv"
export GOPATH="/data/go"
export PATH="/data/venv/bin:/data/npm-global/bin:/data/uv/bin:/data/go/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/go/bin:/root/.local/bin:$PATH"
EOF
chmod +x /etc/profile.d/custom-tools.sh

# Create a wrapper for brew to drop root privileges
cat << 'EOF' > "$NPM_CONFIG_PREFIX/bin/brew"
#!/bin/bash
if [ "$(id -u)" = "0" ]; then
    export HOME=/home/linuxbrew
    export USER=linuxbrew
    exec runuser -u linuxbrew -- /home/linuxbrew/.linuxbrew/bin/brew "$@"
else
    exec /home/linuxbrew/.linuxbrew/bin/brew "$@"
fi
EOF
chmod +x "$NPM_CONFIG_PREFIX/bin/brew"

# ── Install extra apt packages (if requested) ────────────────────────────────
if [ -n "${OPENCLAW_DOCKER_APT_PACKAGES:-}" ]; then
  echo "[entrypoint] installing extra packages: $OPENCLAW_DOCKER_APT_PACKAGES"
  apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      $OPENCLAW_DOCKER_APT_PACKAGES \
    && rm -rf /var/lib/apt/lists/*
fi

# ── Require at least one AI provider API key env var ─────────────────────────
# Providers always read API keys from env vars, never from JSON config.
HAS_PROVIDER=0
for key in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY \
           DEEPSEEK_API_KEY XAI_API_KEY GROQ_API_KEY MISTRAL_API_KEY CEREBRAS_API_KEY \
           VENICE_API_KEY MOONSHOT_API_KEY KIMI_API_KEY MINIMAX_API_KEY \
           ZAI_API_KEY AI_GATEWAY_API_KEY OPENCODE_API_KEY OPENCODE_ZEN_API_KEY \
           SYNTHETIC_API_KEY COPILOT_GITHUB_TOKEN XIAOMI_API_KEY; do
  [ -n "${!key:-}" ] && HAS_PROVIDER=1 && break
done
[ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && HAS_PROVIDER=1
[ -n "${OLLAMA_BASE_URL:-}" ] && HAS_PROVIDER=1
# Base URL and model are both required. A key alone must not count as a provider.
# The key is optional for local servers and is never printed.
# Name whichever required variable is missing, using the same helper as configure.js.
# >>> openai-compatible-gate
_openclaw_utils="${OPENCLAW_UTILS_JS:-}"
if [ -z "$_openclaw_utils" ]; then
  _openclaw_utils="$(cd "$(dirname "$0")" && pwd)/utils.js"
fi
openai_compatible_status="$(node -e '
const { resolveOpenAICompatibleProvider } = require(process.argv[1]);
const result = resolveOpenAICompatibleProvider({
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
  baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
  model: process.env.OPENAI_COMPATIBLE_MODEL,
});
if (result.action === "apply") {
  process.stdout.write("apply");
} else if (result.action === "incomplete" && result.warning) {
  process.stdout.write(result.warning.replace(/^\[configure\]/, "[entrypoint]"));
}
' "$_openclaw_utils")"
if [ "$openai_compatible_status" = "apply" ]; then
  HAS_PROVIDER=1
elif [ -n "$openai_compatible_status" ]; then
  printf '%s\n' "$openai_compatible_status"
fi
# <<< openai-compatible-gate
if [ "$HAS_PROVIDER" -eq 0 ]; then
  echo "[entrypoint] ERROR: At least one AI provider API key env var is required."
  echo "[entrypoint] Providers read API keys from env vars, never from the JSON config."
  echo "[entrypoint] Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY,"
  echo "[entrypoint]   DEEPSEEK_API_KEY, XAI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, CEREBRAS_API_KEY, VENICE_API_KEY,"
  echo "[entrypoint]   MOONSHOT_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY, ZAI_API_KEY, AI_GATEWAY_API_KEY,"
  echo "[entrypoint]   OPENCODE_API_KEY, SYNTHETIC_API_KEY, COPILOT_GITHUB_TOKEN, XIAOMI_API_KEY"
  echo "[entrypoint] Or: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (Bedrock), OLLAMA_BASE_URL (local),"
  echo "[entrypoint]   or OPENAI_COMPATIBLE_BASE_URL + OPENAI_COMPATIBLE_MODEL (OpenAI-compatible; API key optional)"
  exit 1
fi

mkdir -p "$STATE_DIR" "$WORKSPACE_DIR"
mkdir -p "$STATE_DIR/agents/main/sessions" "$STATE_DIR/credentials"
chmod 700 "$STATE_DIR"

# Export state/workspace dirs so openclaw CLI + configure.js see them.
# OPENCLAW_HOME is consulted before HOME. Pin both so a child that resets
# HOME to the passwd home (/root) still resolves ~/.openclaw onto the volume.
# Do not symlink /root/.openclaw at the state dir: doctor treats that as two
# state directories and can split session history.
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR"
export OPENCLAW_HOME="${STATE_DIR%/.openclaw}"
export HOME="$OPENCLAW_HOME"

# Sessions written before this pin landed under the account home
# (/root/.openclaw), which is the container writable layer, not the volume.
# Copy missing session databases onto the volume, then retire that directory
# so the next start cannot keep appending outside the mount. Never replace a
# file the volume already has, and never follow symlinks.
account_home="$(getent passwd "$(id -u)" 2>/dev/null | awk -F: '{ print $6; exit }' || true)"
legacy_state="${account_home%/}/.openclaw"
if [ -n "$account_home" ] && [ -d "$legacy_state" ] && [ ! -L "$legacy_state" ]; then
  legacy_real="$(readlink -f "$legacy_state" 2>/dev/null || true)"
  state_real="$(readlink -f "$STATE_DIR" 2>/dev/null || true)"
  if [ -n "$legacy_real" ] && [ "$legacy_real" != "$state_real" ]; then
    migrated=0
    for agent_dir in "$legacy_state"/agents/*; do
      [ -d "$agent_dir" ] && [ ! -L "$agent_dir" ] || continue
      agent_id="$(basename "$agent_dir")"
      case "$agent_id" in
        *[!A-Za-z0-9._-]*) continue ;;
      esac
      src_db="$agent_dir/agent/openclaw-agent.sqlite"
      if [ -f "$src_db" ] && [ ! -L "$src_db" ]; then
        dest_agent="$STATE_DIR/agents/$agent_id/agent"
        dest_db="$dest_agent/openclaw-agent.sqlite"
        # A database already on the volume wins. Do not stitch a WAL from /root
        # onto a different database.
        if [ ! -e "$dest_db" ] && [ ! -L "$dest_db" ]; then
          mkdir -p "$dest_agent"
          cp -a "$src_db" "$dest_db"
          for sidecar in "$src_db"-*; do
            [ -f "$sidecar" ] && [ ! -L "$sidecar" ] || continue
            cp -a "$sidecar" "$dest_agent/$(basename "$sidecar")"
          done
          echo "[entrypoint] migrated chat history for agent $agent_id onto $STATE_DIR"
          migrated=1
        fi
      fi
      if [ -d "$agent_dir/sessions" ] && [ ! -L "$agent_dir/sessions" ]; then
        while IFS= read -r -d '' session_file; do
          rel="${session_file#"$agent_dir/sessions"/}"
          case "$rel" in
            *..*) continue ;;
          esac
          dest_file="$STATE_DIR/agents/$agent_id/sessions/$rel"
          if [ -e "$dest_file" ] || [ -L "$dest_file" ]; then
            continue
          fi
          mkdir -p "$(dirname "$dest_file")"
          cp -a "$session_file" "$dest_file"
          migrated=1
        done < <(find -P "$agent_dir/sessions" -type f -print0)
      fi
    done
    src_state_db="$legacy_state/state/openclaw.sqlite"
    dest_state_db="$STATE_DIR/state/openclaw.sqlite"
    if [ -f "$src_state_db" ] && [ ! -L "$src_state_db" ] && [ ! -e "$dest_state_db" ] && [ ! -L "$dest_state_db" ]; then
      mkdir -p "$STATE_DIR/state"
      cp -a "$src_state_db" "$dest_state_db"
      for sidecar in "$src_state_db"-*; do
        [ -f "$sidecar" ] && [ ! -L "$sidecar" ] || continue
        cp -a "$sidecar" "$STATE_DIR/state/$(basename "$sidecar")"
      done
      echo "[entrypoint] migrated shared state database onto $STATE_DIR"
      migrated=1
    fi
    # Retire the account-home store even when the volume already had the
    # database. Leaving it in place keeps a second history outside the mount.
    # The rename stays on the container layer until the container is removed.
    legacy_db="$(find -P "$legacy_state" -type f -name 'openclaw-agent.sqlite' -print -quit 2>/dev/null || true)"
    if [ "$migrated" -eq 1 ] || [ -n "$legacy_db" ]; then
      chmod 700 "$STATE_DIR"
      mv "$legacy_state" "${legacy_state}.migrated.$$"
      echo "[entrypoint] retired ephemeral state dir $legacy_state (not on the /data volume)"
    fi
  fi
fi

# ── Run custom init script (if provided) ─────────────────────────────────────
INIT_SCRIPT="${OPENCLAW_DOCKER_INIT_SCRIPT:-}"
if [ -n "$INIT_SCRIPT" ]; then
  if [ ! -f "$INIT_SCRIPT" ]; then
    echo "[entrypoint] WARNING: init script not found: $INIT_SCRIPT"
  else
    # Auto-make executable — volume mounts often lose +x
    chmod +x "$INIT_SCRIPT" 2>/dev/null || true
    echo "[entrypoint] running init script: $INIT_SCRIPT"
    "$INIT_SCRIPT" || echo "[entrypoint] WARNING: init script exited with code $?"
  fi
fi

# ── Configure openclaw from env vars ─────────────────────────────────────────
echo "[entrypoint] running configure..."
node /app/scripts/configure.js
chmod 600 "$STATE_DIR/openclaw.json"

# ── Doctor repairs, parking unrecognized top-level keys ─────────────────────
# OpenClaw 2026.10.5 validates openclaw.json with a strict object schema.
# `openclaw doctor --fix` rewrites the file through that schema, so an extra
# top-level key disappears. Leaving that key in openclaw.json makes
# `gateway run` exit at process start ("Unrecognized key"). Writing it back
# after the gateway is listening keeps the process up (reload is skipped) but
# the CLI exits 1 on the same error, which breaks `devices list`, `devices
# approve`, and `sessions`.
#
# Doctor still runs on every start. configure.js reapplies env-driven values
# each boot, including model ids that doctor upgrades, and upgrades must keep
# migrating state. --lint / --json do not apply those repairs. A version marker
# that skips doctor leaves the reapplied env value unmigrated and the gateway
# exits. Related to #15.
#
# Keys doctor removes are parked in openclaw.extra.json on the state volume.
# openclaw.json stays as doctor wrote it. Nested env-driven settings are not
# reverted. A volume that already has those keys in openclaw.json is migrated
# here: doctor strips them, and restore writes the sidecar.
echo "[entrypoint] snapshotting config before openclaw doctor --fix..."
node /app/scripts/preserve-hand-edits.js snapshot || echo "[entrypoint] WARNING: could not snapshot hand-edited keys"
echo "[entrypoint] running openclaw doctor --fix..."
if [ -d /opt/openclaw/app ]; then
  cd /opt/openclaw/app
fi
doctor_status=0
openclaw doctor --fix 2>&1 || doctor_status=$?
if [ "$doctor_status" -ne 0 ]; then
  echo "[entrypoint] WARNING: openclaw doctor --fix exited $doctor_status"
fi
node /app/scripts/preserve-hand-edits.js restore || echo "[entrypoint] WARNING: could not park hand-edited keys"

# ── Read hooks path from generated config (if hooks enabled) ─────────────────
HOOKS_PATH=""
HOOKS_PATH=$(node -e "
  try {
    const c = JSON.parse(require('fs').readFileSync('$STATE_DIR/openclaw.json','utf8'));
    if (c.hooks && c.hooks.enabled) process.stdout.write(c.hooks.path || '/hooks');
  } catch {}
" 2>/dev/null || true)
if [ -n "$HOOKS_PATH" ]; then
  echo "[entrypoint] hooks enabled, path: $HOOKS_PATH (will bypass HTTP auth)"
fi

# ── Generate nginx config ────────────────────────────────────────────────────
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"
NGINX_CONF="/etc/nginx/conf.d/openclaw.conf"

AUTH_BLOCK=""
BROWSER_AUTH_BLOCK=""
# Bearer-aware pieces. Empty unless basic auth is on, so the no-auth path below
# generates a byte-identical config to before.
BEARER_MAPS=""
UPSTREAM_AUTH="\"Bearer ${GATEWAY_TOKEN}\""
PROXY_ARGS_MAP="map \"\$ocw_has_token:\$args\" \$ocw_proxy_args {
    ~^1:    \$args;
    ~^0:.+  \"\$args&token=${GATEWAY_TOKEN}\";
    default \"token=${GATEWAY_TOKEN}\";
}"
# Inserted directly into the unquoted nginx heredoc (expanded once, not rescanned).
XFF_DIRECT='$proxy_add_x_forwarded_for'
# The hooks block is pasted into that heredoc too, so it is not rescanned either:
# nginx must receive a plain "$" (an escaped one reached nginx as "\<ip>").
HOOKS_XFF='$proxy_add_x_forwarded_for'

if [ -n "$AUTH_PASSWORD" ]; then
  echo "[entrypoint] setting up nginx basic auth (user: $AUTH_USERNAME)"
  htpasswd -bc /etc/nginx/.htpasswd "$AUTH_USERNAME" "$AUTH_PASSWORD" 2>/dev/null
  # /browser/ never consults the bearer map. It is the VNC sidecar, not a gateway route.
  BROWSER_AUTH_BLOCK='auth_basic "Openclaw";
        auth_basic_user_file /etc/nginx/.htpasswd;'
  AUTH_BLOCK='auth_basic $ocw_auth_realm;
        auth_basic_user_file /etc/nginx/.htpasswd;'

  # The Control UI authenticates to the gateway with `Authorization: Bearer
  # <token>` (a per-device token, the stored gateway token, or the password).
  # A request carries only one Authorization header, so that Bearer replaces the
  # browser's Basic credentials, auth_basic returns 401 + WWW-Authenticate, and
  # the browser prompts again. Skip basic auth only for the exact paths the UI
  # fetches that way, and only when the header is Bearer, then forward the
  # client's header unchanged so the gateway — not nginx — accepts or rejects it.
  #
  # "/" and the WebSocket stay on basic auth: the gateway serves the UI shell
  # without its own token check, so a bogus Bearer there must not walk past nginx.
  # Every pattern is anchored. Prefixes such as /api/ or /__openclaw__/ are not
  # used, and /rpc is not included: gateway RPC is the WebSocket, and an
  # unanchored ^/rpc match would also exempt /rpcanything.
  #
  # /__openclaw__/assistant-media stays on this list. A request with no
  # Authorization header (img/audio src, mediaTicket query) still requires
  # basic auth. The Control UI also fetches this exact path with
  # `Authorization: Bearer <device or dashboard token>` — chat local-media
  # metadata (?meta=1) and browser screenshot/download
  # (ui/src/components/browser/browser-client.ts fetchBrowserScreenshotDataUrl,
  # browser-panel-download.ts). That Bearer replaces the browser's Basic
  # credentials, so this path has to skip basic auth or nginx re-prompts.
  # A bare URL with no `source` is 404 from the gateway even with a token;
  # that is a missing-source response, not an auth grant. Requests without
  # Bearer still hit auth_basic below.
  #
  # $ocw_path is the raw request path with the query stripped, so percent-encoding
  # stays intact (catalog icons encode slashes) and ?token= cannot change the match.
  BEARER_MAPS="map \$http_authorization \$ocw_is_bearer {
    default           0;
    \"~*^Bearer\$\"    1;
    \"~*^Bearer[[:space:]]\" 1;
}

map \$request_uri \$ocw_path {
    \"~^([^?]*)\"  \$1;
    default       \$uri;
}

map \$ocw_path \$ocw_is_gateway_route {
    default 0;
    \"~^/control-ui-config\\.json\$\" 1;
    \"~^/__openclaw__/control-ui-config\\.json\$\" 1;
    \"~^/api/users/[^/]+/avatar\$\" 1;
    \"~^/avatar/[^/]+\$\" 1;
    \"~^/__openclaw__/assistant-media\$\" 1;
    \"~^/__openclaw__/workspace-icon/[^/]+\$\" 1;
    \"~^/__openclaw__/plugin-icon/[^/]+\$\" 1;
    \"~^/__openclaw__/plugin-activity-icon/[^/]+\$\" 1;
    \"~^/__openclaw__/catalog-icon/[^/]+\$\" 1;
    \"~^/__openclaw__/link-favicon/[^/]+\$\" 1;
    \"~^/__openclaw__/channel-avatar/[^/]+\$\" 1;
    \"~^/__openclaw__/plugin-theme-art/[^/]+/[^/]+/[^/]+/[^/]+\$\" 1;
    \"~^/__openclaw__/plugins/control-ui/[^/]+/[0-9a-fA-F]{64}/.+\$\" 1;
    \"~^/api/chat/media/outgoing/[^/]+/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/(full|thumbnail)\$\" 1;
}

map \"\$ocw_is_bearer\$ocw_is_gateway_route\" \$ocw_bearer_passthru {
    default 0;
    \"11\"    1;
}

map \$ocw_bearer_passthru \$ocw_auth_realm {
    default \"Openclaw\";
    1       \"off\";
}

map \$ocw_bearer_passthru \$ocw_upstream_auth {
    default \"Bearer ${GATEWAY_TOKEN}\";
    1       \$http_authorization;
}

"
  UPSTREAM_AUTH="\$ocw_upstream_auth"
  # Never append nginx's own token to a passthrough request either, or the
  # carve-out would hand out authenticated access instead of delegating it.
  PROXY_ARGS_MAP="map \"\$ocw_bearer_passthru:\$ocw_has_token:\$args\" \$ocw_proxy_args {
    \"~^1:[01]:(?<ocw_bargs>.*)\$\"  \$ocw_bargs;
    \"~^0:1:\"                  \$args;
    \"~^0:0:.+\"                \"\$args&token=${GATEWAY_TOKEN}\";
    default                   \"token=${GATEWAY_TOKEN}\";
}"
  # Overwrite, do not append. The gateway trusts 127.0.0.1 and reads the
  # rightmost untrusted X-Forwarded-For hop; a client-supplied value must not
  # be that hop when the TCP peer is loopback.
  XFF_DIRECT='$remote_addr'
  HOOKS_XFF='$remote_addr'
else
  echo "[entrypoint] no AUTH_PASSWORD set, nginx will not require authentication"
fi

# Build hooks location block (skips HTTP basic auth, openclaw validates hook token)
HOOKS_LOCATION_BLOCK=""
if [ -n "$HOOKS_PATH" ]; then
  HOOKS_LOCATION_BLOCK="location ${HOOKS_PATH} {
        proxy_pass http://127.0.0.1:${GATEWAY_PORT};
        proxy_set_header Authorization \$http_authorization;

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For ${HOOKS_XFF};
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_http_version 1.1;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        error_page 502 503 504 /starting.html;
    }"
fi

# nginx resolves a literal `proxy_pass http://browser:3000/` at startup and
# refuses to boot when that name does not exist (issue #39). The sidecar is
# optional: compose names it `browser` (VNC on :3000, CDP via BROWSER_CDP_URL),
# and a plain `docker run` has no such host. A variable proxy_pass is resolved
# by `resolver` on each request, so a missing sidecar returns 502/503 instead
# of taking nginx down. /browser/ stays on basic auth whenever AUTH_PASSWORD
# is set; it is not part of the bearer map.
#
# Docker's embedded DNS (127.0.0.11) does not read /etc/hosts, and
# `docker run --add-host browser:…` only writes /etc/hosts. When getent can
# already resolve the name, pin that address so both Docker DNS and --add-host
# work. Otherwise keep the hostname for a later lookup.
BROWSER_UPSTREAM_HOST="browser"
RESOLVED_BROWSER_IP=""
if command -v getent >/dev/null 2>&1; then
  # getent exits 2 when the name is missing. The entrypoint runs under `set -e`,
  # and the nginx unit test adds `pipefail`, so a missing sidecar must not abort
  # config generation.
  RESOLVED_BROWSER_IP="$(getent ahostsv4 browser 2>/dev/null | awk 'NR==1 { print $1; exit }' || true)"
  case "$RESOLVED_BROWSER_IP" in
    ""|*[!0-9.]*) ;;
    *) BROWSER_UPSTREAM_HOST="$RESOLVED_BROWSER_IP" ;;
  esac
fi
if [ "$BROWSER_UPSTREAM_HOST" = "browser" ]; then
  echo "[entrypoint] browser host not resolved; /browser/ will proxy lazily via Docker DNS"
else
  echo "[entrypoint] browser host resolved to $BROWSER_UPSTREAM_HOST"
fi

# ── Write startup page for 502/503/504 while gateway boots ───────────────────
mkdir -p /usr/share/nginx/html
cat > /usr/share/nginx/html/starting.html <<'STARTPAGE'
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Openclaw - Starting</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { text-align: center; max-width: 480px; padding: 2.5rem; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; }
    p { color: #a3a3a3; line-height: 1.6; margin-bottom: 1.5rem; }
    .spinner { width: 32px; height: 32px; border: 3px solid #333; border-top-color: #e5e5e5; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1.5rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .retry { color: #737373; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Openclaw is starting up</h1>
    <p>The gateway is initializing.</p>
    <p>This usually takes a few minutes.</p>
    <p class="retry">This page will auto-refresh.</p>
  </div>
  <script>setTimeout(function(){ location.reload(); }, 3000);</script>
</body>
</html>
STARTPAGE

cat > "$NGINX_CONF" <<NGINXEOF
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

map \$arg_token \$ocw_has_token {
    ''      0;
    default 1;
}

${BEARER_MAPS}${PROXY_ARGS_MAP}

server {
    listen ${PORT:-8080} default_server;
    server_name _;
    absolute_redirect off;

    location = /healthz {
        # No basic auth: Coolify and the image HEALTHCHECK probe this path.
        # proxy_pass has no URI on purpose. A trailing slash rewrites /healthz
        # to / and the gateway answers with the Control UI. The live probe is
        # the gateway's own /healthz.
        access_log off;
        proxy_pass http://127.0.0.1:${GATEWAY_PORT};
        proxy_set_header Host \$host;
        proxy_connect_timeout 2s;
        proxy_read_timeout 4s;
        error_page 502 503 504 = @healthz_fallback;
    }

    location @healthz_fallback {
        default_type application/json;
        return 503 '{"ok":false,"status":"unavailable"}';
    }

    ${HOOKS_LOCATION_BLOCK}

    location / {
        ${AUTH_BLOCK}

        proxy_pass http://127.0.0.1:${GATEWAY_PORT}\$uri?\$ocw_proxy_args;
        proxy_set_header Authorization ${UPSTREAM_AUTH};

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For ${XFF_DIRECT};
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        error_page 502 503 504 /starting.html;
    }

    location = /starting.html {
        root /usr/share/nginx/html;
        internal;
    }

    # Browser sidecar proxy (VNC web UI). Variable upstream: see issue #39.
    location /browser/ {
        ${BROWSER_AUTH_BLOCK}

        resolver 127.0.0.11 valid=10s ipv6=off;
        resolver_timeout 5s;
        set \$ocw_browser_upstream ${BROWSER_UPSTREAM_HOST}:3000;
        rewrite ^/browser/(.*)\$ /\$1 break;
        proxy_pass http://\$ocw_browser_upstream;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
NGINXEOF

# ── Start nginx ──────────────────────────────────────────────────────────────
echo "[entrypoint] starting nginx on port ${PORT:-8080}..."
nginx

# ── Clean up stale lock files ────────────────────────────────────────────────
rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$STATE_DIR/gateway.lock" 2>/dev/null || true

# ── Start openclaw gateway ───────────────────────────────────────────────────
echo "[entrypoint] starting openclaw gateway on port $GATEWAY_PORT..."

# cwd must be the app root so the gateway finds dist/control-ui/ assets
# "gateway run" = foreground mode; all config comes from openclaw.json
cd /opt/openclaw/app
openclaw gateway run &
GATEWAY_PID=$!
trap 'kill -TERM "$GATEWAY_PID" 2>/dev/null || true; wait "$GATEWAY_PID" 2>/dev/null || true; exit 0' TERM INT

# Keep pid 1 and nginx alive if the gateway process exits. /healthz then
# returns 503 and the image HEALTHCHECK can mark the container unhealthy.
# Exiting here would stop the container before those probes run.
gateway_gone=0
while true; do
  if [ "$gateway_gone" -eq 0 ] && ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    gateway_status=0
    wait "$GATEWAY_PID" || gateway_status=$?
    gateway_gone=1
    echo "[entrypoint] gateway exited with status ${gateway_status}; /healthz will return 503"
  fi
  sleep 2 || true
done
