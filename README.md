# Openclaw Automated Build

## Quick Start

### Minimal (`docker run`)

```bash
docker run -d \
  --name openclaw \
  -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e AUTH_PASSWORD=changeme \
  -e OPENCLAW_GATEWAY_TOKEN=my-secret-token \
  -e OPENCLAW_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000 \
  -v openclaw-data:/data \
  coollabsio/openclaw:latest
```

- `ANTHROPIC_API_KEY` — any [supported provider key](#ai-providers-at-least-one-required) works (OpenAI, Gemini, etc.)
- `AUTH_PASSWORD` — protects the web UI with HTTP basic auth (user defaults to `admin`, override with `AUTH_USERNAME`)
- `OPENCLAW_GATEWAY_TOKEN` — internal API token; auto-generated if omitted, but set it explicitly for stable API access
- `OPENCLAW_ALLOWED_ORIGINS` — **(Required)** Set to `http://localhost:5173` or your frontend origin to enable CORS for the Control UI
- `/data` — persists state, config, and workspace across restarts

### Full Setup (docker-compose)

Includes persistent storage, browser sidecar (CDP + VNC), and webhook hooks. See [`docker-compose.yml`](docker-compose.yml).

```bash
docker compose up -d
```

**After starting:**

1. **Openclaw UI** — `http://localhost:8080` (login: your `AUTH_USERNAME` / `AUTH_PASSWORD`)
2. **Browser desktop** — `http://localhost:8080/browser/` (login: your `AUTH_USERNAME` / `AUTH_PASSWORD`) — use this to log into sites that need auth (OAuth, 2FA, captchas). Openclaw reuses the session via CDP at `http://browser:9223` (see [Browser tool](#browser-tool-remote-cdp-sidecar-optional)). The route stays behind basic auth. It proxies to the `browser` sidecar on port 3000 when that host exists. Without the sidecar, nginx still starts and `/browser/` returns 502. Do not publish container ports 9222 or 9223. Startup allowlists the hostname `browser` for SSRF and leaves every other private address blocked.

### First login and device approval (OpenClaw 2026.10.5+)

Each browser profile has to be approved once before the Control UI will connect.

1. Sign in with HTTP basic auth (`AUTH_USERNAME` / `AUTH_PASSWORD`).
2. Enter the gateway WebSocket URL and `OPENCLAW_GATEWAY_TOKEN`, then choose **Connect**. On Coolify the URL is the application's `wss://` address (same host as the Control UI, `wss` when the site is served over HTTPS).
3. The page shows **Approve this browser** and a request id.
4. In the container terminal, list pending requests and approve that id. A Coolify terminal and `docker exec` already have `OPENCLAW_GATEWAY_TOKEN`. Leave `OPENCLAW_GATEWAY_URL` unset and do not pass `--url`. The CLI then uses the loopback gateway at `ws://127.0.0.1:18789` (the process nginx proxies to). `HOME` can stay `/root`; the token in the environment is enough. `HOME=/data` also works, because that reads `/data/.openclaw/openclaw.json`.

   ```bash
   openclaw devices list
   openclaw devices approve <requestId>
   ```

   `openclaw devices approve` with no id only prints a preview and exits 1. Pass the request id from the page (or from `openclaw devices list`).

5. Approval is stored for that browser profile. The page connects on its own (or use **Check now**). A different profile, or a browser that has cleared site data, needs the same steps again.

#### `scope upgrade pending approval` / pairing dead end

On `coollabsio/openclaw:2026.5.7` the browser could show `device pairing required (requestId: …)` while `openclaw devices approve` inside the container failed with:

```text
gateway connect failed: GatewayClientRequestError: scope upgrade pending approval (requestId: …)
```

That CLI was connecting as its own device and requesting operator scopes that device did not have yet, so the same command could not approve the browser or itself.

OpenClaw 2026.10.5 does not do that on the loopback gateway when `OPENCLAW_GATEWAY_TOKEN` is set. The commands above approve the browser request. Verified on an image built from this repo against OpenClaw 2026.10.5: basic auth, gateway token, **Approve this browser**, then `openclaw devices list` and `openclaw devices approve <requestId>` from `docker exec` (default `HOME=/root`, no `--url`). The Control UI then reaches Home. No `scope upgrade pending approval`, and no `401` with `WWW-Authenticate: Basic` after the page loaded.

If approval still fails, match the message:

| What you see | What to run |
|---|---|
| `openclaw devices approve` with no id prints the pending request and exits 1 | Rerun with the request id from that preview or from the browser. |
| `gateway rejected websocket upgrade (HTTP 401)` | The CLI is aimed at nginx (`:8080` or the public Coolify `wss://` URL). Basic auth rejects it before the gateway. Unset `OPENCLAW_GATEWAY_URL`, drop `--url`, and rerun so the target stays `ws://127.0.0.1:18789`. `gateway.trustedProxies` is for browser traffic through nginx; it does not apply to this direct loopback connection. |
| `gateway device.pair.list requires credentials` or `gateway url override requires explicit credentials` | Pass the container's `OPENCLAW_GATEWAY_TOKEN` with `--token` when you also pass `--url`. With no `--url`, the env token is used. If the token env var is missing, `HOME=/data` lets the CLI read the token from `/data/.openclaw/openclaw.json`. |
| `This device can't approve its own scope upgrade` or `scope upgrade pending approval` | The CLI authenticated as a paired device and asked for scopes that device does not have. Approve the **browser** request id from `openclaw devices list` on the loopback gateway with `OPENCLAW_GATEWAY_TOKEN` set and no `--url`. The CLI cannot approve its own pending scope upgrade. |

## Architecture

```
┌─────────────────────────────────────────────┐
│  Docker container (coollabsio/openclaw)     │
│                                             │
│  Baked in: Linuxbrew, Go, uv, build-essential│
│  Persistent volume: /data                   │
│    ├── .openclaw/      (state & config)     │
│    └── workspace/      (user projects)      │
│                                             │
│  ┌──────────┐  :8080   ┌────────────────┐  │
│  │  nginx    │ ──────→  │  openclaw      │  │
│  │  (basic   │  proxy   │  gateway       │  │
│  │   auth)   │  :18789  │  :18789        │  │
│  └──────────┘          └────────────────┘  │
│                                             │
│  entrypoint.sh                              │
│    1. run custom init script (optional)     │
│    2. configure.js (env vars → json)        │
│    3. openclaw doctor --fix (every start)   │
│    4. nginx (background)                    │
│    5. exec openclaw gateway                 │
└─────────────────────────────────────────────┘
```

Two-layer Docker build:
1. **Base image** (`Dockerfile.base`) — builds openclaw from source. Tagged `coollabsio/openclaw-base:<version>`.
2. **Final image** (`Dockerfile`) — FROM base, adds nginx + env-to-config scripts. Tagged `coollabsio/openclaw:<version>`.

## Files

```
.github/workflows/auto-update.yml   — cron hourly, check openclaw releases, build+push
.github/workflows/build.yml         — CI on push/PR; builds the latest upstream release (no push)
Dockerfile.base                     — multi-stage: build openclaw from source → slim runtime
Dockerfile                          — FROM base, add nginx + config scripts + entrypoint
scripts/configure.js                — reads env vars, writes/patches openclaw.json
scripts/entrypoint.sh               — container entrypoint: configure → nginx → gateway
scripts/smoke.js                    — smoke test (openclaw --version)
nginx/default.conf                  — reverse proxy :8080 → :18789, optional basic auth
.dockerignore                       — standard ignores
.env.example                        — env var reference
```

## auto-update.yml workflow

```
Jobs:
1. check-release        — fetch latest openclaw/openclaw release, skip if image exists
2. build-base           — matrix amd64/arm64, build Dockerfile.base, push per-arch
3. merge-base-manifest  — merge into coollabsio/openclaw-base:<ver> + :latest
4. build-final          — matrix amd64/arm64, build Dockerfile, push per-arch
5. merge-final-manifest — merge into coollabsio/openclaw:<ver> + :latest
```

Triggers: `schedule: '0 * * * *'` (hourly) + `workflow_dispatch` (version, force_rebuild, skip_latest_tag).

## Secrets needed (repo settings)

- `DOCKERHUB_USERNAME` — Docker Hub username
- `DOCKERHUB_TOKEN` — Docker Hub access token
- `GITHUB_TOKEN` — auto-provided by GitHub Actions

## Environment variables

### AI Providers (at least one required)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key. Configures Claude models (Opus 4.5, Sonnet 4.5, Haiku 4.5). Set as primary when present. |
| `OPENAI_API_KEY` | OpenAI API key. Configures GPT models (5.2, 5, 4.5-preview). Primary if no Anthropic key. |
| `OPENROUTER_API_KEY` | OpenRouter API key. Primary if no Anthropic/OpenAI key. |
| `GEMINI_API_KEY` | Google Gemini API key. Primary if no other provider key set. |
| `XAI_API_KEY` | xAI API key. Configures Grok models. |
| `GROQ_API_KEY` | Groq API key. Configures Llama models on Groq hardware. |
| `MISTRAL_API_KEY` | Mistral API key. Configures Mistral Large and other models. |
| `CEREBRAS_API_KEY` | Cerebras API key. Configures Llama models on Cerebras hardware. |
| `VENICE_API_KEY` | Venice AI API key (OpenAI-compatible). Configures Llama 3.3 70B. |
| `MOONSHOT_API_KEY` | Moonshot API key (OpenAI-compatible). Configures Kimi K2.5. |
| `KIMI_API_KEY` | Kimi Coding API key (Anthropic-compatible). Configures K2P5. |
| `MINIMAX_API_KEY` | MiniMax API key (Anthropic-compatible). Configures MiniMax M3 (default), M2.7, and M2.1. |
| `ZAI_API_KEY` | ZAI API key. Configures GLM models. |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway API key. |
| `OPENCODE_API_KEY` | OpenCode API key. Also accepted as `OPENCODE_ZEN_API_KEY`. |
| `SYNTHETIC_API_KEY` | Synthetic API key (Anthropic-compatible). |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot token. Configures Claude models via GitHub. |
| `XIAOMI_API_KEY` | Xiaomi MiMo API key (Anthropic-compatible). Configures MiMo v2 Flash. |

Multiple providers can be set simultaneously. Priority for primary model: Anthropic > OpenAI > OpenRouter > Gemini > OpenCode > GitHub Copilot > xAI > Groq > Mistral > Cerebras > Venice > Moonshot > Kimi > MiniMax > Synthetic > ZAI > AI Gateway > Xiaomi > Bedrock > Ollama > OpenAI-Compatible.

If a provider env var is removed, that provider section is cleaned from `openclaw.json` on next start.

### Deepgram (audio transcription, optional)

| Variable | Description |
|---|---|
| `DEEPGRAM_API_KEY` | Deepgram API key. Enables audio transcription via Nova 3 model. |

### Amazon Bedrock (uses AWS credential chain)

| Variable | Default | Description |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | | AWS access key. Both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` required. |
| `AWS_SECRET_ACCESS_KEY` | | AWS secret key. |
| `AWS_REGION` | `us-east-1` | AWS region for Bedrock runtime endpoint. |
| `AWS_SESSION_TOKEN` | | Optional session token for temporary credentials. |
| `BEDROCK_PROVIDER_FILTER` | `["anthropic"]` | Filter Bedrock model discovery by provider (JSON array or comma-separated string). |

### Ollama (local models, no API key needed)

| Variable | Description |
|---|---|
| `OLLAMA_BASE_URL` | Ollama server URL (e.g. `http://host.docker.internal:11434`). Enables the Ollama provider when set. `/v1` is appended if missing. When an Ollama provider is already configured, only `baseUrl` is updated. |

Custom models belong in the mounted JSON file as `models.providers.ollama.models`. That list wins over a default `llama3.3` catalog saved by an older run. If no primary model is set, Ollama's automatic primary is the first model in the list. A saved primary of exactly `ollama/llama3.3` is moved to that first model when `llama3.3` is no longer configured. Set `OPENCLAW_PRIMARY_MODEL` to choose a different one. Restart the container after upgrading; no hand edit is required when the custom JSON defines the model list.

### OpenAI-compatible endpoint (LiteLLM, vLLM, LM Studio, LocalAI)

Any server that speaks the OpenAI chat-completions API. The provider id written to `openclaw.json` is `openai-compatible`.

| Variable | Required | Description |
|---|---|---|
| `OPENAI_COMPATIBLE_BASE_URL` | yes | Base URL, for example `http://host.docker.internal:4000/v1`. Trailing slashes are stripped. There is no default — a missing URL does not fall back to `https://api.openai.com/v1`. |
| `OPENAI_COMPATIBLE_MODEL` | yes | Model id, for example `my-model`. There is no default. Auto-selected primary model is `openai-compatible/<model>`. |
| `OPENAI_COMPATIBLE_API_KEY` | no | API key when the server requires one. Omit it for local servers without auth (LM Studio, local vLLM). OpenClaw accepts a missing key when the base URL is loopback, a private LAN address, `*.local`, `host.docker.internal`, or a bare hostname. Public endpoints need a real key. |

Both `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_MODEL` must be set. If either is missing, the provider is skipped and a warning is logged. The API key value is never written to the log.

If a mounted custom JSON already defines `models.providers["openai-compatible"]`, these variables update `baseUrl`, set `apiKey` only when `OPENAI_COMPATIBLE_API_KEY` is present, and add `OPENAI_COMPATIBLE_MODEL` to `models` when that id is not already listed. Other models and provider fields (for example `api`, `timeoutSeconds`, headers) stay in place.

### Model selection

| Variable | Description |
|---|---|
| `OPENCLAW_PRIMARY_MODEL` | Override auto-selected primary model. Format: `provider/model-id` (e.g. `anthropic/claude-sonnet-4-5-20250929`). |

### HTTP Basic Auth (recommended)

| Variable | Default | Description |
|---|---|---|
| `AUTH_PASSWORD` | *(none)* | If set, nginx enforces HTTP basic auth on all routes except `/healthz`, the hooks path (when hooks are enabled), and `Authorization: Bearer` requests to the Control UI routes the gateway itself token-checks. If unset, the generated nginx config is unchanged and no auth is required. |
| `AUTH_USERNAME` | `admin` | Username for basic auth. |

When `AUTH_PASSWORD` is set, the Control UI's own `Authorization: Bearer` fetches (device token, gateway token, or password) would otherwise replace the browser's Basic credentials and make nginx re-prompt. nginx skips basic auth only for those exact paths, forwards the client's `Authorization` header, and does not append its own `token=` query parameter. `/`, the WebSocket, and `/browser/` stay on basic auth. An invalid or empty Bearer token is rejected by the gateway.

### Gateway

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | *(auto-generated)* | Bearer token for gateway auth. Auto-generated and persisted to `<STATE_DIR>/gateway.token` if not set. |
| `OPENCLAW_GATEWAY_PORT` | `18789` | Internal port the gateway binds to. |
| `OPENCLAW_GATEWAY_BIND` | `loopback` | Gateway bind mode. `loopback` = 127.0.0.1 only (nginx proxies LAN traffic). `lan` = 0.0.0.0 (direct access, bypasses nginx auth). Also: `tailnet`, `auto`, `custom`. |

`configure.js` sets `gateway.trustedProxies` to `127.0.0.1` and `::1` when the key is not already in the config. nginx overwrites `X-Forwarded-For` with the connecting client when basic auth is on, so OpenClaw's auth rate limit sees that client instead of treating everyone as loopback (which is exempt from lockout). This does not enable trusted-proxy authentication; `gateway.auth.mode` stays `token`. Set your own `gateway.trustedProxies` in custom JSON to override. With Docker port publishing, that client is often the bridge address shared by every visitor, and current OpenClaw builds may ask for a one-time device pairing for a non-loopback address.
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | Persistent state directory. Mount a volume here. |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | Workspace directory for openclaw projects. |
| `OPENCLAW_CONFIG_PATH` | `<STATE_DIR>/openclaw.json` | Override path to the config file. |
| `OPENCLAW_CUSTOM_CONFIG` | `/app/config/openclaw.json` | Path to a user-provided custom JSON config. Env vars override on top. |

### CORS / Allowed Origins (optional)

Configure Cross-Origin Resource Sharing for the Control UI. Required when accessing the gateway from a different origin (e.g., a custom web app or local dev server).

| Variable | Description |
|---|---|
| `OPENCLAW_ALLOWED_ORIGINS` | Comma-separated list or JSON array of allowed origins. Example: `http://localhost:5173,https://app.example.com` or `["http://localhost:5173"]`. |

On Coolify, the application domain is added automatically. `COOLIFY_URL` is
preferred when Coolify sets it, because that variable carries the real
`http://` or `https://` scheme; otherwise `COOLIFY_FQDN` is used and a bare
hostname becomes `https://` (for example, `app.example.com` becomes
`https://app.example.com`). Several domains are comma-separated
(`a.example.com,b.example.com` or `https://a.example.com,http://b.example.com`).
Each entry is normalized to the browser origin: lowercase host, no path, and
default ports such as `:443` removed. Values in `OPENCLAW_ALLOWED_ORIGINS`
are kept as written and are not duplicated.

```bash
# Allow specific origins
OPENCLAW_ALLOWED_ORIGINS=http://localhost:5173,https://app.example.com

# Or as JSON array
OPENCLAW_ALLOWED_ORIGINS='["http://localhost:5173","https://app.example.com"]'
```

### Hooks (webhook automation, optional)

| Variable | Default | Description |
|---|---|---|
| `HOOKS_ENABLED` | | Set to `true` to enable the webhook hooks endpoint. |
| `HOOKS_TOKEN` | | Shared secret for hook request auth. Required by openclaw when hooks are enabled. |
| `HOOKS_PATH` | `/hooks` | Path prefix for hook endpoints (`/hooks/wake`, `/hooks/agent`, etc.). |

When hooks are enabled and `AUTH_PASSWORD` is set, the hooks path automatically bypasses HTTP basic auth. Openclaw validates requests using the hook token instead. Docs: https://docs.openclaw.ai/automation/webhook

### Browser tool (remote CDP sidecar, optional)

| Variable | Default | Description |
|---|---|---|
| `BROWSER_CDP_URL` | | Remote CDP URL. The compose file sets `http://browser:9223`. Required to activate the browser tool. |
| `BROWSER_EVALUATE_ENABLED` | `false` | Allow JavaScript evaluation in page context via browser actions. |
| `BROWSER_SNAPSHOT_MODE` | | Default snapshot mode (e.g. `efficient`). |
| `BROWSER_REMOTE_TIMEOUT_MS` | `1500` | HTTP timeout in ms for remote CDP connection. |
| `BROWSER_REMOTE_HANDSHAKE_TIMEOUT_MS` | `3000` | WebSocket handshake timeout in ms for remote CDP. |
| `BROWSER_DEFAULT_PROFILE` | | Override the default browser profile name. |
| `BROWSER_SSRF_ALLOW_COMPOSE_SIDECAR` | | Set to `false` or `0` to skip the automatic `browser` hostname allowance. Any other value, including unset, leaves that allowance on when the CDP hostname is exactly `browser`. |

[`docker-compose.yml`](docker-compose.yml) runs `coollabsio/openclaw-browser` on the same compose network. Docs: https://docs.openclaw.ai/tools/browser

| What | Where |
|---|---|
| Desktop UI | `http://<host>:8080/browser/` (HTTP basic auth). OpenClaw's nginx proxies to the sidecar UI on container port 3000. |
| CDP | `http://browser:9223` on the compose network. Do not publish container ports 9222 or 9223. |

Chromium ignores `--remote-debugging-address` and binds DevTools to `127.0.0.1:9222` ([#45](https://github.com/coollabsio/openclaw/issues/45)). A second nginx on 9223 does not stay up: Selkies' `svc-nginx` kills every nginx it finds, and both masters use `/run/nginx.pid`. The image adds a server to that existing nginx instead. It listens on `0.0.0.0:9223` and proxies to `127.0.0.1:9222`, with `Host: localhost:9222` and an empty `Origin`. Chrome 111+ otherwise answers `403` to the websocket handshake OpenClaw sends (`Origin: http://browser:9223`). The image also passes `--remote-debugging-port=9222` and `--remote-allow-origins=*`. `CHROME_CLI` is appended and can still override those flags; the compose file sets the same pair.

Publishing `9223:9223` would listen on every host interface. Leave CDP off the public internet. A temporary debug mapping, if you need one, is `127.0.0.1:9223:9223`.

#### Compose sidecar and SSRF

OpenClaw blocks remote CDP to private addresses unless that hostname is allowlisted ([#64](https://github.com/coollabsio/openclaw/issues/64), [#68](https://github.com/coollabsio/openclaw/issues/68)). The Compose and Coolify service name is `browser`, and that name resolves to a private container address, so `BROWSER_CDP_URL=http://browser:9223` fails in a few milliseconds with `Remote CDP for profile "openclaw" is not reachable` before any request reaches the sidecar.

When the effective CDP URL uses the hostname `browser` — top-level `browser.cdpUrl`, or a profile `cdpUrl` — `configure.js` adds that exact name to `browser.ssrfPolicy.allowedHostnames` after the JSON and dot-notation merge. The value is a real array of strings. That is the shape OpenClaw's strict schema keeps across `openclaw doctor --fix`. `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` is left unset.

The allowance is that one hostname. Other Docker service names, raw private IPs, `.local` and `.internal` names, and `host.docker.internal` are left unchanged. Link-local and cloud metadata addresses, including `169.254.169.254`, stay blocked even when `browser` is allowed: an exact hostname allowance does not trust those DNS answers.

`BROWSER_SSRF_ALLOW_COMPOSE_SIDECAR=false` (or `0`) skips the automatic hostname. A hostname already saved in `openclaw.json` is not removed when the CDP URL changes or the skip is turned on; delete the `browser` entry from the persisted file or from custom JSON to drop it. A hostname listed in `blockedHostnames` is not re-allowed.

To allow one different private hostname, pass a real array. The `[]` suffix is required; a JSON-looking string without it is not an array:

```bash
OPENCLAW__browser__ssrfPolicy__allowedHostnames[]=my-browser
```

Hostnames set this way are kept, and `browser` is still added when the CDP URL uses it. The broad private-network flag allows every private address. Set it only as a deliberate opt-in:

```bash
OPENCLAW__browser__ssrfPolicy__dangerouslyAllowPrivateNetwork=true
```

#### Browser login

Open `http://localhost:8080/browser/`, sign in with `AUTH_USERNAME` / `AUTH_PASSWORD`, then sign in to the site in the desktop (captchas, 2FA, OAuth). OpenClaw reuses that Chromium session over CDP. The compose file mounts `browser-data` at `/config`, so cookies and the profile survive restarts. `BROWSER_CDP_URL=http://browser:9223` is already set on the `openclaw` service.

`kasmweb/chrome` is a different sidecar (desktop on `:6901`). Its CDP port and flags are not the ones in this compose file. Docs: https://docs.openclaw.ai/tools/browser-login

### Channels (optional)

> **Note:** Use these dedicated env vars for standard channel configuration. For settings not covered here, use [Dot-Notation Config](#dot-notation-config-openclaw__) as a fallback.

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | | Telegram bot token from BotFather. |
| `TELEGRAM_DM_POLICY` | `pairing` | DM access policy: `pairing`, `allowlist`, `open`, or `disabled`. |
| `TELEGRAM_ALLOW_FROM` | | Comma-separated allowlist of user IDs/usernames. Required when `dmPolicy=allowlist` or `dmPolicy=open` (use `*`). |
| `TELEGRAM_GROUP_POLICY` | `allowlist` | Group access policy: `open`, `allowlist`, or `disabled`. |
| `TELEGRAM_GROUP_ALLOW_FROM` | | Comma-separated group sender allowlist (user IDs/usernames). |
| `TELEGRAM_REPLY_TO_MODE` | `first` | Reply threading: `off`, `first`, or `all`. |
| `TELEGRAM_CHUNK_MODE` | `length` | Outbound split mode: `length` or `newline` (paragraph boundaries). |
| `TELEGRAM_TEXT_CHUNK_LIMIT` | `4000` | Outbound text chunk size (chars). |
| `TELEGRAM_STREAM_MODE` | `partial` | Draft streaming: `off`, `partial`, or `block`. |
| `TELEGRAM_LINK_PREVIEW` | `true` | Toggle link previews for outbound messages. |
| `TELEGRAM_MEDIA_MAX_MB` | `5` | Inbound/outbound media cap in MB. |
| `TELEGRAM_REACTION_NOTIFICATIONS` | `own` | Which reactions trigger events: `off`, `own`, or `all`. |
| `TELEGRAM_REACTION_LEVEL` | `minimal` | Agent reaction capability: `off`, `ack`, `minimal`, or `extensive`. |
| `TELEGRAM_INLINE_BUTTONS` | `allowlist` | Inline button capability: `off`, `dm`, `group`, `all`, or `allowlist`. |
| `TELEGRAM_ACTIONS_REACTIONS` | `true` | Gate Telegram tool reactions. |
| `TELEGRAM_ACTIONS_STICKER` | `false` | Gate Telegram sticker send/search actions. |
| `TELEGRAM_PROXY` | | Proxy URL for Bot API calls (SOCKS/HTTP). |
| `TELEGRAM_WEBHOOK_URL` | | Enable webhook mode with public endpoint URL. |
| `TELEGRAM_WEBHOOK_SECRET` | | Webhook secret (optional). |
| `TELEGRAM_WEBHOOK_PATH` | `/telegram-webhook` | Local webhook path for incoming updates. |
| `TELEGRAM_MESSAGE_PREFIX` | | Prefix prepended to inbound messages. |
| `DISCORD_BOT_TOKEN` | | Discord bot token. Enable MESSAGE CONTENT INTENT in Discord Developer Portal. |
| `DISCORD_DM_POLICY` | `pairing` | DM access policy: `pairing`, `allowlist`, `open`, or `disabled`. |
| `DISCORD_DM_ALLOW_FROM` | | Comma-separated user IDs/names for DM allowlist. |
| `DISCORD_GROUP_POLICY` | `allowlist` | Guild access policy: `open`, `allowlist`, or `disabled`. |
| `DISCORD_REPLY_TO_MODE` | `off` | Reply threading: `off`, `first`, or `all`. |
| `DISCORD_CHUNK_MODE` | `length` | Outbound split mode: `length` or `newline`. |
| `DISCORD_TEXT_CHUNK_LIMIT` | `2000` | Outbound text chunk size (chars). |
| `DISCORD_MAX_LINES_PER_MESSAGE` | `17` | Soft line limit per message. |
| `DISCORD_MEDIA_MAX_MB` | `8` | Inbound media cap in MB. |
| `DISCORD_HISTORY_LIMIT` | `20` | Recent guild messages for context. |
| `DISCORD_DM_HISTORY_LIMIT` | | DM history limit per user. |
| `DISCORD_REACTION_NOTIFICATIONS` | `own` | Which reactions trigger events: `off`, `own`, `all`, or `allowlist`. |
| `DISCORD_ALLOW_BOTS` | `false` | Process messages from other bots. |
| `DISCORD_MESSAGE_PREFIX` | | Prefix prepended to inbound messages. |
| `DISCORD_ACTIONS_REACTIONS` | `true` | Gate reaction actions. |
| `DISCORD_ACTIONS_STICKERS` | `true` | Gate sticker send. |
| `DISCORD_ACTIONS_EMOJI_UPLOADS` | `true` | Gate emoji uploads. |
| `DISCORD_ACTIONS_STICKER_UPLOADS` | `true` | Gate sticker uploads. |
| `DISCORD_ACTIONS_POLLS` | `true` | Gate poll creation. |
| `DISCORD_ACTIONS_PERMISSIONS` | `true` | Gate channel permission edits. |
| `DISCORD_ACTIONS_MESSAGES` | `true` | Gate message read/send/edit/delete. |
| `DISCORD_ACTIONS_THREADS` | `true` | Gate thread operations. |
| `DISCORD_ACTIONS_PINS` | `true` | Gate pin/unpin operations. |
| `DISCORD_ACTIONS_SEARCH` | `true` | Gate message search. |
| `DISCORD_ACTIONS_MEMBER_INFO` | `true` | Gate member lookup. |
| `DISCORD_ACTIONS_ROLE_INFO` | `true` | Gate role list. |
| `DISCORD_ACTIONS_CHANNEL_INFO` | `true` | Gate channel info. |
| `DISCORD_ACTIONS_CHANNELS` | `true` | Gate channel management. |
| `DISCORD_ACTIONS_VOICE_STATUS` | `true` | Gate voice state. |
| `DISCORD_ACTIONS_EVENTS` | `true` | Gate event management. |
| `DISCORD_ACTIONS_ROLES` | `false` | Gate role add/remove. |
| `DISCORD_ACTIONS_MODERATION` | `false` | Gate timeout/kick/ban. |
| `SLACK_BOT_TOKEN` | | Slack bot token (`xoxb-...`). Both bot + app token required for Slack. |
| `SLACK_APP_TOKEN` | | Slack app token (`xapp-...`). |
| `SLACK_USER_TOKEN` | | Slack user token (`xoxp-...`). Optional, for user-level API calls. |
| `SLACK_SIGNING_SECRET` | | Signing secret for HTTP mode verification. |
| `SLACK_MODE` | `socket` | Connection mode: `socket` or `http`. |
| `SLACK_WEBHOOK_PATH` | `/slack/events` | Webhook path for HTTP mode. |
| `SLACK_DM_POLICY` | `pairing` | DM access policy: `pairing` or `open`. |
| `SLACK_DM_ALLOW_FROM` | | Comma-separated user IDs/handles for DM allowlist. |
| `SLACK_GROUP_POLICY` | `open` | Channel access policy: `open`, `allowlist`, or `disabled`. |
| `SLACK_REPLY_TO_MODE` | `off` | Reply threading: `off`, `first`, or `all`. |
| `SLACK_REACTION_NOTIFICATIONS` | `own` | Which reactions trigger events: `off`, `own`, or `all`. |
| `SLACK_CHUNK_MODE` | `newline` | Outbound split mode. |
| `SLACK_TEXT_CHUNK_LIMIT` | `4000` | Outbound text chunk size (chars). |
| `SLACK_MEDIA_MAX_MB` | `20` | Inbound media cap in MB. |
| `SLACK_HISTORY_LIMIT` | `50` | Recent channel messages for context. |
| `SLACK_ALLOW_BOTS` | `false` | Process messages from other bots. |
| `SLACK_MESSAGE_PREFIX` | | Prefix prepended to inbound messages. |
| `SLACK_ACTIONS_REACTIONS` | `true` | Gate reaction actions. |
| `SLACK_ACTIONS_MESSAGES` | `true` | Gate message read/send/edit/delete. |
| `SLACK_ACTIONS_PINS` | `true` | Gate pin/unpin operations. |
| `SLACK_ACTIONS_MEMBER_INFO` | `true` | Gate member lookup. |
| `SLACK_ACTIONS_EMOJI_LIST` | `true` | Gate emoji list retrieval. |
| `WHATSAPP_ENABLED` | | Set to `true` to enable WhatsApp channel. Uses QR/pairing code auth at runtime. |
| `WHATSAPP_DM_POLICY` | `pairing` | DM access policy: `pairing`, `allowlist`, `open`, or `disabled`. |
| `WHATSAPP_ALLOW_FROM` | | Comma-separated E.164 phone numbers for DM allowlist. |
| `WHATSAPP_SELF_CHAT_MODE` | `false` | Enable when running on your personal WhatsApp number. |
| `WHATSAPP_GROUP_POLICY` | `allowlist` | Group access policy: `open`, `disabled`, or `allowlist`. |
| `WHATSAPP_GROUP_ALLOW_FROM` | | Comma-separated E.164 phone numbers for group sender allowlist. |
| `WHATSAPP_MEDIA_MAX_MB` | `50` | Inbound media save cap in MB. |
| `WHATSAPP_HISTORY_LIMIT` | `50` | Recent unprocessed messages inserted for group context. |
| `WHATSAPP_DM_HISTORY_LIMIT` | | DM history limit in user turns. |
| `WHATSAPP_SEND_READ_RECEIPTS` | `true` | Send read receipts (blue ticks) on message receipt. |
| `WHATSAPP_ACK_REACTION_EMOJI` | | Emoji sent on message receipt (e.g. `👀`). Omit to disable. |
| `WHATSAPP_ACK_REACTION_DIRECT` | `true` | Send ack reactions in DM chats. |
| `WHATSAPP_ACK_REACTION_GROUP` | `mentions` | Group reaction behavior: `always`, `mentions`, or `never`. |
| `WHATSAPP_MESSAGE_PREFIX` | | Inbound message prefix. |
| `WHATSAPP_ACTIONS_REACTIONS` | `true` | Enable WhatsApp tool reactions. |

If a channel env var is removed, that channel is cleaned from config on next start. WhatsApp env vars fully overwrite any existing WhatsApp config (no merge with custom JSON).

### Provider overrides (optional)

| Variable | Description |
|---|---|
| `AI_GATEWAY_BASE_URL` | Custom base URL for AI gateway (e.g. Cloudflare AI Gateway). Applied to the matching provider based on URL suffix. |
| `ANTHROPIC_BASE_URL` | Override Anthropic API base URL specifically. |
| `MOONSHOT_BASE_URL` | Override Moonshot API base URL. Default: `https://api.moonshot.ai/v1`. |
| `KIMI_BASE_URL` | Override Kimi Coding API base URL. Default: `https://api.moonshot.ai/anthropic`. |
| `MINIMAX_BASE_URL` | Override the MiniMax Anthropic-compatible chat base URL. Default: `https://api.minimax.io/anthropic` (global). China: `https://api.minimaxi.com/anthropic`. |

`MINIMAX_BASE_URL` is only the chat provider URL (`models.providers.minimax.baseUrl`). Image generation and text-to-speech ignore it. For those, set upstream OpenClaw's `MINIMAX_API_HOST` to the host with no `/anthropic` suffix (`https://api.minimax.io` by default, `https://api.minimaxi.com` for China). Music and video use the origin of the chat base URL, so a China `MINIMAX_BASE_URL` already sends them to `api.minimaxi.com`.

A saved primary of `minimax/MiniMax-M2.1` is left unchanged, and M2.1 stays in the model list so that primary still resolves. When no primary is set, MiniMax auto-selects `minimax/MiniMax-M3`.

### Extra system packages (optional)

| Variable | Description |
|---|---|
| `OPENCLAW_DOCKER_APT_PACKAGES` | Space-separated list of apt packages to install at container startup (e.g. `ffmpeg build-essential`). Packages are installed before openclaw starts. Reinstalled on each container restart. |

### Linuxbrew (baked into image)

The base image includes common skill dependencies baked in:

- **Linuxbrew** — `/home/linuxbrew/.linuxbrew` — skills that need `brew` work out of the box
- **Go** — `/usr/local/go` — for Go-based skills and tools
- **uv** — fast Python package manager for Python-based skills
- **build-essential**, **git**, **curl** — common build dependencies

Note: packages installed at runtime (e.g. via `brew install`) are part of the container filesystem and do **not** persist across container rebuilds. To permanently add packages, customize `Dockerfile.base` or use `OPENCLAW_DOCKER_APT_PACKAGES` for apt-available equivalents.

### Custom init script (optional)

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_DOCKER_INIT_SCRIPT` | *(none)* | Script that runs on every container start before openclaw starts. Must be executable and idempotent. |

### Port

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | External port nginx listens on. |

### Dot-Notation Config (OPENCLAW__*) — **Fallback for Customization**

> **Recommended:** Use the dedicated env vars (e.g., `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`) for standard configuration. Use dot-notation (`OPENCLAW__*`) only when you need to customize settings not covered by the dedicated vars or for quick one-off changes.

| Variable | Description |
|---|---|
| `OPENCLAW__<path>__<to>__<key>` | Set any config value using dot notation. Use `[]` suffix for arrays. |

```bash
# Use dedicated env vars for standard config:
TELEGRAM_BOT_TOKEN=your-token
TELEGRAM_TEXT_CHUNK_LIMIT=4000

# Use dot-notation ONLY for small customizations not covered above:
OPENCLAW__channels__telegram__customSetting=value
OPENCLAW__channels__discord__customSetting=value
```

**Auto-typing:** `true`/`false` → boolean, integers → number, floats → number, otherwise string. Use `[]` suffix for arrays (comma-separated).

> **Precedence (highest wins):** `OPENCLAW_CONFIG_JSON` > `OPENCLAW__*` dot-notation > dedicated env vars (e.g. `TELEGRAM_BOT_TOKEN`) > custom JSON mount > persisted config.
> If both a dedicated env var and a dot-notation var set the same key, the dot-notation value wins.

### JSON Config via Env Var (OPENCLAW_CONFIG_JSON)

Pass partial or full config as a JSON string. This is parsed **after** dot-notation vars, so it can override them. Invalid JSON will cause the container to exit with an error.

| Variable | Description |
|---|---|
| `OPENCLAW_CONFIG_JSON` | JSON object merged into config. Must be valid JSON. |

```bash
# Partial config override
OPENCLAW_CONFIG_JSON='{"gateway":{"port":8080},"channels":{"telegram":{"enabled":true}}}'

# In docker-compose (use quotes carefully)
environment:
  OPENCLAW_CONFIG_JSON: '{"gateway":{"port":8080}}'
```

**Validation:** If JSON is invalid, the container exits with error before starting. Use `docker logs` to see the parse error.

### Coolify-specific (auto-set by Coolify)

| Variable | Description |
|---|---|
| `COOLIFY_URL` | Application URL(s) assigned by Coolify, scheme included. Comma-separated when several domains are configured. Preferred source for Control UI allowed origins; each entry is normalized to a browser origin. |
| `COOLIFY_FQDN` | Application domain name(s), usually without a scheme. Used for allowed origins only when `COOLIFY_URL` is unset. Bare hosts become `https://` origins. |
| `COOLIFY_BRANCH` | Git branch deployed. |

## Custom JSON config (Docker mount)

For settings too complex for flat env vars (e.g. `channels.*.groups`, agent defaults, plugin config), mount a custom JSON file into the container:

```bash
docker run -v ./my-openclaw.json:/app/config/openclaw.json ...
```

Override the mount path with `OPENCLAW_CUSTOM_CONFIG` env var if needed.

**3-tier merge order** (configure.js):

1. Custom JSON (`/app/config/openclaw.json`) — base layer
2. Persisted state (`<STATE_DIR>/openclaw.json`) — preserves runtime changes from previous runs
3. Env vars — applied on top, always win

Arrays are replaced, not concatenated. One exception: `models.providers.ollama.models` from the custom JSON file is kept when the persisted config still has an older Ollama model list. Provider API keys are always read from env vars, never from JSON.

**Note:** WhatsApp is a special case — when `WHATSAPP_ENABLED=true`, env vars fully overwrite the WhatsApp config block (custom JSON whatsapp keys are discarded). For all other channels, custom JSON keys are preserved and env vars merge on top.

`openclaw doctor --fix` runs on every start. OpenClaw 2026.10.5 validates `openclaw.json` with a strict schema, and `gateway run` exits if an unrecognized key is present at process start, so doctor still rewrites the file before the gateway listens. That keeps upgrades migrating and still applies env-driven values from `configure.js` (doctor may then canonicalize a model id). Extra top-level keys are copied aside first and written back after the gateway is listening. A running gateway keeps the valid config it loaded and skips reloading the unrecognized key. Nested keys doctor changed are not put back. Related to [#15](https://github.com/coollabsio/openclaw/issues/15).

## Notes

- Openclaw uses CalVer: `v2026.1.29` (roughly daily releases). Detected via GitHub Releases API.
- Using native `ubuntu-24.04-arm` runners for arm64 builds (same pattern as coollabsio/pocketbase).
- Config is environment-driven: set env vars → restart container → config updates automatically.
