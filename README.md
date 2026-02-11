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
  -v openclaw-data:/data \
  coollabsio/openclaw:latest
```

- `ANTHROPIC_API_KEY` — any [supported provider key](#ai-providers-at-least-one-required) works (OpenAI, Gemini, etc.)
- `AUTH_PASSWORD` — protects the web UI with HTTP basic auth (user defaults to `admin`, override with `AUTH_USERNAME`)
- `OPENCLAW_GATEWAY_TOKEN` — internal API token; auto-generated if omitted, but set it explicitly for stable API access
- `/data` — persists state, config, and workspace across restarts

### Full Setup (docker-compose)

Includes persistent storage, browser sidecar (CDP + VNC), and webhook hooks. See [`docker-compose.yml`](docker-compose.yml).

```bash
docker compose up -d
```

**After starting:**

1. **Openclaw UI** — `http://localhost:8080` (login: your `AUTH_USERNAME` / `AUTH_PASSWORD`)
2. **Browser desktop** — `http://localhost:8080/browser/` (login: your `AUTH_USERNAME` / browser `PASSWORD`) — use this to log into sites that need auth (OAuth, 2FA, captchas). Openclaw reuses the session via CDP.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Docker container (coollabsio/openclaw)     │
│                                             │
│  ┌──────────┐  :8080   ┌────────────────┐  │
│  │  nginx    │ ──────→  │  openclaw      │  │
│  │  (basic   │  proxy   │  gateway       │  │
│  │   auth)   │  :18789  │  :18789        │  │
│  └──────────┘          └────────────────┘  │
│                                             │
│  entrypoint.sh                              │
│    1. configure.js (env vars → json)        │
│    2. nginx (background)                    │
│    3. exec openclaw gateway                 │
└─────────────────────────────────────────────┘
```

Two-layer Docker build:
1. **Base image** (`Dockerfile.base`) — builds openclaw from source. Tagged `coollabsio/openclaw-base:<version>`.
2. **Final image** (`Dockerfile`) — FROM base, adds nginx + env-to-config scripts. Tagged `coollabsio/openclaw:<version>`.

## Files

```
.github/workflows/auto-update.yml   — cron every 6h, check openclaw releases, build+push
.github/workflows/build.yml         — CI on push/PR (build only, no push)
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

Triggers: `schedule: '0 */6 * * *'` + `workflow_dispatch` (version, force_rebuild, skip_latest_tag).

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
| `MINIMAX_API_KEY` | MiniMax API key (Anthropic-compatible). Configures MiniMax M2.1. |
| `ZAI_API_KEY` | ZAI API key. Configures GLM models. |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway API key. |
| `OPENCODE_API_KEY` | OpenCode API key. Also accepted as `OPENCODE_ZEN_API_KEY`. |
| `SYNTHETIC_API_KEY` | Synthetic API key (Anthropic-compatible). |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot token. Configures Claude models via GitHub. |
| `XIAOMI_API_KEY` | Xiaomi MiMo API key (Anthropic-compatible). Configures MiMo v2 Flash. |

Multiple providers can be set simultaneously. Priority for primary model: Anthropic > OpenAI > OpenRouter > Gemini > OpenCode > GitHub Copilot > xAI > Groq > Mistral > Cerebras > Venice > Moonshot > Kimi > MiniMax > Synthetic > ZAI > AI Gateway > Xiaomi > Bedrock > Ollama.

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
| `OLLAMA_BASE_URL` | Ollama server URL (e.g. `http://host.docker.internal:11434`). Enables Ollama provider when set. |

### Model selection

| Variable | Description |
|---|---|
| `OPENCLAW_PRIMARY_MODEL` | Override auto-selected primary model. Format: `provider/model-id` (e.g. `anthropic/claude-sonnet-4-5-20250929`). |

### HTTP Basic Auth (recommended)

| Variable | Default | Description |
|---|---|---|
| `AUTH_PASSWORD` | *(none)* | If set, nginx enforces HTTP basic auth on all routes except `/healthz` and the hooks path (when hooks are enabled). If unset, no auth — gateway is open. |
| `AUTH_USERNAME` | `admin` | Username for basic auth. |

