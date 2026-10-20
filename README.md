# Openclaw Automated Build

## Quick Start

### Minimal (`docker run`)

A single container does not need the browser sidecar. nginx starts either way. `/browser/` returns 502 until that sidecar is on the same Docker network. An older image failed this command with `host not found in upstream "browser"` because nginx resolved that name at startup ([#78](https://github.com/coollabsio/openclaw/issues/78)). The current entrypoint proxies `/browser/` through a variable and Docker's DNS, so a missing sidecar does not stop nginx.

```bash
docker run -d \
  --name openclaw \
  --restart unless-stopped \
  -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD=changeme \
  -e OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)" \
  -e OPENCLAW_ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080 \
  -v openclaw-data:/data \
  coollabsio/openclaw:latest
```

Open `http://localhost:8080` and sign in as `admin` / `changeme` (or whatever you set). `GET /healthz` is not behind basic auth and returns `{"ok":true,"status":"live"}` once the gateway is up. The first boot copies Linuxbrew onto the volume, so that can take a few minutes. The container's `HEALTHCHECK` start period is 5 minutes.

- `ANTHROPIC_API_KEY` — any non-empty [supported provider key](#ai-providers-at-least-one-required) works (OpenAI, Gemini, and the rest). The entrypoint exits if none is set. The value is not checked against the provider until a model call.
- `AUTH_PASSWORD` — HTTP basic auth for the web UI and the WebSocket. `AUTH_USERNAME` defaults to `admin` when omitted. `/healthz` stays open.
- `OPENCLAW_GATEWAY_TOKEN` — required. The container exits if it is missing or empty. It is written to `gateway.auth.token`. The command above generates one. Save that value. The Mac app and the Control UI both need it. A placeholder such as `my-secret-token` also starts the container.
- `OPENCLAW_ALLOWED_ORIGINS` — browser origins allowed to open the Control UI WebSocket. Coolify adds the application origin on its own, so a Coolify deploy can leave this unset. A plain `docker run` has no Coolify URL. nginx forwards `X-Forwarded-*`, and OpenClaw 2026.10.5 then does not treat `http://localhost:8080` as an implicit same-origin client. Set the origin you actually open. `http://localhost:5173` and `http://localhost:3000` are other dev servers. They do not allow the UI on port 8080, and the page will load while the gateway rejects the socket with `origin not allowed`.
- `-p 8080:8080` — nginx. The gateway listens on `127.0.0.1:18789` inside the container and is not published. Do not map 18789 unless you mean to skip nginx. See [Connect the Mac app](docs/mac-app.md).
- `/data` — required volume. Persists config, credentials, paired devices, workspace, and chat history across container recreates (`docker compose down` keeps the named volume; `docker compose down -v` deletes it). OpenClaw 2026.10.5 stores sessions in `/data/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` and paired devices in `/data/.openclaw/state/openclaw.sqlite`. The image sets `HOME` and `OPENCLAW_HOME` to `/data` so `~/.openclaw` is that directory. `/root/.openclaw` is outside the volume. Backups: [Back up and restore `/data`](docs/backup-restore.md).

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
4. In the container terminal, list pending requests and approve that id. A Coolify terminal and `docker exec` already have `OPENCLAW_GATEWAY_TOKEN`. The image sets `HOME` and `OPENCLAW_HOME` to `/data`. Leave `OPENCLAW_GATEWAY_URL` unset and do not pass `--url`. The CLI then uses the loopback gateway at `ws://127.0.0.1:18789` (the process nginx proxies to) and reads config from `/data/.openclaw/openclaw.json`.

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

OpenClaw 2026.10.5 does not do that on the loopback gateway when `OPENCLAW_GATEWAY_TOKEN` is set. The commands above approve the browser request. On the current image, `docker exec` has `HOME=/data` and `OPENCLAW_HOME=/data`. Leave `OPENCLAW_GATEWAY_URL` unset and do not pass `--url`. The Control UI then reaches Home. No `scope upgrade pending approval`, and no `401` with `WWW-Authenticate: Basic` after the page loaded.

If approval still fails, match the message:

| What you see | What to run |
|---|---|
| `openclaw devices approve` with no id prints the pending request and exits 1 | Rerun with the request id from that preview or from the browser. |
| `gateway rejected websocket upgrade (HTTP 401)` | The CLI is aimed at nginx (`:8080` or the public Coolify `wss://` URL). Basic auth rejects it before the gateway. Unset `OPENCLAW_GATEWAY_URL`, drop `--url`, and rerun so the target stays `ws://127.0.0.1:18789`. `gateway.trustedProxies` is for browser traffic through nginx; it does not apply to this direct loopback connection. |
| `gateway device.pair.list requires credentials` or `gateway url override requires explicit credentials` | Pass the container's `OPENCLAW_GATEWAY_TOKEN` with `--token` when you also pass `--url`. With no `--url`, the env token is used. `HOME` and `OPENCLAW_HOME` are `/data`, so a shell that dropped the token still reads `gateway.auth.token` from `/data/.openclaw/openclaw.json`. |
| `This device can't approve its own scope upgrade` or `scope upgrade pending approval` | The CLI authenticated as a paired device and asked for scopes that device does not have. Approve the **browser** request id from `openclaw devices list` on the loopback gateway with `OPENCLAW_GATEWAY_TOKEN` set and no `--url`. The CLI cannot approve its own pending scope upgrade. |

### Mac app

The Mac app uses the same approval commands, with a different URL. On OpenClaw v2026.10.5 the gateway address is `wss://<your domain>` (Coolify) or `ws://<host>:8080` (`docker run`), and `OPENCLAW_GATEWAY_TOKEN` goes in the token field, not in the URL. `gateway.mode` on the Mac is `remote`. Do not write that `gateway.remote` block into the container config, and do not put `AUTH_USERNAME`:`AUTH_PASSWORD` in the WebSocket URL. The app rejects URL userinfo. When `AUTH_PASSWORD` is set, nginx still requires basic auth on the WebSocket, which that direct URL cannot send. Details, including the SSH alternative: [Connect the Mac app](docs/mac-app.md).

### Back up and restore `/data`

Stop the container and archive the volume, or use `openclaw backup create` for a SQLite-safe snapshot while the gateway stays up. Paired devices live in `/data/.openclaw/state/openclaw.sqlite`, not in a JSON file you can copy by itself. Coolify 4.3.0+ can schedule that volume backup. Use **Stop containers during archive**. There is no dashboard restore. Steps: [Back up and restore `/data`](docs/backup-restore.md).

## Architecture

```
┌─────────────────────────────────────────────┐
│  Docker container (coollabsio/openclaw)     │
│                                             │
│  Baked in: Linuxbrew, Go, uv, build-essential│
│  Persistent volume: /data                   │
│    ├── .openclaw/      (state & config)     │
│    │     └── agents/<id>/agent/             │
│    │           openclaw-agent.sqlite        │
│    │           (chat history)               │
│    ├── workspace/      (user projects)      │
│    ├── venv/           (pip packages)       │
│    └── uv/             (uv tool installs)   │
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
│    3. doctor --fix, then park extra keys    │
│    4. nginx (background)                    │
│    5. gateway run (entrypoint stays up)     │
└─────────────────────────────────────────────┘
```

Two-layer Docker build:
1. **Base image** (`Dockerfile.base`) — builds openclaw from source. Tagged `coollabsio/openclaw-base:<version>`.
2. **Final image** (`Dockerfile`) — FROM base, adds nginx + env-to-config scripts. Tagged `coollabsio/openclaw:<version>`.

`GET /healthz` on the published port is not behind basic auth. Coolify and the image `HEALTHCHECK` both probe it. nginx forwards that path to the gateway's own `/healthz` and does not rewrite it to `/`. A live gateway returns `{"ok":true,"status":"live"}`. When the gateway port is closed, or the gateway returns 502, 503, or 504, nginx answers 503 with `{"ok":false,"status":"unavailable"}`, and `curl -f` fails. The health check's `--start-period` is 5 minutes. Failures in that window do not count, and the first success marks the container healthy immediately, so the Linuxbrew volume copy, `configure.js`, `doctor --fix`, and the first gateway boot are not marked unhealthy. After that success, later failures count toward `--retries`. If the gateway process exits, nginx keeps running so those probes can fail and Docker can report the container unhealthy.

## Agent sandbox

The image includes the Docker **client** only. Sandboxing stays off until you opt in. OpenClaw runs the `docker` CLI inside the gateway and asks the **host** engine to create a sibling container for tool execution. [`docker-compose.yml`](docker-compose.yml) does not mount the socket.

**Mounting `/var/run/docker.sock` gives this container root on the host.** A process in the gateway can start containers, read host files, and control every other container on that engine. Turn it on only for a host where that access is acceptable. Do not mount the socket into the sandbox containers.

```yaml
    volumes:
      - openclaw-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
```

The host engine bind-mounts the workspace, so the source path has to exist on the host. Keep paths in `openclaw.json` as the gateway sees them (`/data/workspace`, `/data/.openclaw`). OpenClaw rewrites those by inspecting this container.

- A host **bind mount** of the state directory is the setup OpenClaw documents. `/srv/openclaw:/data` and `/data` inside the gateway are the same files; the sandbox mount uses `/srv/openclaw/...` on the host.
- The default **named volume** `openclaw-data:/data` has no separate host path. On `docker inspect` of this container, the image client reports that volume's mountpoint (`/var/lib/docker/volumes/<name>/_data/...`) as a bind, which is the directory the host engine can mount. This applies to a local volume whose `Source` is an absolute path. `OPENCLAW_DOCKER_VOLUME_AS_BIND=0` leaves inspect output unchanged.

Build the sandbox image on the host that owns the socket (OpenClaw does not substitute a plain Debian image), then set the sandbox mode:

```bash
docker build -t openclaw-sandbox:bookworm-slim - <<'EOF'
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox
CMD ["sleep", "infinity"]
EOF
```

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main",
        "scope": "session",
        "workspaceAccess": "none"
      }
    }
  }
}
```

`openclaw sandbox list` shows the sibling containers. Upstream reference: https://docs.openclaw.ai/gateway/sandboxing

## Files

```
.github/workflows/auto-update.yml   — cron hourly, check openclaw releases, build+push
.github/workflows/build.yml         — CI on push/PR; builds the latest upstream release (no push)
Dockerfile.base                     — multi-stage: build openclaw from source → slim runtime
Dockerfile                          — FROM base, add nginx + config scripts + entrypoint
scripts/configure.js                — reads env vars, writes/patches openclaw.json
scripts/docker-cli.js               — docker client wrapper; named volumes as host binds
scripts/entrypoint.sh               — configure → doctor → generated nginx site → gateway
scripts/preserve-hand-edits.js      — parks unrecognized top-level keys in openclaw.extra.json
scripts/smoke.js                    — smoke test (openclaw --version)
Dockerfile.browser                  — browser sidecar image (FROM lscr.io/linuxserver/chromium)
browser/cdp-proxy.conf              — sidecar CDP proxy 0.0.0.0:9223 → 127.0.0.1:9222
docs/backup-restore.md              — back up and restore /data, including Coolify volume backups
docs/mac-app.md                     — connect the OpenClaw Mac app to this gateway
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

