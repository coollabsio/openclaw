# Moltbot — OpenClaw Docker Build

## Channel env var pattern

Each channel in `scripts/configure.js` maps `CHANNEL_*` env vars → `channels.<name>.*` in `openclaw.json`.

- **Telegram/Discord/Slack**: merge — `config.channels.X = config.channels.X || {}` (env vars override individual keys, custom JSON keys preserved)
- **WhatsApp**: full overwrite — `config.channels.whatsapp = {}` (env vars are authoritative, custom JSON whatsapp block is discarded when WHATSAPP_ENABLED=true)

### Telegram env vars (20 total)

Gate: `TELEGRAM_BOT_TOKEN` (required to activate).

Strings: `TELEGRAM_DM_POLICY`, `TELEGRAM_GROUP_POLICY`, `TELEGRAM_REPLY_TO_MODE`, `TELEGRAM_CHUNK_MODE`, `TELEGRAM_STREAM_MODE`, `TELEGRAM_REACTION_NOTIFICATIONS`, `TELEGRAM_REACTION_LEVEL`, `TELEGRAM_PROXY`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_PATH`, `TELEGRAM_MESSAGE_PREFIX`
Booleans: `TELEGRAM_LINK_PREVIEW`, `TELEGRAM_ACTIONS_REACTIONS`, `TELEGRAM_ACTIONS_STICKER`
Numbers: `TELEGRAM_TEXT_CHUNK_LIMIT`, `TELEGRAM_MEDIA_MAX_MB`
CSV→Array: `TELEGRAM_ALLOW_FROM`, `TELEGRAM_GROUP_ALLOW_FROM` (user IDs as integers, usernames as strings)
Nested: `TELEGRAM_INLINE_BUTTONS` → `capabilities.inlineButtons`

Docs: https://docs.openclaw.ai/channels/telegram

### WhatsApp env vars (15 total)

Gate: `WHATSAPP_ENABLED=true` (required to activate).

Strings: `WHATSAPP_DM_POLICY`, `WHATSAPP_GROUP_POLICY`, `WHATSAPP_MESSAGE_PREFIX`
Booleans: `WHATSAPP_SELF_CHAT_MODE`, `WHATSAPP_SEND_READ_RECEIPTS`, `WHATSAPP_ACTIONS_REACTIONS`
Numbers: `WHATSAPP_MEDIA_MAX_MB`, `WHATSAPP_HISTORY_LIMIT`, `WHATSAPP_DM_HISTORY_LIMIT`
CSV→Array: `WHATSAPP_ALLOW_FROM`, `WHATSAPP_GROUP_ALLOW_FROM` (E.164 phone numbers)
Nested object: `WHATSAPP_ACK_REACTION_EMOJI`, `WHATSAPP_ACK_REACTION_DIRECT`, `WHATSAPP_ACK_REACTION_GROUP`

### Discord env vars (32 total)

Gate: `DISCORD_BOT_TOKEN` (required to activate).

Strings: `DISCORD_DM_POLICY`, `DISCORD_GROUP_POLICY`, `DISCORD_REPLY_TO_MODE`, `DISCORD_CHUNK_MODE`, `DISCORD_REACTION_NOTIFICATIONS`, `DISCORD_MESSAGE_PREFIX`
Booleans: `DISCORD_ALLOW_BOTS`, `DISCORD_ACTIONS_REACTIONS`, `DISCORD_ACTIONS_STICKERS`, `DISCORD_ACTIONS_EMOJI_UPLOADS`, `DISCORD_ACTIONS_STICKER_UPLOADS`, `DISCORD_ACTIONS_POLLS`, `DISCORD_ACTIONS_PERMISSIONS`, `DISCORD_ACTIONS_MESSAGES`, `DISCORD_ACTIONS_THREADS`, `DISCORD_ACTIONS_PINS`, `DISCORD_ACTIONS_SEARCH`, `DISCORD_ACTIONS_MEMBER_INFO`, `DISCORD_ACTIONS_ROLE_INFO`, `DISCORD_ACTIONS_CHANNEL_INFO`, `DISCORD_ACTIONS_CHANNELS`, `DISCORD_ACTIONS_VOICE_STATUS`, `DISCORD_ACTIONS_EVENTS`, `DISCORD_ACTIONS_ROLES`, `DISCORD_ACTIONS_MODERATION`
Numbers: `DISCORD_TEXT_CHUNK_LIMIT`, `DISCORD_MAX_LINES_PER_MESSAGE`, `DISCORD_MEDIA_MAX_MB`, `DISCORD_HISTORY_LIMIT`, `DISCORD_DM_HISTORY_LIMIT`
CSV→Array: `DISCORD_DM_ALLOW_FROM` (user IDs/names, always strings)

Docs: https://docs.openclaw.ai/channels/discord

### Slack env vars (21 total)

Gate: `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (both required to activate).

