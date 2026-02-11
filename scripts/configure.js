#!/usr/bin/env node
// Reads environment variables and writes/patches openclaw.json.
// Supports a user-provided JSON config file (OPENCLAW_CUSTOM_CONFIG) as a base,
// with env vars overriding on top.
// No npm dependencies — uses only Node built-ins.

const fs = require("fs");
const path = require("path");

const STATE_DIR = (process.env.OPENCLAW_STATE_DIR || "/data/.openclaw").replace(/\/+$/, "");
const WORKSPACE_DIR = (process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace").replace(/\/+$/, "");
const CONFIG_FILE = process.env.OPENCLAW_CONFIG_PATH || path.join(STATE_DIR, "openclaw.json");
const CUSTOM_CONFIG = process.env.OPENCLAW_CUSTOM_CONFIG || "/app/config/openclaw.json";

console.log("[configure] state dir:", STATE_DIR);
console.log("[configure] workspace dir:", WORKSPACE_DIR);
console.log("[configure] config file:", CONFIG_FILE);

// Ensure directories exist
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

// Deep merge: source into target. Arrays are replaced, not concatenated.
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === "object" && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// Load config: custom JSON (base) → existing persisted config → env vars (on top)
let config = {};

// 1. Load user-provided custom config as base (if mounted)
let hasCustomConfig = false;
try {
  const customRaw = fs.readFileSync(CUSTOM_CONFIG, "utf8");
  config = JSON.parse(customRaw);
  hasCustomConfig = true;
  console.log("[configure] loaded custom config from", CUSTOM_CONFIG);
} catch {
  // No custom config file — that's fine
}

// 2. Merge persisted config on top (preserves runtime state from previous runs)
try {
  const persisted = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  deepMerge(config, persisted);
  console.log("[configure] merged persisted config from", CONFIG_FILE);
} catch {
  console.log("[configure] no persisted config found");
}

// 3. Env vars override on top (applied below)

// Helper: ensure nested path exists
function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    cur[k] = cur[k] || {};
    cur = cur[k];
  }
  return cur;
}

// ── Gateway ─────────────────────────────────────────────────────────────────
// Env vars override; custom JSON values are preserved when env is not set.

ensure(config, "gateway");
if (process.env.OPENCLAW_GATEWAY_PORT) {
  config.gateway.port = parseInt(process.env.OPENCLAW_GATEWAY_PORT, 10);
} else if (!config.gateway.port) {
  config.gateway.port = 18789;
}
if (!config.gateway.mode) {
  config.gateway.mode = "local";
}