## Updating on Coolify

Update by pulling a newer image tag and redeploying. `npm install -g openclaw` and `openclaw update` inside the container exit with that instruction. The image builds OpenClaw from the upstream tag, the gateway process is PID 1, and a global npm install lands on `/data/npm-global`, which stays on the volume and would hide the binary from later image tags.

`auto-update.yml` publishes `coollabsio/openclaw:<version>` and `:latest` after each upstream release (the check runs hourly). Pin `coollabsio/openclaw:<version>` in the Coolify service (CalVer, for example `2026.10.5`). When a new tag appears, read the upstream release notes, change the tag, and redeploy. Coolify recreates the container. `/data` keeps config, credentials, workspace, and chat history. Startup runs `openclaw doctor --fix` before the gateway listens. Live WebSocket sessions disconnect during the recreate; device pairings and history on `/data` are there when the new container is up. Leave the volume in place (`docker compose down -v` deletes it).

A service that tracks `:latest` and redeploys on every publish follows breaking releases as well. Pin a version tag when you want to read the notes first.

## Secrets needed (repo settings)

- `DOCKERHUB_USERNAME` — Docker Hub username
- `DOCKERHUB_TOKEN` — Docker Hub access token
- `GITHUB_TOKEN` — auto-provided by GitHub Actions