Strings: `SLACK_USER_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_MODE`, `SLACK_WEBHOOK_PATH`, `SLACK_DM_POLICY`, `SLACK_GROUP_POLICY`, `SLACK_REPLY_TO_MODE`, `SLACK_REACTION_NOTIFICATIONS`, `SLACK_CHUNK_MODE`, `SLACK_MESSAGE_PREFIX`
Booleans: `SLACK_ALLOW_BOTS`, `SLACK_ACTIONS_REACTIONS`, `SLACK_ACTIONS_MESSAGES`, `SLACK_ACTIONS_PINS`, `SLACK_ACTIONS_MEMBER_INFO`, `SLACK_ACTIONS_EMOJI_LIST`
Numbers: `SLACK_HISTORY_LIMIT`, `SLACK_TEXT_CHUNK_LIMIT`, `SLACK_MEDIA_MAX_MB`
CSV→Array: `SLACK_DM_ALLOW_FROM` (user IDs/handles, always strings)

Docs: https://docs.openclaw.ai/channels/slack

### Hooks env vars (3 total)

Gate: `HOOKS_ENABLED=true` (required to activate).

Strings: `HOOKS_TOKEN`, `HOOKS_PATH`

Merge behavior: same as Telegram/Discord/Slack (merge, custom JSON keys preserved).

`entrypoint.sh` reads the resolved `hooks.path` from `openclaw.json` after `configure.js` runs and generates an nginx `location` block that **bypasses HTTP basic auth** for that path. Openclaw validates hook requests via its own token auth (`Authorization: Bearer <hooks.token>`).

Complex keys (`presets`, `mappings`, `transformsDir`) are JSON-only — not exposed as env vars.

Docs: https://docs.openclaw.ai/automation/webhook

### Browser env vars (7 total)

Gate: `BROWSER_CDP_URL` (required to activate).

Strings: `BROWSER_CDP_URL`, `BROWSER_SNAPSHOT_MODE`, `BROWSER_DEFAULT_PROFILE`
Booleans: `BROWSER_EVALUATE_ENABLED`, `BROWSER_SSRF_ALLOW_COMPOSE_SIDECAR`
Numbers: `BROWSER_REMOTE_TIMEOUT_MS`, `BROWSER_REMOTE_HANDSHAKE_TIMEOUT_MS`

Merge behavior: same as Telegram/Discord/Slack (merge, custom JSON keys preserved).

When the effective CDP hostname is exactly `browser` (the Compose and Coolify sidecar), `configure.js` adds that hostname to `browser.ssrfPolicy.allowedHostnames` after the JSON and dot-notation merge. The value is a string array, which is the shape `openclaw doctor --fix` keeps. `BROWSER_SSRF_ALLOW_COMPOSE_SIDECAR=false` (or `0`) skips the add. `dangerouslyAllowPrivateNetwork` is never set automatically. A hostname already listed in `blockedHostnames` is not re-allowed. Other hostnames and raw private IPs are left unchanged. Compose points CDP at `http://browser:9223` (the sidecar proxy). Chromium's own port `9222` stays on loopback.

Docs: https://docs.openclaw.ai/tools/browser

### Groups/Guilds — JSON config only (all channels)

`channels.<name>.groups` (or `guilds` for Discord) is **never** exposed as an env var, for any channel. Group/guild allowlists with per-group mention gating are too complex for flat env vars. When adding a new channel, keep `groups`/`guilds` in `my-openclaw.json` only.

WhatsApp example:

```json
{
  "channels": {
    "whatsapp": {
      "groups": { "*": {} }
    }
  }
}
```

Use `"*"` key to allow all groups, or specific group JIDs for fine-grained control.

Docs: https://docs.openclaw.ai/channels/whatsapp

## Keeping docs in sync

When changing env vars, configure.js, or project structure, also update `README.md` (architecture overview + full env var reference table).