### Gateway

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | *(auto-generated)* | Bearer token for gateway auth. Auto-generated and persisted to `<STATE_DIR>/gateway.token` if not set. |
| `OPENCLAW_GATEWAY_PORT` | `18789` | Internal port the gateway binds to. |
| `OPENCLAW_GATEWAY_BIND` | `loopback` | Gateway bind mode. `loopback` = 127.0.0.1 only (nginx proxies LAN traffic). `lan` = 0.0.0.0 (direct access, bypasses nginx auth). Also: `tailnet`, `auto`, `custom`. |
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | Persistent state directory. Mount a volume here. |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | Workspace directory for openclaw projects. |
| `OPENCLAW_CONFIG_PATH` | `<STATE_DIR>/openclaw.json` | Override path to the config file. |
| `OPENCLAW_CUSTOM_CONFIG` | `/app/config/openclaw.json` | Path to a user-provided custom JSON config. Env vars override on top. |

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
| `BROWSER_CDP_URL` | | Remote CDP URL pointing to a browser sidecar (e.g. `http://browser:9222`). Required to activate browser tool. |
| `BROWSER_EVALUATE_ENABLED` | `false` | Allow JavaScript evaluation in page context via browser actions. |
| `BROWSER_SNAPSHOT_MODE` | | Default snapshot mode (e.g. `efficient`). |
| `BROWSER_REMOTE_TIMEOUT_MS` | `1500` | HTTP timeout in ms for remote CDP connection. |
| `BROWSER_REMOTE_HANDSHAKE_TIMEOUT_MS` | `3000` | WebSocket handshake timeout in ms for remote CDP. |
| `BROWSER_DEFAULT_PROFILE` | | Override the default browser profile name. |

Requires a separate browser container connected via Docker networking. Recommended: `kasmweb/chrome` (full Chrome desktop via noVNC on `:6901`, CDP on `:9222`). Docs: https://docs.openclaw.ai/tools/browser

#### Browser login (VNC sidecar)

For sites requiring authentication, use `kasmweb/chrome` so you can log in manually via a web-based desktop. Openclaw reuses the authenticated session via CDP.

1. Open `https://<host>:6901` — full Chrome desktop via noVNC
2. Navigate to the target site, log in manually (handles captchas, 2FA, OAuth)
3. Sessions persist in a mounted volume across restarts
4. Set `BROWSER_CDP_URL=http://browser:9222` — openclaw connects via CDP

Mount a persistent volume at the sidecar's profile directory (`/home/kasm-user`) so cookies and sessions survive container restarts. The sidecar may need `CHROME_ARGS=--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0` to expose CDP. Docs: https://docs.openclaw.ai/tools/browser-login

### Channels (optional)

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

### Extra system packages (optional)

| Variable | Description |
|---|---|
| `OPENCLAW_DOCKER_APT_PACKAGES` | Space-separated list of apt packages to install at container startup (e.g. `ffmpeg build-essential`). Packages are installed before openclaw starts. Reinstalled on each container restart. |

### Port

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | External port nginx listens on. |


### Coolify-specific (auto-set by Coolify)

| Variable | Description |
|---|---|
| `COOLIFY_FQDN` | Public FQDN assigned by Coolify. |
| `COOLIFY_URL` | Coolify dashboard URL. |
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

Arrays are replaced, not concatenated. Provider API keys are always read from env vars, never from JSON.

**Note:** WhatsApp is a special case — when `WHATSAPP_ENABLED=true`, env vars fully overwrite the WhatsApp config block (custom JSON whatsapp keys are discarded). For all other channels, custom JSON keys are preserved and env vars merge on top.

## Notes

- Openclaw uses CalVer: `v2026.1.29` (roughly daily releases). Detected via GitHub Releases API.
- Using native `ubuntu-24.04-arm` runners for arm64 builds (same pattern as coollabsio/pocketbase).
- Config is environment-driven: set env vars → restart container → config updates automatically.