## Environment variables

### AI Providers (at least one required)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key. Built-in provider. When no primary is saved, selects `anthropic/claude-opus-4-5-20251101`. |
| `OPENAI_API_KEY` | OpenAI API key. Built-in provider. When no primary is saved and no Anthropic key is set, selects `openai/gpt-5.2`. |
| `OPENROUTER_API_KEY` | OpenRouter API key. When no primary is saved, selected after Anthropic and OpenAI (`openrouter/anthropic/claude-opus-4-5`). |
| `GEMINI_API_KEY` | Google Gemini API key. When no primary is saved, selected after Anthropic, OpenAI, and OpenRouter (`google/gemini-3-pro`). |
| `DEEPSEEK_API_KEY` | DeepSeek API key. Uses the bundled DeepSeek plugin. When no primary is saved, selected after Anthropic, OpenAI, OpenRouter, and Gemini (`deepseek/deepseek-v4-pro`). |
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

Multiple providers can be set simultaneously. Priority for primary model: Anthropic > OpenAI > OpenRouter > Gemini > DeepSeek > OpenCode > GitHub Copilot > xAI > Groq > Mistral > Cerebras > Venice > Moonshot > Kimi > MiniMax > Synthetic > ZAI > AI Gateway > Xiaomi > Bedrock > Ollama > OpenAI-Compatible.