// Gateway token: required via OPENCLAW_GATEWAY_TOKEN env var (enforced by entrypoint.sh)
const token = (process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
if (token) {
  ensure(config, "gateway", "auth");
  config.gateway.auth.mode = "token";
  config.gateway.auth.token = token;
}

// Allow control UI without device pairing (only set defaults, don't overwrite)
ensure(config, "gateway", "controlUi");
if (config.gateway.controlUi.allowInsecureAuth === undefined) {
  config.gateway.controlUi.allowInsecureAuth = true;
}
if (config.gateway.controlUi.enabled === undefined) {
  config.gateway.controlUi.enabled = true;
}

// ── Agents defaults ─────────────────────────────────────────────────────────

ensure(config, "agents", "defaults");
if (!config.agents.defaults.workspace) {
  config.agents.defaults.workspace = WORKSPACE_DIR;
}
ensure(config, "agents", "defaults", "model");

// ── Providers ───────────────────────────────────────────────────────────────
//
// Built-in providers: openclaw already knows their baseUrl, models, and API
// type. We only need to pass the env var — do NOT write models.providers entries
// for these, or openclaw will reject them for missing baseUrl/models fields.
//
// Custom/proxy providers: not in the built-in catalog, so we must supply the
// full config (api, baseUrl, models[]).

// Helper: log + clean up a removed provider (only when no custom JSON is loaded)
function removeProvider(name, label, envHint) {
  if (!hasCustomConfig && config.models?.providers?.[name]) {
    console.log(`[configure] removing ${label} provider (${envHint} not set)`);
    delete config.models.providers[name];
  }
}

// ── Built-in providers (env var only, no models.providers entry) ────────────
// These are auto-detected by openclaw when the env var is set.
const opencodeKey = process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY;

// [envVar, label, providerKey in models.providers]
const builtinProviders = [
  ["ANTHROPIC_API_KEY",    "Anthropic",          "anthropic"],
  ["OPENAI_API_KEY",       "OpenAI",             "openai"],
  ["OPENROUTER_API_KEY",   "OpenRouter",         "openrouter"],
  ["GEMINI_API_KEY",       "Google Gemini",      "google"],
  ["XAI_API_KEY",          "xAI",                "xai"],
  ["GROQ_API_KEY",         "Groq",               "groq"],
  ["MISTRAL_API_KEY",      "Mistral",            "mistral"],
  ["CEREBRAS_API_KEY",     "Cerebras",           "cerebras"],
  ["ZAI_API_KEY",          "ZAI",                "zai"],
  ["AI_GATEWAY_API_KEY",   "Vercel AI Gateway",  "vercel-ai-gateway"],
  ["COPILOT_GITHUB_TOKEN", "GitHub Copilot",     "github-copilot"],
];

for (const [envKey, label, providerKey] of builtinProviders) {
  if (process.env[envKey]) {
    console.log(`[configure] ${label} provider enabled (${envKey} set)`);
  }
  // Clean up stale models.providers entries from previous env-var runs —
  // built-in providers must NOT have models.providers entries.
  // But don't touch entries from custom JSON.
  if (!hasCustomConfig && config.models?.providers?.[providerKey]) {
    console.log(`[configure] removing stale models.providers.${providerKey} (built-in, not needed)`);
    delete config.models.providers[providerKey];
  }
}
if (opencodeKey) {
  console.log("[configure] OpenCode provider enabled (OPENCODE_API_KEY set)");
}
if (!hasCustomConfig && config.models?.providers?.opencode) {
  console.log("[configure] removing stale models.providers.opencode (built-in, not needed)");
  delete config.models.providers.opencode;
}

// ── Custom/proxy providers (need full models.providers config) ──────────────

// Venice AI (OpenAI-compatible)
if (process.env.VENICE_API_KEY) {
  console.log("[configure] configuring Venice AI provider");
  ensure(config, "models", "providers");
  config.models.providers.venice = {
    api: "openai-completions",
    apiKey: process.env.VENICE_API_KEY,
    baseUrl: "https://api.venice.ai/api/v1",
    models: [
      { id: "llama-3.3-70b", name: "Llama 3.3 70B", contextWindow: 128000 },
    ],
  };
} else {
  removeProvider("venice", "Venice AI", "VENICE_API_KEY");
}

// MiniMax (Anthropic-compatible)
if (process.env.MINIMAX_API_KEY) {
  console.log("[configure] configuring MiniMax provider");
  ensure(config, "models", "providers");
  config.models.providers.minimax = {
    api: "anthropic-messages",
    apiKey: process.env.MINIMAX_API_KEY,
    baseUrl: "https://api.minimax.io/anthropic",
    models: [
      { id: "MiniMax-M2.1", name: "MiniMax M2.1", contextWindow: 200000 },
    ],
  };
} else {
  removeProvider("minimax", "MiniMax", "MINIMAX_API_KEY");
}

// Moonshot / Kimi (OpenAI-compatible)
if (process.env.MOONSHOT_API_KEY) {
  console.log("[configure] configuring Moonshot provider");
  ensure(config, "models", "providers");
  config.models.providers.moonshot = {
    api: "openai-completions",
    apiKey: process.env.MOONSHOT_API_KEY,
    baseUrl: (process.env.MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1").replace(/\/+$/, ""),
    models: [
      { id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 128000 },
    ],
  };
} else {
  removeProvider("moonshot", "Moonshot", "MOONSHOT_API_KEY");
}

// Kimi Coding (Anthropic-compatible)
if (process.env.KIMI_API_KEY) {
  console.log("[configure] configuring Kimi Coding provider");
  ensure(config, "models", "providers");
  config.models.providers["kimi-coding"] = {
    api: "anthropic-messages",
    apiKey: process.env.KIMI_API_KEY,
    baseUrl: (process.env.KIMI_BASE_URL || "https://api.moonshot.ai/anthropic").replace(/\/+$/, ""),
    models: [
      { id: "k2p5", name: "Kimi K2P5", contextWindow: 128000 },
    ],
  };
} else {
  removeProvider("kimi-coding", "Kimi Coding", "KIMI_API_KEY");
}

// Synthetic (Anthropic-compatible)
if (process.env.SYNTHETIC_API_KEY) {
  console.log("[configure] configuring Synthetic provider");
  ensure(config, "models", "providers");
  config.models.providers.synthetic = {
    api: "anthropic-messages",
    apiKey: process.env.SYNTHETIC_API_KEY,
    baseUrl: "https://api.synthetic.new/anthropic",
    models: [
      { id: "hf:MiniMaxAI/MiniMax-M2.1", name: "MiniMax M2.1", contextWindow: 192000 },
    ],
  };
} else {
  removeProvider("synthetic", "Synthetic", "SYNTHETIC_API_KEY");
}

// Xiaomi MiMo (Anthropic-compatible)
if (process.env.XIAOMI_API_KEY) {
  console.log("[configure] configuring Xiaomi MiMo provider");
  ensure(config, "models", "providers");
  config.models.providers.xiaomi = {
    api: "anthropic-messages",
    apiKey: process.env.XIAOMI_API_KEY,
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    models: [
      { id: "mimo-v2-flash", name: "MiMo v2 Flash", contextWindow: 262144 },
    ],
  };
} else {
  removeProvider("xiaomi", "Xiaomi", "XIAOMI_API_KEY");
}

// Amazon Bedrock (uses AWS credential chain)
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  console.log("[configure] configuring Amazon Bedrock provider");
  ensure(config, "models", "providers");
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  config.models.providers["amazon-bedrock"] = {
    api: "bedrock-converse-stream",
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    models: [
      { id: "anthropic.claude-opus-4-5-20251101-v1:0", name: "Claude Opus 4.5 (Bedrock)", contextWindow: 200000 },
      { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5 (Bedrock)", contextWindow: 200000 },
    ],
  };
  ensure(config, "models");
  // providerFilter must be an array; env var may be JSON array, CSV, or plain string
  let providerFilter = ["anthropic"];
  if (process.env.BEDROCK_PROVIDER_FILTER) {
    try {
      const parsed = JSON.parse(process.env.BEDROCK_PROVIDER_FILTER);
      providerFilter = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      providerFilter = process.env.BEDROCK_PROVIDER_FILTER.split(",").map(s => s.trim());
    }
  }
  config.models.bedrockDiscovery = {
    enabled: true,
    region,
    providerFilter,
    refreshInterval: 3600,
  };
} else if (!hasCustomConfig && config.models?.providers?.["amazon-bedrock"]) {
  console.log("[configure] removing Amazon Bedrock provider (AWS credentials not set)");
  delete config.models.providers["amazon-bedrock"];
  delete config.models.bedrockDiscovery;
}

// Ollama (local, no API key needed)
const ollamaUrl = (process.env.OLLAMA_BASE_URL || "").replace(/\/+$/, "");
if (ollamaUrl) {
  console.log("[configure] configuring Ollama provider");
  ensure(config, "models", "providers");
  const base = ollamaUrl.endsWith("/v1") ? ollamaUrl : `${ollamaUrl}/v1`;
  config.models.providers.ollama = {
    api: "openai-completions",
    baseUrl: base,
    models: [
      { id: "llama3.3", name: "Llama 3.3", contextWindow: 128000 },
    ],
  };
} else {
  removeProvider("ollama", "Ollama", "OLLAMA_BASE_URL");
}

// ── Primary model selection (first available provider wins) ─────────────────
const primaryCandidates = [
  [process.env.ANTHROPIC_API_KEY,      "anthropic/claude-opus-4-5-20251101"],
  [process.env.OPENAI_API_KEY,         "openai/gpt-5.2"],
  [process.env.OPENROUTER_API_KEY,     "openrouter/anthropic/claude-opus-4-5"],
  [process.env.GEMINI_API_KEY,         "google/gemini-2.5-pro"],
  [opencodeKey,                        "opencode/claude-opus-4-5"],
  [process.env.COPILOT_GITHUB_TOKEN,   "github-copilot/claude-opus-4-5"],
  [process.env.XAI_API_KEY,            "xai/grok-3"],
  [process.env.GROQ_API_KEY,           "groq/llama-3.3-70b-versatile"],
  [process.env.MISTRAL_API_KEY,        "mistral/mistral-large-latest"],
  [process.env.CEREBRAS_API_KEY,       "cerebras/llama-3.3-70b"],
  [process.env.VENICE_API_KEY,         "venice/llama-3.3-70b"],
  [process.env.MOONSHOT_API_KEY,       "moonshot/kimi-k2.5"],
  [process.env.KIMI_API_KEY,           "kimi-coding/k2p5"],
  [process.env.MINIMAX_API_KEY,        "minimax/MiniMax-M2.1"],
  [process.env.SYNTHETIC_API_KEY,      "synthetic/hf:MiniMaxAI/MiniMax-M2.1"],
  [process.env.ZAI_API_KEY,            "zai/glm-4.7"],
  [process.env.AI_GATEWAY_API_KEY,     "vercel-ai-gateway/anthropic/claude-opus-4.5"],
  [process.env.XIAOMI_API_KEY,         "xiaomi/mimo-v2-flash"],
  [process.env.AWS_ACCESS_KEY_ID,      "amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0"],
  [ollamaUrl,                          "ollama/llama3.3"],
];
if (process.env.OPENCLAW_PRIMARY_MODEL) {
  // Explicit env var override
  config.agents.defaults.model.primary = process.env.OPENCLAW_PRIMARY_MODEL;
  console.log(`[configure] primary model (override): ${process.env.OPENCLAW_PRIMARY_MODEL}`);
} else if (config.agents.defaults.model.primary) {
  // Already set (from custom JSON or persisted config) — keep it
  console.log(`[configure] primary model (from config): ${config.agents.defaults.model.primary}`);
} else {
  // Auto-select from first available provider
  for (const [key, model] of primaryCandidates) {
    if (key) {
      config.agents.defaults.model.primary = model;
      console.log(`[configure] primary model (auto): ${model}`);
      break;
    }
  }
}

// ── Deepgram (audio transcription) ──────────────────────────────────────────
if (process.env.DEEPGRAM_API_KEY) {
  console.log("[configure] configuring Deepgram transcription (from env)");
  ensure(config, "tools", "media", "audio");
  config.tools.media.audio.enabled = true;
  config.tools.media.audio.models = [{ provider: "deepgram", model: "nova-3" }];
} else if (config.tools?.media?.audio) {
  console.log("[configure] Deepgram transcription configured (from custom JSON)");
}

// ── Channels ────────────────────────────────────────────────────────────────
// Env vars override custom JSON values. If neither env var nor custom JSON
// provides a channel, it stays unconfigured. We never remove channels that
// came from the custom JSON.

if (process.env.TELEGRAM_BOT_TOKEN) {
  console.log("[configure] configuring Telegram channel (from env)");
  ensure(config, "channels");
  const tg = config.channels.telegram = config.channels.telegram || {};
  tg.botToken = process.env.TELEGRAM_BOT_TOKEN;
  tg.enabled = true;

  // strings
  if (process.env.TELEGRAM_DM_POLICY)              tg.dmPolicy = process.env.TELEGRAM_DM_POLICY;
  if (process.env.TELEGRAM_GROUP_POLICY)            tg.groupPolicy = process.env.TELEGRAM_GROUP_POLICY;
  if (process.env.TELEGRAM_REPLY_TO_MODE)           tg.replyToMode = process.env.TELEGRAM_REPLY_TO_MODE;
  if (process.env.TELEGRAM_CHUNK_MODE)              tg.chunkMode = process.env.TELEGRAM_CHUNK_MODE;
  if (process.env.TELEGRAM_STREAM_MODE)             tg.streamMode = process.env.TELEGRAM_STREAM_MODE;
  if (process.env.TELEGRAM_REACTION_NOTIFICATIONS)  tg.reactionNotifications = process.env.TELEGRAM_REACTION_NOTIFICATIONS;
  if (process.env.TELEGRAM_REACTION_LEVEL)          tg.reactionLevel = process.env.TELEGRAM_REACTION_LEVEL;
  if (process.env.TELEGRAM_PROXY)                   tg.proxy = process.env.TELEGRAM_PROXY;
  if (process.env.TELEGRAM_WEBHOOK_URL)             tg.webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
  if (process.env.TELEGRAM_WEBHOOK_SECRET)          tg.webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (process.env.TELEGRAM_WEBHOOK_PATH)            tg.webhookPath = process.env.TELEGRAM_WEBHOOK_PATH;
  if (process.env.TELEGRAM_MESSAGE_PREFIX)          tg.messagePrefix = process.env.TELEGRAM_MESSAGE_PREFIX;

  // booleans
  if (process.env.TELEGRAM_LINK_PREVIEW)            tg.linkPreview = process.env.TELEGRAM_LINK_PREVIEW !== "false";
  if (process.env.TELEGRAM_ACTIONS_REACTIONS)  {
    ensure(tg, "actions");
    tg.actions.reactions = process.env.TELEGRAM_ACTIONS_REACTIONS !== "false";
  }
  if (process.env.TELEGRAM_ACTIONS_STICKER)    {
    ensure(tg, "actions");
    tg.actions.sticker = process.env.TELEGRAM_ACTIONS_STICKER === "true";
  }

  // numbers
  if (process.env.TELEGRAM_TEXT_CHUNK_LIMIT)        tg.textChunkLimit = parseInt(process.env.TELEGRAM_TEXT_CHUNK_LIMIT, 10);
  if (process.env.TELEGRAM_MEDIA_MAX_MB)            tg.mediaMaxMb = parseInt(process.env.TELEGRAM_MEDIA_MAX_MB, 10);

  // csv → array (user IDs as integers, usernames as strings)
  if (process.env.TELEGRAM_ALLOW_FROM) {
    tg.allowFrom = process.env.TELEGRAM_ALLOW_FROM.split(",").map(s => {
      const trimmed = s.trim();
      const num = Number(trimmed);
      return Number.isInteger(num) ? num : trimmed;
    });
  }
  if (process.env.TELEGRAM_GROUP_ALLOW_FROM) {
    tg.groupAllowFrom = process.env.TELEGRAM_GROUP_ALLOW_FROM.split(",").map(s => {
      const trimmed = s.trim();
      const num = Number(trimmed);
      return Number.isInteger(num) ? num : trimmed;
    });
  }

  // nested: capabilities
  if (process.env.TELEGRAM_INLINE_BUTTONS) {
    ensure(tg, "capabilities");
    tg.capabilities.inlineButtons = process.env.TELEGRAM_INLINE_BUTTONS;
  }
} else if (config.channels?.telegram) {
  console.log("[configure] Telegram channel configured (from custom JSON)");
}

if (process.env.DISCORD_BOT_TOKEN) {
  console.log("[configure] configuring Discord channel (from env)");
  ensure(config, "channels");
  const dc = config.channels.discord = config.channels.discord || {};
  dc.token = process.env.DISCORD_BOT_TOKEN;
  dc.enabled = true;

  // strings
  if (process.env.DISCORD_DM_POLICY)              { ensure(dc, "dm"); dc.dm.policy = process.env.DISCORD_DM_POLICY; }
  if (process.env.DISCORD_GROUP_POLICY)            dc.groupPolicy = process.env.DISCORD_GROUP_POLICY;
  if (process.env.DISCORD_REPLY_TO_MODE)           dc.replyToMode = process.env.DISCORD_REPLY_TO_MODE;
  if (process.env.DISCORD_CHUNK_MODE)              dc.chunkMode = process.env.DISCORD_CHUNK_MODE;
  if (process.env.DISCORD_REACTION_NOTIFICATIONS)  dc.reactionNotifications = process.env.DISCORD_REACTION_NOTIFICATIONS;
  if (process.env.DISCORD_MESSAGE_PREFIX)           dc.messagePrefix = process.env.DISCORD_MESSAGE_PREFIX;

  // booleans (default-true → !== "false", default-false → === "true")
  if (process.env.DISCORD_ALLOW_BOTS)              dc.allowBots = process.env.DISCORD_ALLOW_BOTS === "true";
  if (process.env.DISCORD_ACTIONS_REACTIONS)        { ensure(dc, "actions"); dc.actions.reactions = process.env.DISCORD_ACTIONS_REACTIONS !== "false"; }
  if (process.env.DISCORD_ACTIONS_STICKERS)         { ensure(dc, "actions"); dc.actions.stickers = process.env.DISCORD_ACTIONS_STICKERS !== "false"; }
  if (process.env.DISCORD_ACTIONS_EMOJI_UPLOADS)    { ensure(dc, "actions"); dc.actions.emojiUploads = process.env.DISCORD_ACTIONS_EMOJI_UPLOADS !== "false"; }
  if (process.env.DISCORD_ACTIONS_STICKER_UPLOADS)  { ensure(dc, "actions"); dc.actions.stickerUploads = process.env.DISCORD_ACTIONS_STICKER_UPLOADS !== "false"; }
  if (process.env.DISCORD_ACTIONS_POLLS)            { ensure(dc, "actions"); dc.actions.polls = process.env.DISCORD_ACTIONS_POLLS !== "false"; }
  if (process.env.DISCORD_ACTIONS_PERMISSIONS)      { ensure(dc, "actions"); dc.actions.permissions = process.env.DISCORD_ACTIONS_PERMISSIONS !== "false"; }
  if (process.env.DISCORD_ACTIONS_MESSAGES)         { ensure(dc, "actions"); dc.actions.messages = process.env.DISCORD_ACTIONS_MESSAGES !== "false"; }
  if (process.env.DISCORD_ACTIONS_THREADS)          { ensure(dc, "actions"); dc.actions.threads = process.env.DISCORD_ACTIONS_THREADS !== "false"; }
  if (process.env.DISCORD_ACTIONS_PINS)             { ensure(dc, "actions"); dc.actions.pins = process.env.DISCORD_ACTIONS_PINS !== "false"; }
  if (process.env.DISCORD_ACTIONS_SEARCH)           { ensure(dc, "actions"); dc.actions.search = process.env.DISCORD_ACTIONS_SEARCH !== "false"; }
  if (process.env.DISCORD_ACTIONS_MEMBER_INFO)      { ensure(dc, "actions"); dc.actions.memberInfo = process.env.DISCORD_ACTIONS_MEMBER_INFO !== "false"; }
  if (process.env.DISCORD_ACTIONS_ROLE_INFO)        { ensure(dc, "actions"); dc.actions.roleInfo = process.env.DISCORD_ACTIONS_ROLE_INFO !== "false"; }
  if (process.env.DISCORD_ACTIONS_CHANNEL_INFO)     { ensure(dc, "actions"); dc.actions.channelInfo = process.env.DISCORD_ACTIONS_CHANNEL_INFO !== "false"; }
  if (process.env.DISCORD_ACTIONS_CHANNELS)         { ensure(dc, "actions"); dc.actions.channels = process.env.DISCORD_ACTIONS_CHANNELS !== "false"; }
  if (process.env.DISCORD_ACTIONS_VOICE_STATUS)     { ensure(dc, "actions"); dc.actions.voiceStatus = process.env.DISCORD_ACTIONS_VOICE_STATUS !== "false"; }
  if (process.env.DISCORD_ACTIONS_EVENTS)           { ensure(dc, "actions"); dc.actions.events = process.env.DISCORD_ACTIONS_EVENTS !== "false"; }
  if (process.env.DISCORD_ACTIONS_ROLES)            { ensure(dc, "actions"); dc.actions.roles = process.env.DISCORD_ACTIONS_ROLES === "true"; }
  if (process.env.DISCORD_ACTIONS_MODERATION)       { ensure(dc, "actions"); dc.actions.moderation = process.env.DISCORD_ACTIONS_MODERATION === "true"; }

  // numbers
  if (process.env.DISCORD_TEXT_CHUNK_LIMIT)         dc.textChunkLimit = parseInt(process.env.DISCORD_TEXT_CHUNK_LIMIT, 10);
  if (process.env.DISCORD_MAX_LINES_PER_MESSAGE)    dc.maxLinesPerMessage = parseInt(process.env.DISCORD_MAX_LINES_PER_MESSAGE, 10);
  if (process.env.DISCORD_MEDIA_MAX_MB)             dc.mediaMaxMb = parseInt(process.env.DISCORD_MEDIA_MAX_MB, 10);
  if (process.env.DISCORD_HISTORY_LIMIT)            dc.historyLimit = parseInt(process.env.DISCORD_HISTORY_LIMIT, 10);
  if (process.env.DISCORD_DM_HISTORY_LIMIT)         dc.dmHistoryLimit = parseInt(process.env.DISCORD_DM_HISTORY_LIMIT, 10);

  // csv → array (always strings)
  if (process.env.DISCORD_DM_ALLOW_FROM) {
    ensure(dc, "dm");
    dc.dm.allowFrom = process.env.DISCORD_DM_ALLOW_FROM.split(",").map(s => s.trim());
  }
} else if (config.channels?.discord) {
  console.log("[configure] Discord channel configured (from custom JSON)");
}

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  console.log("[configure] configuring Slack channel (from env)");
  ensure(config, "channels");
  const sl = config.channels.slack = config.channels.slack || {};
  sl.botToken = process.env.SLACK_BOT_TOKEN;
  sl.appToken = process.env.SLACK_APP_TOKEN;
  sl.enabled = true;

  // strings
  if (process.env.SLACK_USER_TOKEN)              sl.userToken = process.env.SLACK_USER_TOKEN;
  if (process.env.SLACK_SIGNING_SECRET)          sl.signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (process.env.SLACK_MODE)                    sl.mode = process.env.SLACK_MODE;
  if (process.env.SLACK_WEBHOOK_PATH)            sl.webhookPath = process.env.SLACK_WEBHOOK_PATH;
  if (process.env.SLACK_DM_POLICY)               { ensure(sl, "dm"); sl.dm.policy = process.env.SLACK_DM_POLICY; }
  if (process.env.SLACK_GROUP_POLICY)            sl.groupPolicy = process.env.SLACK_GROUP_POLICY;
  if (process.env.SLACK_REPLY_TO_MODE)           sl.replyToMode = process.env.SLACK_REPLY_TO_MODE;
  if (process.env.SLACK_REACTION_NOTIFICATIONS)  sl.reactionNotifications = process.env.SLACK_REACTION_NOTIFICATIONS;
  if (process.env.SLACK_CHUNK_MODE)              sl.chunkMode = process.env.SLACK_CHUNK_MODE;
  if (process.env.SLACK_MESSAGE_PREFIX)          sl.messagePrefix = process.env.SLACK_MESSAGE_PREFIX;

  // booleans (default-true → !== "false", default-false → === "true")
  if (process.env.SLACK_ALLOW_BOTS)              sl.allowBots = process.env.SLACK_ALLOW_BOTS === "true";
  if (process.env.SLACK_ACTIONS_REACTIONS)        { ensure(sl, "actions"); sl.actions.reactions = process.env.SLACK_ACTIONS_REACTIONS !== "false"; }
  if (process.env.SLACK_ACTIONS_MESSAGES)         { ensure(sl, "actions"); sl.actions.messages = process.env.SLACK_ACTIONS_MESSAGES !== "false"; }
  if (process.env.SLACK_ACTIONS_PINS)             { ensure(sl, "actions"); sl.actions.pins = process.env.SLACK_ACTIONS_PINS !== "false"; }
  if (process.env.SLACK_ACTIONS_MEMBER_INFO)      { ensure(sl, "actions"); sl.actions.memberInfo = process.env.SLACK_ACTIONS_MEMBER_INFO !== "false"; }
  if (process.env.SLACK_ACTIONS_EMOJI_LIST)       { ensure(sl, "actions"); sl.actions.emojiList = process.env.SLACK_ACTIONS_EMOJI_LIST !== "false"; }

  // numbers
  if (process.env.SLACK_HISTORY_LIMIT)           sl.historyLimit = parseInt(process.env.SLACK_HISTORY_LIMIT, 10);
  if (process.env.SLACK_TEXT_CHUNK_LIMIT)        sl.textChunkLimit = parseInt(process.env.SLACK_TEXT_CHUNK_LIMIT, 10);
  if (process.env.SLACK_MEDIA_MAX_MB)            sl.mediaMaxMb = parseInt(process.env.SLACK_MEDIA_MAX_MB, 10);

  // csv → array (always strings)
  if (process.env.SLACK_DM_ALLOW_FROM) {
    ensure(sl, "dm");
    sl.dm.allowFrom = process.env.SLACK_DM_ALLOW_FROM.split(",").map(s => s.trim());
  }
} else if (config.channels?.slack) {
  console.log("[configure] Slack channel configured (from custom JSON)");
}

// WhatsApp (no bot token — uses QR/pairing code auth at runtime)
if (process.env.WHATSAPP_ENABLED === "true" || process.env.WHATSAPP_ENABLED === "1") {
  console.log("[configure] configuring WhatsApp channel (from env)");
  ensure(config, "channels");
  const wa = config.channels.whatsapp = {}; // full overwrite — env vars are authoritative
  wa.enabled = true;

  // strings
  if (process.env.WHATSAPP_DM_POLICY)        wa.dmPolicy = process.env.WHATSAPP_DM_POLICY;
  if (process.env.WHATSAPP_GROUP_POLICY)      wa.groupPolicy = process.env.WHATSAPP_GROUP_POLICY;
  if (process.env.WHATSAPP_MESSAGE_PREFIX)    wa.messagePrefix = process.env.WHATSAPP_MESSAGE_PREFIX;

  // booleans
  if (process.env.WHATSAPP_SELF_CHAT_MODE)    wa.selfChatMode = process.env.WHATSAPP_SELF_CHAT_MODE === "true";
  if (process.env.WHATSAPP_SEND_READ_RECEIPTS) wa.sendReadReceipts = process.env.WHATSAPP_SEND_READ_RECEIPTS !== "false";
  if (process.env.WHATSAPP_ACTIONS_REACTIONS) {
    ensure(wa, "actions");
    wa.actions.reactions = process.env.WHATSAPP_ACTIONS_REACTIONS !== "false";
  }

  // numbers
  if (process.env.WHATSAPP_MEDIA_MAX_MB)      wa.mediaMaxMb = parseInt(process.env.WHATSAPP_MEDIA_MAX_MB, 10);
  if (process.env.WHATSAPP_HISTORY_LIMIT)     wa.historyLimit = parseInt(process.env.WHATSAPP_HISTORY_LIMIT, 10);
  if (process.env.WHATSAPP_DM_HISTORY_LIMIT)  wa.dmHistoryLimit = parseInt(process.env.WHATSAPP_DM_HISTORY_LIMIT, 10);

  // csv → array (E.164 phone numbers, always strings)
  if (process.env.WHATSAPP_ALLOW_FROM)        wa.allowFrom = process.env.WHATSAPP_ALLOW_FROM.split(",").map(s => s.trim());
  if (process.env.WHATSAPP_GROUP_ALLOW_FROM)  wa.groupAllowFrom = process.env.WHATSAPP_GROUP_ALLOW_FROM.split(",").map(s => s.trim());

  // ack reaction (nested object)
  if (process.env.WHATSAPP_ACK_REACTION_EMOJI || process.env.WHATSAPP_ACK_REACTION_DIRECT || process.env.WHATSAPP_ACK_REACTION_GROUP) {
    wa.ackReaction = wa.ackReaction || {};
    if (process.env.WHATSAPP_ACK_REACTION_EMOJI)  wa.ackReaction.emoji = process.env.WHATSAPP_ACK_REACTION_EMOJI;
    if (process.env.WHATSAPP_ACK_REACTION_DIRECT) wa.ackReaction.direct = process.env.WHATSAPP_ACK_REACTION_DIRECT !== "false";
    if (process.env.WHATSAPP_ACK_REACTION_GROUP)  wa.ackReaction.group = process.env.WHATSAPP_ACK_REACTION_GROUP;
  }
} else if (config.channels?.whatsapp) {
  console.log("[configure] WhatsApp channel configured (from custom JSON)");
}

// Clean up empty channels object (from previous config versions)
if (config.channels && Object.keys(config.channels).length === 0) {
  delete config.channels;
}

// ── Hooks (webhook automation) ───────────────────────────────────────────────
if (process.env.HOOKS_ENABLED === "true" || process.env.HOOKS_ENABLED === "1") {
  console.log("[configure] configuring hooks (from env)");
  ensure(config, "hooks");
  config.hooks.enabled = true;
  if (process.env.HOOKS_TOKEN) config.hooks.token = process.env.HOOKS_TOKEN;
  if (process.env.HOOKS_PATH)  config.hooks.path = process.env.HOOKS_PATH;
} else if (config.hooks) {
  console.log("[configure] hooks configured (from custom JSON)");
}

// ── Browser tool (remote CDP) ────────────────────────────────────────────────
if (process.env.BROWSER_CDP_URL) {
  console.log("[configure] configuring browser tool (remote CDP)");
  ensure(config, "browser");
  const br = config.browser;
  br.cdpUrl = process.env.BROWSER_CDP_URL;

  if (process.env.BROWSER_EVALUATE_ENABLED !== undefined)
    br.evaluateEnabled = process.env.BROWSER_EVALUATE_ENABLED === "true";
  if (process.env.BROWSER_SNAPSHOT_MODE) {
    ensure(br, "snapshotDefaults");
    br.snapshotDefaults.mode = process.env.BROWSER_SNAPSHOT_MODE;
  }
  if (process.env.BROWSER_REMOTE_TIMEOUT_MS)
    br.remoteCdpTimeoutMs = parseInt(process.env.BROWSER_REMOTE_TIMEOUT_MS, 10);
  if (process.env.BROWSER_REMOTE_HANDSHAKE_TIMEOUT_MS)
    br.remoteCdpHandshakeTimeoutMs = parseInt(process.env.BROWSER_REMOTE_HANDSHAKE_TIMEOUT_MS, 10);
  if (process.env.BROWSER_DEFAULT_PROFILE)
    br.defaultProfile = process.env.BROWSER_DEFAULT_PROFILE;
} else if (config.browser) {
  console.log("[configure] browser configured (from custom JSON)");
}

// ── Validate: at least one provider API key env var must be set ──────────────
// All providers (built-in and custom) read API keys from env vars, not from JSON.
const hasProvider =
  builtinProviders.some(([envKey]) => process.env[envKey]) ||
  !!opencodeKey ||
  !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
  !!ollamaUrl ||
  // Custom proxy providers also need env var keys
  !!process.env.VENICE_API_KEY || !!process.env.MINIMAX_API_KEY ||
  !!process.env.MOONSHOT_API_KEY || !!process.env.KIMI_API_KEY ||
  !!process.env.SYNTHETIC_API_KEY || !!process.env.XIAOMI_API_KEY;

if (!hasProvider) {
  console.error("[configure] ERROR: No AI provider API key set.");
  console.error("[configure] Providers require an env var — API keys are never read from the JSON config.");
  console.error("[configure] Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY,");
  console.error("[configure]   XAI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, CEREBRAS_API_KEY, ZAI_API_KEY,");
  console.error("[configure]   AI_GATEWAY_API_KEY, OPENCODE_API_KEY, COPILOT_GITHUB_TOKEN, VENICE_API_KEY,");
  console.error("[configure]   MOONSHOT_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY, SYNTHETIC_API_KEY, XIAOMI_API_KEY,");
  console.error("[configure]   AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY (Bedrock), or OLLAMA_BASE_URL (local)");
  process.exit(1);
}

// ── Write config ────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
console.log("[configure] config written to", CONFIG_FILE);
