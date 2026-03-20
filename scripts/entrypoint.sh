#!/usr/bin/env bash
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

echo "[entrypoint] state dir: $STATE_DIR"
echo "[entrypoint] workspace dir: $WORKSPACE_DIR"

# ── Setup Persistent Storage for Tools ────────────────────────────────────────

echo "[entrypoint] setting up persistent tool storage in /data..."
mkdir -p "$NPM_CONFIG_PREFIX/bin" "$UV_TOOL_DIR/bin" "$UV_CACHE_DIR" "$GOPATH/bin"

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
export UV_CACHE_DIR="/data/uv/cache"
export GOPATH="/data/go"
export PATH="/data/npm-global/bin:/data/uv/tools/bin:/data/go/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/go/bin:$PATH"
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

# ── Docker API access (install CLI when socket is available) ─────────────────
# Mount /var/run/docker.sock (or set DOCKER_HOST) to let openclaw agents run
# docker commands. The Docker CLI is installed automatically on first start.
_docker_sock="${DOCKER_HOST:-unix:///var/run/docker.sock}"
_docker_sock_path="${_docker_sock#unix://}"
if [ -S "$_docker_sock_path" ] || [ -n "${DOCKER_HOST:-}" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "[entrypoint] Docker socket detected — installing Docker CLI..."
    apt-get update \
      && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        docker.io \
      && rm -rf /var/lib/apt/lists/*
  else
    echo "[entrypoint] Docker CLI already installed"
  fi
  # Ensure the openclaw process can reach the socket
  if [ -S "$_docker_sock_path" ]; then
    chmod 666 "$_docker_sock_path" 2>/dev/null || true
    echo "[entrypoint] Docker socket ready: $_docker_sock_path"
  fi
fi

# ── Require OPENCLAW_GATEWAY_TOKEN ───────────────────────────────────────────
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  echo "[entrypoint] ERROR: OPENCLAW_GATEWAY_TOKEN is required."
  echo "[entrypoint] Generate one with: openssl rand -hex 32"
  exit 1
fi
GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN"

# ── Require at least one AI provider API key env var ─────────────────────────
# Providers always read API keys from env vars, never from JSON config.
HAS_PROVIDER=0
for key in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY \
           XAI_API_KEY GROQ_API_KEY MISTRAL_API_KEY CEREBRAS_API_KEY \
           VENICE_API_KEY MOONSHOT_API_KEY KIMI_API_KEY MINIMAX_API_KEY \
           ZAI_API_KEY AI_GATEWAY_API_KEY OPENCODE_API_KEY OPENCODE_ZEN_API_KEY \
           SYNTHETIC_API_KEY COPILOT_GITHUB_TOKEN XIAOMI_API_KEY; do
  [ -n "${!key:-}" ] && HAS_PROVIDER=1 && break
done
[ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && HAS_PROVIDER=1
[ -n "${OLLAMA_BASE_URL:-}" ] && HAS_PROVIDER=1
if [ "$HAS_PROVIDER" -eq 0 ]; then
  echo "[entrypoint] ERROR: At least one AI provider API key env var is required."
  echo "[entrypoint] Providers read API keys from env vars, never from the JSON config."
  echo "[entrypoint] Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY,"
  echo "[entrypoint]   XAI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, CEREBRAS_API_KEY, VENICE_API_KEY,"
  echo "[entrypoint]   MOONSHOT_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY, ZAI_API_KEY, AI_GATEWAY_API_KEY,"
  echo "[entrypoint]   OPENCODE_API_KEY, SYNTHETIC_API_KEY, COPILOT_GITHUB_TOKEN, XIAOMI_API_KEY"
  echo "[entrypoint] Or: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (Bedrock), OLLAMA_BASE_URL (local)"
  exit 1
fi

mkdir -p "$STATE_DIR" "$WORKSPACE_DIR"
mkdir -p "$STATE_DIR/agents/main/sessions" "$STATE_DIR/credentials"
chmod 700 "$STATE_DIR"

# Export state/workspace dirs so openclaw CLI + configure.js see them
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR"

# Set HOME so that ~/.openclaw resolves to $STATE_DIR directly.
# This avoids "multiple state directories" warnings from openclaw doctor
# (symlinks are detected as separate paths).
export HOME="${STATE_DIR%/.openclaw}"

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
# Clear persisted openclaw.json on each startup to prevent version-mismatch
# crashes when the base image version changes. All config is reconstructed
# from env vars by configure.js + openclaw doctor --fix, so nothing is lost.
echo "[entrypoint] clearing persisted openclaw.json (rebuilt from env vars)"
rm -f "$STATE_DIR/openclaw.json" 2>/dev/null || true

echo "[entrypoint] running configure..."
node /app/scripts/configure.js


chmod 600 "$STATE_DIR/openclaw.json"

# ── Auto-fix doctor suggestions (e.g. enable configured channels) ─────────
echo "[entrypoint] running openclaw doctor --fix..."
cd /opt/openclaw/app
openclaw doctor --fix 2>&1 || true

# ── One-time pairing approvals ────────────────────────────────────────────────
# Set OPENCLAW_PAIR_APPROVE=<channel>:<code> to approve a pairing on startup.
# Example: OPENCLAW_PAIR_APPROVE=telegram:CRSJTY6S
# The env var is consumed once; remove it from Coolify after the next redeploy.
if [ -n "${OPENCLAW_PAIR_APPROVE:-}" ]; then
  PAIR_CHANNEL=$(echo "$OPENCLAW_PAIR_APPROVE" | cut -d: -f1)
  PAIR_CODE=$(echo "$OPENCLAW_PAIR_APPROVE" | cut -d: -f2)
  echo "[entrypoint] approving pairing: $PAIR_CHANNEL $PAIR_CODE"
  cd /opt/openclaw/app
  openclaw pairing approve "$PAIR_CHANNEL" "$PAIR_CODE" 2>&1 || true
fi

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
if [ -n "$AUTH_PASSWORD" ]; then
  echo "[entrypoint] setting up nginx basic auth (user: $AUTH_USERNAME)"
  htpasswd -bc /etc/nginx/.htpasswd "$AUTH_USERNAME" "$AUTH_PASSWORD" 2>/dev/null
  AUTH_BLOCK='auth_basic "Openclaw";
        auth_basic_user_file /etc/nginx/.htpasswd;'
else
  echo "[entrypoint] no AUTH_PASSWORD set, nginx will not require authentication"
fi

# Build hooks location block (skips HTTP basic auth, openclaw validates hook token)
HOOKS_LOCATION_BLOCK=""
if [ -n "$HOOKS_PATH" ]; then
  HOOKS_LOCATION_BLOCK="location ${HOOKS_PATH} {
        proxy_pass http://127.0.0.1:${GATEWAY_PORT};
        proxy_set_header Authorization \\\$http_authorization;

        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;

        proxy_http_version 1.1;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        error_page 502 503 504 /starting.html;
    }"
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

map "\$ocw_has_token:\$args" \$ocw_proxy_args {
    ~^1:    \$args;
    ~^0:.+  "\$args&token=${GATEWAY_TOKEN}";
    default "token=${GATEWAY_TOKEN}";
}

server {
    listen ${PORT:-8080} default_server;
    server_name _;
    absolute_redirect off;

    location = /healthz {
        access_log off;
        proxy_pass http://127.0.0.1:${GATEWAY_PORT}/;
        proxy_set_header Host \$host;
        proxy_connect_timeout 2s;
        error_page 502 503 504 = @healthz_fallback;
    }

    location @healthz_fallback {
        return 200 '{"ok":true,"gateway":"starting"}';
        default_type application/json;
    }

    ${HOOKS_LOCATION_BLOCK}

    location / {
        ${AUTH_BLOCK}

        proxy_pass http://127.0.0.1:${GATEWAY_PORT}\$uri?\$ocw_proxy_args;
        proxy_set_header Authorization "Bearer ${GATEWAY_TOKEN}";

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
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

    # Gateway crash log — auth-protected diagnostic endpoint
    location = /gateway.log {
        ${AUTH_BLOCK}
        alias ${STATE_DIR}/gateway.log;
        default_type text/plain;
        add_header Cache-Control no-store;
    }

    # Browser sidecar proxy (VNC web UI)
    location /browser/ {
        ${AUTH_BLOCK}

        proxy_pass http://browser:3000/;
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

# ── ClawdTalk voice/SMS integration ─────────────────────────────────────────
if [ -n "${CLAWDTALK_API_KEY:-}" ]; then
  CLAWDTALK_DIR="$STATE_DIR/skills/clawdtalk-client"
  mkdir -p "$CLAWDTALK_DIR"

  # Download skill on first run (or if ws-client.js is missing)
  if [ ! -f "$CLAWDTALK_DIR/ws-client.js" ]; then
    echo "[entrypoint] downloading clawdtalk-client skill..."
    curl -sL https://github.com/team-telnyx/clawdtalk-client/archive/refs/heads/main.tar.gz \
      | tar -xz --strip-components=1 -C "$CLAWDTALK_DIR"
  fi

  # Write skill-config.json into scripts/ (where ws-client.js lives)
  mkdir -p "$CLAWDTALK_DIR/scripts"
  printf '{\n  "api_key": "%s",\n  "server": "https://clawdtalk.com",\n  "gateway_url": "http://127.0.0.1:%s",\n  "gateway_token": "%s",\n  "agent_id": "main"\n}\n' \
    "$CLAWDTALK_API_KEY" "$GATEWAY_PORT" "$GATEWAY_TOKEN" \
    > "$CLAWDTALK_DIR/scripts/skill-config.json"
  chmod 600 "$CLAWDTALK_DIR/scripts/skill-config.json"

  # Install Node.js dependencies (package.json is at repo root)
  if [ -f "$CLAWDTALK_DIR/package.json" ] && [ ! -d "$CLAWDTALK_DIR/node_modules/ws" ]; then
    echo "[entrypoint] installing ClawdTalk dependencies..."
    npm install --production --prefix "$CLAWDTALK_DIR" 2>&1 | tail -3
  fi

  # Start WebSocket client in background
  # ws-client.js lives in scripts/ and reads skill-config.json from its own dir
  echo "[entrypoint] starting ClawdTalk WebSocket client..."
  cd "$CLAWDTALK_DIR/scripts"
  nohup node ws-client.js >> "$STATE_DIR/clawdtalk.log" 2>&1 &
  echo "[entrypoint] ClawdTalk started (pid: $!, log: $STATE_DIR/clawdtalk.log)"
  cd /opt/openclaw/app
fi

# ── Start nginx ──────────────────────────────────────────────────────────────
echo "[entrypoint] starting nginx on port ${PORT:-8080}..."
nginx

# ── Clean up stale lock files ────────────────────────────────────────────────
rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$STATE_DIR/gateway.lock" 2>/dev/null || true

# ── Remove cached auth for providers that are no longer configured ────────────
# This prevents unconfigured providers (e.g. github-copilot, opencode) from
# appearing in the model picker or causing "No API key" errors.
AUTH_PROFILES="$STATE_DIR/agents/main/agent/auth-profiles.json"
if [ -f "$AUTH_PROFILES" ]; then
  node -e "
    const fs = require('fs');
    const file = process.argv[1];
    try {
      const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
      const toRemove = [];
      if (!process.env.COPILOT_GITHUB_TOKEN && profiles['github-copilot'])
        toRemove.push('github-copilot');
      if (!process.env.OPENCODE_API_KEY && !process.env.OPENCODE_ZEN_API_KEY && profiles['opencode'])
        toRemove.push('opencode');
      if (toRemove.length > 0) {
        toRemove.forEach(k => delete profiles[k]);
        fs.writeFileSync(file, JSON.stringify(profiles, null, 2));
        console.log('[entrypoint] removed unconfigured providers from auth-profiles:', toRemove.join(', '));
      }
    } catch (e) {
      console.log('[entrypoint] could not clean auth-profiles:', e.message);
    }
  " "$AUTH_PROFILES"
fi

# ── Start openclaw gateway (with crash recovery) ─────────────────────────────
# If the gateway crashes within FAST_CRASH_WINDOW seconds it's almost certainly
# a bad config field rather than a transient error. We progressively strip the
# most fragile config sections and retry rather than letting Docker see a rapid
# exit-restart loop (which would spin 200+ times with the same broken config).
#
# Healing sequence on consecutive fast crashes:
#   crash 1 → strip agents.defaults.model.list
#   crash 2 → strip all of agents.defaults.model
#   crash 3 → strip entire agents.defaults block
#   crash 4 → strip channels (channel configs are the most common crash source)
#   crash 5 → strip browser + hooks + tools
#   crash 6 → strip models.providers + bedrockDiscovery (custom provider entries)
#   crash 7+ → write truly minimal gateway-only config, wait 60s, reset counter
#
# Note: do NOT use exec — the gateway receives SIGHUP as PID 1 from Docker's
# init system and exits unexpectedly. Run as a child of the shell instead.

FAST_CRASH_WINDOW=20   # seconds — crashes faster than this are config crashes
OCW_CONF="$STATE_DIR/openclaw.json"
fast_crashes=0

_strip_conf() {
  local level=$1
  node -e "
    const fs = require('fs');
    try {
      const c = JSON.parse(fs.readFileSync('$OCW_CONF', 'utf8'));
      const lvl = parseInt(process.argv[1]);
      // Level 1-3: agents config (most common crash: bad model fields)
      if (lvl >= 1 && c.agents && c.agents.defaults && c.agents.defaults.model)
        delete c.agents.defaults.model.list;
      if (lvl >= 2 && c.agents && c.agents.defaults)
        delete c.agents.defaults.model;
      if (lvl >= 3 && c.agents)
        delete c.agents.defaults;
      // Level 4: channels (channel configs with bad tokens/options crash gateway)
      if (lvl >= 4)
        delete c.channels;
      // Level 5: browser + hooks + tools
      if (lvl >= 5) {
        delete c.browser;
        delete c.hooks;
        delete c.tools;
      }
      // Level 6: custom provider configs (bad baseUrl/models entries crash gateway)
      if (lvl >= 6 && c.models) {
        delete c.models.providers;
        delete c.models.bedrockDiscovery;
      }
      fs.writeFileSync('$OCW_CONF', JSON.stringify(c, null, 2));
      console.log('[entrypoint] config stripped at level ' + lvl);
    } catch(e) {
      console.log('[entrypoint] config strip failed: ' + e.message);
    }
  " "$level" || true
}

_write_minimal_conf() {
  # Write a bare-minimum config guaranteed to start the gateway.
  # Used as last resort before resetting the crash counter.
  local primary=""
  for pair in \
    "ANTHROPIC_API_KEY:anthropic/claude-opus-4-5-20251101" \
    "OPENAI_API_KEY:openai/gpt-5.2" \
    "OPENROUTER_API_KEY:openrouter/anthropic/claude-opus-4-5" \
    "GEMINI_API_KEY:google/gemini-2.5-pro" \
    "XAI_API_KEY:xai/grok-3" \
    "GROQ_API_KEY:groq/llama-3.3-70b-versatile"; do
    local envkey="${pair%%:*}"
    local model="${pair##*:}"
    if [ -n "${!envkey:-}" ]; then
      primary="$model"
      break
    fi
  done
  [ -z "$primary" ] && primary="anthropic/claude-opus-4-5-20251101"

  node -e "
    const fs = require('fs');
    const conf = {
      gateway: {
        port: parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789'),
        mode: 'local',
        auth: { mode: 'token', token: process.env.OPENCLAW_GATEWAY_TOKEN || '' },
        bind: 'loopback',
        controlUi: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: true, enabled: true }
      },
      agents: {
        defaults: {
          workspace: process.env.OPENCLAW_WORKSPACE_DIR || '/data/workspace',
          model: { primary: process.argv[1] }
        }
      }
    };
    fs.writeFileSync(process.argv[2], JSON.stringify(conf, null, 2));
    console.log('[entrypoint] wrote minimal config (primary: ' + process.argv[1] + ')');
  " "$primary" "$OCW_CONF" || true
}

echo "[entrypoint] starting openclaw gateway on port $GATEWAY_PORT..."
cd /opt/openclaw/app

# Log file for gateway crash output — viewable at /data/.openclaw/gateway.log
GATEWAY_LOG="$STATE_DIR/gateway.log"
# Rotate: keep last 5000 lines across restarts
_rotate_log() {
  if [ -f "$GATEWAY_LOG" ]; then
    local lines
    lines=$(wc -l < "$GATEWAY_LOG" 2>/dev/null || echo 0)
    if [ "$lines" -gt 5000 ]; then
      tail -n 2500 "$GATEWAY_LOG" > "${GATEWAY_LOG}.tmp" && mv "${GATEWAY_LOG}.tmp" "$GATEWAY_LOG"
    fi
  fi
}

while true; do
  _rotate_log
  _start=$(date +%s)
  echo "--- gateway start $(date -u '+%Y-%m-%dT%H:%M:%SZ') ---" >> "$GATEWAY_LOG"
  openclaw gateway run >> "$GATEWAY_LOG" 2>&1
  _code=$?
  _elapsed=$(( $(date +%s) - _start ))

  if [ $_elapsed -lt $FAST_CRASH_WINDOW ]; then
    fast_crashes=$(( fast_crashes + 1 ))
    echo "[entrypoint] gateway fast crash #${fast_crashes} after ${_elapsed}s (exit ${_code})"

    if [ $fast_crashes -le 6 ]; then
      echo "[entrypoint] stripping config (level ${fast_crashes}) and retrying..."
      _strip_conf "$fast_crashes"
      sleep 2
    else
      echo "[entrypoint] all strip levels exhausted — writing minimal config, waiting 60s..."
      _write_minimal_conf
      sleep 60
      fast_crashes=0
    fi
  else
    # Gateway ran for a reasonable time; reset the fast-crash counter.
    echo "[entrypoint] gateway exited after ${_elapsed}s (exit ${_code}), restarting..."
    fast_crashes=0
    sleep 2
  fi
done