`DEEPSEEK_API_KEY` is enough on its own. The image already includes the upstream `@openclaw/deepseek-provider` plugin, which reads that variable. Do not put the key in `openclaw.json`. DeepSeek retired `deepseek-chat` and `deepseek-reasoner` (the old "deepseek-reasoning" choice) on 2026-07-24, so those ids do not connect. Pick another model with `OPENCLAW_PRIMARY_MODEL=deepseek/deepseek-v4-flash` (or `deepseek/deepseek-v4-pro`). To point at DeepSeek through the generic OpenAI-compatible path instead of the plugin, set `OPENAI_COMPATIBLE_BASE_URL=https://api.deepseek.com`, `OPENAI_COMPATIBLE_MODEL=deepseek-v4-pro`, and `OPENAI_COMPATIBLE_API_KEY`. That path does not get the plugin's thinking replay.

Custom provider blocks (Venice, MiniMax, Moonshot, Kimi, Synthetic, Xiaomi, Bedrock, Ollama, OpenAI-compatible) are removed from `openclaw.json` on the next start when their env var is unset and no custom JSON file is mounted. Built-in providers are detected from the env var only; `configure.js` does not write a `models.providers` entry for them. A mounted custom JSON file is not stripped.

### Deepgram (audio transcription, optional)

| Variable | Description |
|---|---|
| `DEEPGRAM_API_KEY` | Deepgram API key. Enables audio transcription via Nova 3 model. |

### Amazon Bedrock (uses AWS credential chain)

| Variable | Default | Description |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | | AWS access key. Both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` required. |
| `AWS_SECRET_ACCESS_KEY` | | AWS secret key. |
| `AWS_REGION` | `us-east-1` | AWS region for the Bedrock runtime endpoint. Falls back to `AWS_DEFAULT_REGION`, then `us-east-1`. |
| `AWS_DEFAULT_REGION` | | Used only when `AWS_REGION` is unset. |
| `AWS_SESSION_TOKEN` | | Optional session token for temporary credentials. Not written into `openclaw.json`; the AWS SDK reads it from the process environment. |
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
| `OPENCLAW_GATEWAY_TOKEN` | *(required)* | Bearer token for gateway auth. The container exits if this is unset. Generate one with `openssl rand -hex 32`. Written to `gateway.auth.token` in `openclaw.json`. |
| `OPENCLAW_GATEWAY_PORT` | `18789` | Internal port the gateway binds to. |
| `OPENCLAW_GATEWAY_BIND` | `loopback` | Used only when `gateway.bind` is not already set. `loopback` = 127.0.0.1 only (nginx proxies LAN traffic). `lan` = 0.0.0.0. Direct access on 18789 bypasses nginx auth and requires publishing that port. Also: `tailnet`, `auto`, `custom`. A persisted bind is kept. |
| `HOME` / `OPENCLAW_HOME` | `/data` | Pinned in the image and again by the entrypoint, including for `docker exec` and Coolify terminals. `OPENCLAW_HOME` is the parent of `OPENCLAW_STATE_DIR` and is consulted before `HOME`, so `~/.openclaw` stays on the volume. The Node image default `/root` is outside `/data`. |
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | Persistent state directory, including chat history at `agents/<agentId>/agent/openclaw-agent.sqlite`. Included in the `/data` volume. Do not mount a second volume on this path. |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | Workspace directory for openclaw projects. Included in the `/data` volume. |
| `OPENCLAW_CONFIG_PATH` | `<STATE_DIR>/openclaw.json` | Override path to the config file. |
| `OPENCLAW_CUSTOM_CONFIG` | `/app/config/openclaw.json` | Path to a user-provided custom JSON config. Env vars override on top. |

`configure.js` sets `gateway.trustedProxies` to `127.0.0.1` and `::1` when that value is not already an array. nginx overwrites `X-Forwarded-For` with the connecting client when basic auth is on, so OpenClaw's auth rate limit sees that client instead of treating everyone as loopback (which is exempt from lockout). This does not enable trusted-proxy authentication; `gateway.auth.mode` stays `token`. Set your own `gateway.trustedProxies` in custom JSON to override. With Docker port publishing, that client is often the bridge address shared by every visitor, and current OpenClaw builds may ask for a one-time device pairing for a non-loopback address.

`openclaw doctor --fix` runs on every start to migrate config. It does not delete the agent SQLite database. A leftover store under the account home (`/root/.openclaw`, outside the volume) is copied once when the volume does not already have that file: each agent's `openclaw-agent.sqlite` and its sidecars, session files under `agents/<id>/sessions`, and `state/openclaw.sqlite`. The ephemeral directory is then renamed aside. An existing volume file is left in place.

The Coolify service template (`templates/compose/openclaw.yaml` in the Coolify repo) mounts `openclaw-data:/data` and sets `OPENCLAW_STATE_DIR=/data/.openclaw`, the same path as [`docker-compose.yml`](docker-compose.yml).

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

[`docker-compose.yml`](docker-compose.yml) runs `coollabsio/openclaw-browser` on the same compose network. That image is built from [`Dockerfile.browser`](Dockerfile.browser), which starts `FROM lscr.io/linuxserver/chromium:latest`. Compose does not pull the linuxserver image directly. Docs: https://docs.openclaw.ai/tools/browser

#### Why linuxserver/chromium, and how to use a lighter browser

[Issue #30](https://github.com/coollabsio/openclaw/issues/30) asks why the sidecar is `lscr.io/linuxserver/chromium`. It is a remote desktop (Selkies), not a headless Chromium binary. The desktop is what `/browser/` shows, so you can pass an OAuth prompt, a captcha, or 2FA and have the agent reuse that profile over CDP. The linuxserver image serves that desktop on container port 3000, which this image's nginx proxies at `/browser/` behind basic auth. Chromium still binds DevTools to `127.0.0.1:9222`. [`browser/cdp-proxy.conf`](browser/cdp-proxy.conf) is added to Selkies' existing nginx so the compose network can use `http://browser:9223`. `kasmweb/chrome` was the previous sidecar. Its desktop is on port 6901 and its CDP flags are not the ones this proxy expects, so it was replaced rather than used as the lighter option. The extra apps inside the desktop image are unused. The desktop is the part the login flow needs.

A headless Chromium does not need that image. Leave the `browser` service out (a plain `docker run` already does) and set `BROWSER_CDP_URL` to a CDP endpoint the gateway can reach. `configure.js` writes it to `browser.cdpUrl`. OpenClaw 2026.10.5 then attaches and does not launch a browser inside the gateway container (`docs/tools/browser/remote.md`). `headless` only applies to a local browser OpenClaw itself starts. It does not change a remote CDP endpoint.

Accepted `BROWSER_CDP_URL` shapes, from those docs:

- `http://host:port` or `https://host:port` — OpenClaw reads `/json/version` and uses the advertised WebSocket.
- `ws://host:port/devtools/browser/<id>` (or `wss://`) — connect that socket directly.
- A bare `ws://host:port` — try `/json/version` first, then the bare socket (Browserless-style hosts).

The hostname `browser` is the only private name this image allowlists on its own. Another container hostname needs an explicit allowlist. A raw private IP is not allowlisted. Loopback CDP (a port published on `127.0.0.1` of the gateway container) also needs `attachOnly: true` on that profile, or OpenClaw treats the port as a browser it owns. There is no env var for `attachOnly`. Set it in the custom JSON mount or `OPENCLAW_CONFIG_JSON`.

```bash
BROWSER_CDP_URL=http://chromium:9223
OPENCLAW__browser__ssrfPolicy__allowedHostnames[]=chromium
```

Stock Chromium ignores `--remote-debugging-address` and listens on `127.0.0.1` only, so another container cannot open that port. The lighter process still needs something listening on the compose network: Browserless, or any CDP proxy that forwards to the loopback DevTools port the way `cdp-proxy.conf` does. You do not get `/browser/`. A headless process has no screen for a captcha or an OAuth consent page. Use the desktop sidecar when a site requires that. Docs: https://docs.openclaw.ai/tools/browser/remote

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

Removing a channel env var does not delete that channel from the persisted config. WhatsApp env vars fully overwrite any existing WhatsApp config when `WHATSAPP_ENABLED` is `true` or `1` (custom JSON whatsapp keys are discarded).

### Provider overrides (optional)

`configure.js` does not read `AI_GATEWAY_BASE_URL` or `ANTHROPIC_BASE_URL`, and it does not route a gateway URL by suffix. Built-in Anthropic, OpenAI, and Vercel AI Gateway endpoints stay on OpenClaw's defaults. Use the variables below, or `OPENAI_COMPATIBLE_BASE_URL`, for endpoints this image writes into `openclaw.json`.

| Variable | Description |
|---|---|
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
- **Python 3** — `python3`, `pip`, `pip3`, and `python3 -m venv`. Startup creates a virtualenv at `/data/venv` and puts it first on `PATH`.
- **uv** — `uv` and `uvx`. The Control UI installs Python skills with `uv tool install`.
- **build-essential**, **git**, **curl** — common build dependencies

On first start the entrypoint copies Linuxbrew to `/data/linuxbrew` and points `/home/linuxbrew/.linuxbrew` at that directory, so `brew install` stays on the volume across container recreates. `docker compose down -v` deletes it. Packages from `OPENCLAW_DOCKER_APT_PACKAGES` are installed into the container layer on every start.

`pip install` goes into `/data/venv`, so those packages stay on the volume when the container is recreated and do not hit Debian's externally-managed-environment (PEP 668) error. `uv tool install` keeps tool environments under `/data/uv` (`UV_TOOL_DIR`, `UV_TOOL_BIN_DIR`, `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`).

### ClawHub skills

`openclaw skills install` talks to ClawHub (`https://clawhub.ai`) from this container. A `429` / `Rate limit exceeded` on `/api/v1/download` is ClawHub's limit for anonymous requests. The image does not proxy those calls or share one IP across installs.

Create a token at [clawhub.ai/settings](https://clawhub.ai/settings) and set `CLAWHUB_TOKEN` ( `CLAWHUB_AUTH_TOKEN` is also read). OpenClaw sends it on skill installs. A token written by `npx clawhub login --token <token>` is stored at `$HOME/.config/clawhub/config.json`. `HOME` is `/data`, so that file stays on the volume.

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

> **Precedence (highest wins):** `OPENCLAW_CONFIG_JSON` > `OPENCLAW__*` dot-notation > dedicated env vars (e.g. `TELEGRAM_BOT_TOKEN`) > persisted `openclaw.json` > custom JSON mount.
> If both a dedicated env var and a dot-notation var set the same key, the dot-notation value wins. A saved `gateway.bind` and an existing `gateway.trustedProxies` array are kept. A saved primary model is kept unless `OPENCLAW_PRIMARY_MODEL` is set.

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

## Custom JSON config (Docker mount)

For settings too complex for flat env vars (e.g. `channels.*.groups`, agent defaults, plugin config), mount a custom JSON file into the container:

```bash
docker run -v ./my-openclaw.json:/app/config/openclaw.json ...
```

Override the mount path with `OPENCLAW_CUSTOM_CONFIG` env var if needed.

**3-tier merge order** (configure.js):

1. Custom JSON (`/app/config/openclaw.json`) — base layer
2. Persisted state (`<STATE_DIR>/openclaw.json`) — preserves runtime changes from previous runs
3. Env vars — applied on top for the keys those variables set

Arrays are replaced, not concatenated. One exception: `models.providers.ollama.models` from the custom JSON file is kept when the persisted config still has an older Ollama model list. Provider API keys are always read from env vars, never from JSON.

`gateway.bind` is taken from `OPENCLAW_GATEWAY_BIND` only when the merged config has no bind. `gateway.trustedProxies` is set to `127.0.0.1` and `::1` only when it is not already an array. A saved `agents.defaults.model.primary` is kept unless `OPENCLAW_PRIMARY_MODEL` is set.

**Note:** WhatsApp is a special case — when `WHATSAPP_ENABLED` is `true` or `1`, env vars fully overwrite the WhatsApp config block (custom JSON whatsapp keys are discarded). For all other channels, custom JSON keys are preserved and env vars merge on top.

`openclaw doctor --fix` runs on every start. OpenClaw 2026.10.5 validates `openclaw.json` with a strict schema. An unrecognized top-level key makes `gateway run` exit when it is present at process start, and it makes CLI commands such as `openclaw devices list`, `openclaw devices approve`, and `openclaw sessions` exit 1 (`Unrecognized key`). Doctor still rewrites `openclaw.json` before the gateway listens. That keeps upgrades migrating and still applies env-driven values from `configure.js` (doctor may then canonicalize a model id). Nested keys doctor changed are not put back.

Unrecognized top-level keys are not written back into `openclaw.json`. They are parked in `<STATE_DIR>/openclaw.extra.json` (normally `/data/.openclaw/openclaw.extra.json`) and that file survives restarts. The gateway and the CLI do not load it — OpenClaw would reject those keys — so it preserves hand edits without becoming active config. Put settings OpenClaw understands in the custom JSON mount or in `openclaw.json`. A key you add to `openclaw.json` that doctor removes is moved into `openclaw.extra.json` on that start. A volume from an older image, which wrote those keys back into `openclaw.json` after the gateway was listening, is migrated the same way. Related to [#15](https://github.com/coollabsio/openclaw/issues/15) and [#98](https://github.com/coollabsio/openclaw/pull/98).

## Notes

- Openclaw uses CalVer: `v2026.1.29` (roughly daily releases). Detected via GitHub Releases API.
- Using native `ubuntu-24.04-arm` runners for arm64 builds (same pattern as coollabsio/pocketbase).
- Config is environment-driven: set env vars → restart container → config updates automatically.
