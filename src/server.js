import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import {
  chatSyncDbConfigured,
  chatSyncEnsureSchema,
  chatSyncUpsertSession,
  chatSyncDeleteMessagesBySession,
  chatSyncInsertMessages,
  chatSyncEmbedMessages,
  chatSyncSearchMessages,
  chatSyncStats,
  chatSyncGetFileSizes,
  chatSyncDeleteSession,
  chatSyncListSessions,
  chatSyncGetMessages,
  getUserPrefs,
  setUserPrefs,
} from "./chat-sync-db.js";
import { createVoiceDemo } from "./voice-demo.js";

// ─────────────────────────────────────────────
// Environment & Paths
// ─────────────────────────────────────────────

const PORT = Number.parseInt(process.env.OPENCLAW_PUBLIC_PORT ?? process.env.PORT ?? "8080", 10);

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || path.join(STATE_DIR, "workspace");
const SETUP_USERNAME = process.env.SETUP_USERNAME?.trim() || "admin";
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;
  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch { /* ignore */ }
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch { /* best-effort */ }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const GATEWAY_TARGET = `http://127.0.0.1:${INTERNAL_GATEWAY_PORT}`;

function resolveOpenclawEntry() {
  const configured = process.env.OPENCLAW_ENTRY?.trim();
  if (configured) return configured;
  const candidates = [
    "/openclaw/dist/entry.js",
    "/opt/homebrew/bin/openclaw",
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore fs lookup failures and continue to the next candidate.
    }
  }
  return candidates[0];
}

function gatewaySourceConfigPath() {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(STATE_DIR, "openclaw.json");
}

function buildGatewayConfigPath() {
  const sourcePath = gatewaySourceConfigPath();
  try {
    if (!fs.existsSync(sourcePath)) return sourcePath;
    const cfg = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    let changed = false;
    const memoryInject = cfg?.hooks?.internal?.entries?.["memory-inject"];
    if (memoryInject && typeof memoryInject === "object") {
      for (const key of ["daysToLoad", "maxTokens", "byChannel"]) {
        if (Object.prototype.hasOwnProperty.call(memoryInject, key)) {
          delete memoryInject[key];
          changed = true;
        }
      }
    }
    const whatsapp = cfg?.channels?.whatsapp;
    if (whatsapp && typeof whatsapp === "object" && Object.prototype.hasOwnProperty.call(whatsapp, "enabled")) {
      delete whatsapp.enabled;
      changed = true;
    }
    if (!changed) return sourcePath;
    const compatPath = path.join(STATE_DIR, "openclaw.gateway.compat.json");
    fs.mkdirSync(path.dirname(compatPath), { recursive: true });
    fs.writeFileSync(compatPath, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    return compatPath;
  } catch {
    return sourcePath;
  }
}

const OPENCLAW_ENTRY = resolveOpenclawEntry();
const GATEWAY_CONFIG_PATH = buildGatewayConfigPath();

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function runCmd(args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn("node", args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        OPENCLAW_CONFIG_PATH: GATEWAY_CONFIG_PATH,
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => { stdout += d.toString("utf8"); });
    proc.stderr?.on("data", (d) => { stderr += d.toString("utf8"); });
    proc.on("error", (err) => {
      resolve({ code: 127, output: stdout + stderr + `\n[spawn error] ${String(err)}\n`, stdout, stderr });
    });
    proc.on("close", (code) => resolve({ code: code ?? 0, output: stdout + stderr, stdout, stderr }));
  });
}

function configPath() {
  return gatewaySourceConfigPath();
}

function isConfigured() {
  try { return fs.existsSync(configPath()); } catch { return false; }
}

// ─────────────────────────────────────────────
// Workspace Seeding (hash-based smart copy)
// ─────────────────────────────────────────────

const BOT_MANAGED_FILES = new Set(["WORK_LOG.md"]);
const BOT_MANAGED_DIRS = new Set(["memory", "output"]);
const USER_PROFILE_BLOCK_START = "<!-- PM_AGENT_PROFILE_START -->";
const USER_PROFILE_BLOCK_END = "<!-- PM_AGENT_PROFILE_END -->";

function fileHash(filePath) {
  try {
    return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
  } catch { return null; }
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      if (BOT_MANAGED_DIRS.has(item)) {
        fs.mkdirSync(destPath, { recursive: true });
        for (const f of fs.readdirSync(srcPath)) {
          const sp = path.join(srcPath, f);
          const dp = path.join(destPath, f);
          if (fs.statSync(sp).isFile() && !fs.existsSync(dp)) {
            fs.copyFileSync(sp, dp);
            console.log(`[workspace] seeded ${f}`);
          }
        }
        continue;
      }
      copyDirRecursive(srcPath, destPath);
    } else {
      if (BOT_MANAGED_FILES.has(item) && fs.existsSync(destPath)) continue;
      if (fs.existsSync(destPath) && fileHash(srcPath) === fileHash(destPath)) continue;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      console.log(`[workspace] deployed ${item}`);
    }
  }
}

function seedWorkspace() {
  console.log("[workspace] seeding defaults...");
  copyDirRecursive("/app/workspace-defaults", WORKSPACE_DIR);
  console.log("[workspace] seeding complete");
}

function normalizePersonName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function getDefaultUserProfile(names = {}) {
  const firstName = normalizePersonName(names.firstName);
  const lastName = normalizePersonName(names.lastName);
  return { firstName, lastName };
}

function buildUserProfileBlock(names = {}) {
  const { firstName, lastName } = getDefaultUserProfile(names);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || "not set";
  const preferredName = firstName || "not set";
  return [
    USER_PROFILE_BLOCK_START,
    "## User Profile",
    "",
    `- **Name:** ${fullName}`,
    `- **What to call them:** ${preferredName}`,
    "- **Role:** Product manager",
    "- **Primary focus:** PRDs, roadmap items, blockers, priorities, and product decisions",
    "- **Working style:** concise, practical, direct",
    "- **Memory rule:** check persisted chat history before saying you don't remember prior conversations",
    "- **When name is not set:** use a neutral address and do not invent one",
    USER_PROFILE_BLOCK_END,
  ].join("\n");
}

function buildDefaultUserFile(names = {}) {
  return [
    "# Standing Instructions",
    "",
    "_This file contains permanent rules and preferences set by the team. Loaded every session._",
    "",
    buildUserProfileBlock(names),
    "",
  ].join("\n");
}

function isPlaceholderUserFile(content) {
  const text = String(content ?? "").trim();
  if (!text) return true;
  return (
    text.includes("# USER.md - About Your Human") ||
    text.includes("Learn about the person you're helping") ||
    text.includes("What to call them:") ||
    text.includes("Respect the difference.") ||
    text === "# Standing Instructions"
  );
}

function replaceBetween(content, startMarker, endMarker, replacement) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return content;
  return `${content.slice(0, start)}${replacement}${content.slice(end + endMarker.length)}`;
}

function syncUserProfileFile(names = {}, { force = false } = {}) {
  const userPath = path.join(WORKSPACE_DIR, "USER.md");
  const nextBlock = buildUserProfileBlock(names);
  const nextDefault = buildDefaultUserFile(names);
  let current = "";
  try {
    current = fs.readFileSync(userPath, "utf8");
  } catch {
    current = "";
  }

  let next = current;
  if (!current || isPlaceholderUserFile(current)) {
    next = nextDefault;
  } else if (current.includes(USER_PROFILE_BLOCK_START) && current.includes(USER_PROFILE_BLOCK_END)) {
    next = replaceBetween(current, USER_PROFILE_BLOCK_START, USER_PROFILE_BLOCK_END, nextBlock);
  } else if (force) {
    next = `${current.trimEnd()}\n\n${nextBlock}\n`;
  } else {
    return;
  }

  if (next === current) return;
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, next, "utf8");
  console.log(`[workspace] synced USER.md profile (${getDefaultUserProfile(names).firstName || "generic"})`);
}

async function syncStoredUserProfile() {
  const prefs = await getUserPrefs();
  syncUserProfileFile({ firstName: prefs.firstName, lastName: prefs.lastName }, { force: true });
}

// ─────────────────────────────────────────────
// Memory Merges
// ─────────────────────────────────────────────

function injectCurrentDate() {
  const agentsPath = path.join(WORKSPACE_DIR, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) return;
  const agents = fs.readFileSync(agentsPath, "utf8");
  const marker = "<!-- CURRENT_DATE -->";
  const now = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const dateLine = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const block = `${marker}\n**Today is ${dateLine}.**`;
  const updated = agents.includes(marker)
    ? agents.replace(new RegExp(`${marker}[^\\n]*\\n[^\\n]*`), block)
    : agents.replace(/^(# .*)$/m, `$1\n\n${block}`);
  if (updated !== agents) fs.writeFileSync(agentsPath, updated, "utf8");
  console.log(`[date] injected: ${dateLine}`);
}

function mergeWorkLog() {
  const workLogPath = path.join(WORKSPACE_DIR, "WORK_LOG.md");
  const agentsPath = path.join(WORKSPACE_DIR, "AGENTS.md");
  if (!fs.existsSync(workLogPath) || !fs.existsSync(agentsPath)) return;
  let workLog = fs.readFileSync(workLogPath, "utf8").trim();
  if (!workLog) return;
  if (workLog.length > 3000) {
    const trimmed = workLog.slice(workLog.length - 3000);
    const nl = trimmed.indexOf("\n");
    workLog = nl >= 0 ? trimmed.slice(nl + 1) : trimmed;
  }
  const agents = fs.readFileSync(agentsPath, "utf8");
  const marker = "<!-- WORK_LOG_MERGED -->";
  const base = agents.includes(marker) ? agents.slice(0, agents.indexOf(marker)).trimEnd() : agents.trimEnd();
  const merged = `${base}\n\n${marker}\n\n## Recent Work Log\n\n${workLog}\n`;
  fs.writeFileSync(agentsPath, merged, "utf8");
  console.log(`[work-log] merged into AGENTS.md`);
}

function mergeOrphanedMemory() {
  const memDir = path.join(WORKSPACE_DIR, "memory");
  if (!fs.existsSync(memDir)) return;
  const today = new Date().toISOString().slice(0, 10);
  const mainFile = path.join(memDir, `${today}.md`);
  let merged = 0;
  for (const f of fs.readdirSync(memDir)) {
    if (!f.startsWith(today + "-") || !f.endsWith(".md")) continue;
    const orphan = path.join(memDir, f);
    const content = fs.readFileSync(orphan, "utf8").trim();
    if (content) {
      fs.appendFileSync(mainFile, `\n\n---\n\n${content}\n`);
      merged++;
    }
    fs.unlinkSync(orphan);
  }
  if (merged) console.log(`[memory] merged ${merged} orphaned files into ${today}.md`);
}

// ─────────────────────────────────────────────
// Config Enforcement
// ─────────────────────────────────────────────

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch { return {}; }
}

function writeConfig(obj) {
  const dir = path.dirname(configPath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.openclaw.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, configPath());
}


function deepSet(obj, keyPath, value) {
  const keys = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function deepGet(obj, keyPath) {
  const keys = keyPath.split(".");
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean)));
}

function getSlackDmPolicy(slackConfig) {
  const cfg = asObject(slackConfig);
  if (typeof cfg.dmPolicy === "string" && cfg.dmPolicy.trim()) return cfg.dmPolicy.trim();
  const dm = asObject(cfg.dm);
  if (typeof dm.policy === "string" && dm.policy.trim()) return dm.policy.trim();
  return undefined;
}

function getSlackAllowFrom(slackConfig) {
  const cfg = asObject(slackConfig);
  if (Array.isArray(cfg.allowFrom)) return normalizeStringList(cfg.allowFrom);
  const dm = asObject(cfg.dm);
  if (Array.isArray(dm.allowFrom)) return normalizeStringList(dm.allowFrom);
  return [];
}

function buildSlackChannelConfig({ currentConfig, botToken, appToken }) {
  const current = asObject(currentConfig);
  const next = { ...current, enabled: true };
  const nextBotToken = botToken?.trim();
  const nextAppToken = appToken?.trim();

  if (nextBotToken) next.botToken = nextBotToken;
  if (nextAppToken) next.appToken = nextAppToken;
  if (typeof next.groupPolicy !== "string" || !next.groupPolicy.trim()) {
    next.groupPolicy = "allowlist";
  }

  const dmPolicy = getSlackDmPolicy(current);
  const allowFrom = getSlackAllowFrom(current);
  if (!dmPolicy && allowFrom.length === 0) {
    next.dmPolicy = "open";
    next.allowFrom = ["*"];
  } else if (dmPolicy === "open" && allowFrom.length === 0) {
    next.allowFrom = ["*"];
  }

  return next;
}

function redactSlackSecrets(value) {
  return String(value ?? "")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/xapp-[A-Za-z0-9-]+/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/("(?:botToken|appToken|signingSecret)"\s*:\s*")[^"]+(")/g, '$1[REDACTED]$2');
}

function formatSlackConfigSummary(slackConfig, pluginEnabled) {
  const cfg = asObject(slackConfig);
  const allowFrom = getSlackAllowFrom(cfg);
  const allowFromLabel = allowFrom.includes("*")
    ? "*"
    : allowFrom.length === 1
      ? "1 entry"
      : `${allowFrom.length} entries`;
  const dmPolicy = getSlackDmPolicy(cfg) ?? "pairing";
  const mode = typeof cfg.mode === "string" && cfg.mode.trim() ? cfg.mode.trim() : "socket";
  const groupPolicy =
    typeof cfg.groupPolicy === "string" && cfg.groupPolicy.trim()
      ? cfg.groupPolicy.trim()
      : "allowlist";
  return `plugin=${pluginEnabled ? "on" : "off"} enabled=${cfg.enabled !== false ? "on" : "off"} mode=${mode} dmPolicy=${dmPolicy} allowFrom=${allowFromLabel} groupPolicy=${groupPolicy} botToken=${cfg.botToken ? "set" : "missing"} appToken=${cfg.appToken ? "set" : "missing"}`;
}

async function syncSlackChannelConfig({ botToken, appToken, logLabel }) {
  const currentConfig = readConfig();
  const currentSlack = asObject(currentConfig.channels?.slack);
  const nextSlack = buildSlackChannelConfig({
    currentConfig: currentSlack,
    botToken,
    appToken,
  });
  const pluginEnabled = currentConfig.plugins?.entries?.slack?.enabled === true;
  const needsConfigWrite = JSON.stringify(currentSlack) !== JSON.stringify(nextSlack);
  const needsPluginEnable = !pluginEnabled;

  if (!needsConfigWrite && !needsPluginEnable) {
    console.log(`[${logLabel}] slack config already synced ${formatSlackConfigSummary(nextSlack, true)}`);
    return { updated: false, configChanged: false, pluginChanged: false };
  }

  let configResult = null;
  if (needsConfigWrite) {
    configResult = await runCmd(
      clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(nextSlack)]),
    );
    if (configResult.code !== 0) {
      console.error(
        `[${logLabel}] slack config write failed: exit=${configResult.code} output=${redactSlackSecrets(configResult.output).slice(0, 240)}`,
      );
    }
  }

  let pluginResult = null;
  if (needsPluginEnable) {
    pluginResult = await runCmd(
      clawArgs(["config", "set", "--json", "plugins.entries.slack", JSON.stringify({ enabled: true })]),
    );
    if (pluginResult.code !== 0) {
      console.error(
        `[${logLabel}] slack plugin enable failed: exit=${pluginResult.code} output=${redactSlackSecrets(pluginResult.output).slice(0, 240)}`,
      );
    }
  }

  const nextPluginEnabled = needsPluginEnable ? pluginResult?.code === 0 : pluginEnabled;
  console.log(
    `[${logLabel}] slack config synced ${formatSlackConfigSummary(nextSlack, nextPluginEnabled)}`,
  );
  return {
    updated: needsConfigWrite || needsPluginEnable,
    configChanged: needsConfigWrite,
    pluginChanged: needsPluginEnable,
  };
}

// ─────────────────────────────────────────────
// Connector Credential Persistence
// ─────────────────────────────────────────────

const CONNECTOR_FIELDS = {
  slack: [
    { key: "SLACK_BOT_TOKEN", label: "Bot Token", placeholder: "xoxb-...", type: "password", hint: "Slack app → OAuth & Permissions" },
    { key: "SLACK_APP_TOKEN", label: "App Token", placeholder: "xapp-...", type: "password", hint: "Required for Socket Mode" },
  ],
  confluence: [
    { key: "CONFLUENCE_URL", label: "Confluence URL", placeholder: "https://yourco.atlassian.net/wiki", type: "text", hint: "Base URL of your instance" },
    { key: "CONFLUENCE_EMAIL", label: "Email", placeholder: "you@company.com", type: "email", hint: "Account email for API auth" },
    { key: "CONFLUENCE_TOKEN", label: "API Token", placeholder: "your-api-token", type: "password", hint: "id.atlassian.com → Security → API tokens" },
  ],
  github: [
    { key: "GITHUB_TOKEN", label: "Personal Access Token", placeholder: "ghp_...", type: "password", hint: "GitHub Settings → Developer settings → PATs" },
  ],
  voice: [],
};

function connectorsConfigPath() {
  return path.join(STATE_DIR, "connectors.json");
}

function readConnectorsConfig() {
  try { return JSON.parse(fs.readFileSync(connectorsConfigPath(), "utf8")); }
  catch { return {}; }
}

function writeConnectorsConfig(obj) {
  const dir = path.dirname(connectorsConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.connectors.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, connectorsConfigPath());
}

function loadConnectorEnv() {
  const cfg = readConnectorsConfig();
  for (const [key, value] of Object.entries(cfg)) {
    if (value && typeof value === "string") {
      process.env[key] = value;
    }
  }
  if (Object.keys(cfg).length > 0) {
    console.log(`[connectors] loaded ${Object.keys(cfg).length} env vars from connectors.json`);
  }
}

loadConnectorEnv();

// Model / Provider Configuration (env-var driven, easy swap)
// Examples:
//   OPENCLAW_MODEL_PRIMARY=openrouter/anthropic/claude-sonnet-4.6
//   OPENCLAW_MODEL_FALLBACKS=openrouter/google/gemini-2.5-flash
// To revert to direct Anthropic:
//   OPENCLAW_MODEL_PRIMARY=anthropic/claude-opus-4-6
function ensureModelConfig() {
  const cfg = readConfig();

  const primary = process.env.OPENCLAW_MODEL_PRIMARY?.trim()
    || "openrouter/anthropic/claude-sonnet-4.6";
  const fallbacksRaw = process.env.OPENCLAW_MODEL_FALLBACKS?.trim();
  const fallbacks = fallbacksRaw
    ? fallbacksRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

  const isOpenRouter = primary.startsWith("openrouter/") ||
    fallbacks.some(f => f.startsWith("openrouter/"));

  // --- Auth profiles ---
  if (!cfg.auth) cfg.auth = {};
  if (!cfg.auth.profiles) cfg.auth.profiles = {};

  if (isOpenRouter) {
    const orKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!orKey) {
      console.warn("[model] OpenRouter model requested but OPENROUTER_API_KEY not set — aborting");
      return;
    }
    // OpenRouter auth profile
    cfg.auth.profiles["openrouter:default"] = { provider: "openrouter", mode: "api_key" };
    // Keep anthropic profile for internal ops (slug generator, memory flush)
    cfg.auth.profiles["anthropic:default"] = { provider: "anthropic", mode: "api_key" };
    // Store key in config env block (some OpenClaw builds read it from here)
    if (!cfg.env) cfg.env = {};
    cfg.env.OPENROUTER_API_KEY = orKey;
  } else if (primary.startsWith("anthropic/") || !primary.includes("/")) {
    cfg.auth.profiles["anthropic:default"] = { provider: "anthropic", mode: "api_key" };
  }

  // --- Model config ---
  deepSet(cfg, "agents.defaults.model.primary", primary);
  if (fallbacks.length > 0) {
    deepSet(cfg, "agents.defaults.model.fallbacks", fallbacks);
  } else if (cfg.agents?.defaults?.model && Object.prototype.hasOwnProperty.call(cfg.agents.defaults.model, "fallbacks")) {
    delete cfg.agents.defaults.model.fallbacks;
  }

  // Register all models in the models map
  if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};
  for (const m of [primary, ...fallbacks]) {
    if (!cfg.agents.defaults.models[m]) cfg.agents.defaults.models[m] = {};
  }

  // Disable extended thinking — OpenRouter rejects dual reasoning params
  deepSet(cfg, "agents.defaults.thinkingDefault", "off");

  writeConfig(cfg);
  console.log(`[model] enforced: primary=${primary}${fallbacks.length ? ` fallbacks=${fallbacks.join(",")}` : ""} provider=${isOpenRouter ? "openrouter" : "anthropic"}`);
}

// Web search: Perplexity Sonar routed through OpenRouter
function ensureWebSearchConfig() {
  const cfg = readConfig();
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    console.log("[web] OPENROUTER_API_KEY not set — skipping web search config");
    return;
  }

  deepSet(cfg, "tools.web.search.enabled", true);
  deepSet(cfg, "tools.web.search.provider", "perplexity");
  deepSet(cfg, "tools.web.search.apiKey", apiKey);

  // Route Perplexity through OpenRouter
  if (!cfg.tools.web.search.perplexity) {
    cfg.tools.web.search.perplexity = {};
  }
  cfg.tools.web.search.perplexity.apiKey = apiKey;
  cfg.tools.web.search.perplexity.baseUrl = "https://openrouter.ai/api/v1";
  cfg.tools.web.search.perplexity.model = "perplexity/sonar";

  deepSet(cfg, "tools.web.fetch.enabled", true);
  writeConfig(cfg);
  console.log("[web] search enabled: perplexity/sonar via OpenRouter");
}

function ensureExecAutoApprove() {
  const cfg = readConfig();
  if (deepGet(cfg, "tools.exec.ask") === "off") return;
  deepSet(cfg, "tools.exec.security", "full");
  deepSet(cfg, "tools.exec.ask", "off");
  writeConfig(cfg);
  console.log("[exec] auto-approve enabled");
}

function ensureSessionConfig() {
  const cfg = readConfig();
  if (deepGet(cfg, "session.reset.mode") === "daily") return;
  deepSet(cfg, "session.reset.mode", "daily");
  deepSet(cfg, "session.reset.atHour", 4);
  deepSet(cfg, "session.reset.idleMinutes", 1800);
  writeConfig(cfg);
  console.log("[session] daily reset at 4AM, idle 30hr");
}

function ensureMemoryConfig() {
  const cfg = readConfig();
  deepSet(cfg, "agents.defaults.bootstrapMaxChars", 30000);
  deepSet(cfg, "agents.defaults.heartbeat.every", "25m");
  if (process.env.OPENAI_API_KEY) {
    deepSet(cfg, "agents.defaults.memorySearch.enabled", true);
    deepSet(cfg, "agents.defaults.memorySearch.provider", "openai");
    deepSet(cfg, "agents.defaults.memorySearch.model", "text-embedding-3-small");
    deepSet(cfg, "agents.defaults.memorySearch.sources", ["memory", "sessions"]);
  }
  deepSet(cfg, "agents.defaults.compaction.memoryFlush.enabled", true);
  deepSet(cfg, "agents.defaults.compaction.memoryFlush.softThresholdTokens", 6000);
  deepSet(cfg, "hooks.internal.enabled", true);
  deepSet(cfg, "hooks.internal.entries.session-memory.enabled", true);
  writeConfig(cfg);
  console.log("[memory] config enforced");
}

function ensureWorkspaceConfig() {
  const cfg = readConfig();
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};

  let dirty = false;
  if (cfg.agents.defaults.workspace !== WORKSPACE_DIR) {
    cfg.agents.defaults.workspace = WORKSPACE_DIR;
    dirty = true;
  }

  const legacyWorkspace = path.join(os.homedir(), ".openclaw", "workspace");
  if (Array.isArray(cfg.agents.list) && cfg.agents.list.length > 0) {
    const defaultIndex = Math.max(
      0,
      cfg.agents.list.findIndex((entry) => entry && entry.default === true),
    );
    const entry = cfg.agents.list[defaultIndex];
    if (entry && typeof entry === "object") {
      const workspace = typeof entry.workspace === "string" ? entry.workspace.trim() : "";
      if (!workspace || workspace === legacyWorkspace) {
        entry.workspace = WORKSPACE_DIR;
        dirty = true;
      }
    }
  }

  if (dirty) {
    writeConfig(cfg);
    console.log(`[workspace] config enforced: ${WORKSPACE_DIR}`);
  }
}

function ensureGatewayAuth() {
  const cfg = readConfig();
  if (!cfg.gateway) cfg.gateway = {};
  if (!cfg.gateway.auth) cfg.gateway.auth = {};
  cfg.gateway.auth.mode = "token";
  cfg.gateway.auth.token = OPENCLAW_GATEWAY_TOKEN;
  cfg.gateway.bind = "lan";
  // Clean up stale password mode if present
  delete cfg.gateway.auth.password;
  delete cfg.gateway.auth.trustedProxy;
  writeConfig(cfg);
}

function ensureBrowserConfig() {
  const cfg = readConfig();
  if (!cfg.browser) cfg.browser = {};

  // Core browser settings for Docker
  cfg.browser.enabled = true;
  cfg.browser.headless = true;
  cfg.browser.noSandbox = true;
  cfg.browser.executablePath = "/usr/bin/google-chrome-stable";

  if (!cfg.browser.profiles) cfg.browser.profiles = {};

  // Local Chrome profile
  if (!cfg.browser.profiles.openclaw) cfg.browser.profiles.openclaw = {};
  cfg.browser.profiles.openclaw.cdpPort = 18800;
  cfg.browser.profiles.openclaw.color = "#FF4500";

  // Browserless cloud profile (if token available)
  const browserlessToken = process.env.BROWSERLESS_API_TOKEN?.trim();
  if (browserlessToken) {
    const cdpUrl = `https://production-sfo.browserless.io?token=${browserlessToken}`;
    if (!cfg.browser.profiles.browserless) cfg.browser.profiles.browserless = {};
    cfg.browser.profiles.browserless.cdpUrl = cdpUrl;
    cfg.browser.profiles.browserless.color = "#00AA00";
    cfg.browser.defaultProfile = "browserless";
    cfg.browser.remoteCdpTimeoutMs = 5000;
    cfg.browser.remoteCdpHandshakeTimeoutMs = 10000;
    console.log("[browser] Browserless configured as default, local Chrome as fallback");
  } else {
    cfg.browser.defaultProfile = "openclaw";
    console.log("[browser] local Chrome configured (no Browserless token)");
  }

  writeConfig(cfg);
}

function enforceAllConfig() {
  if (!isConfigured()) return;

  // Clean up invalid keys from previous deploys
  const cfg = readConfig();
  let dirty = false;
  if (cfg.tools?.browser) {
    delete cfg.tools.browser;
    dirty = true;
    console.log("[config] removed invalid tools.browser key (browser is top-level)");
  }
  for (const k of ["userName", "firstName", "lastName"]) {
    if (k in cfg) { delete cfg[k]; dirty = true; console.log(`[config] removed invalid key: ${k}`); }
  }
  if (dirty) writeConfig(cfg);

  ensureModelConfig();
  ensureWebSearchConfig();
  ensureExecAutoApprove();
  ensureSessionConfig();
  ensureMemoryConfig();
  ensureWorkspaceConfig();
  ensureGatewayAuth();
  ensureBrowserConfig();
}

// ─────────────────────────────────────────────
// Startup Sequence
// ─────────────────────────────────────────────

// Start D-Bus (Chrome in Docker needs it)
try {
  childProcess.execSync("mkdir -p /run/dbus && dbus-daemon --system --fork 2>/dev/null || true", { stdio: "ignore" });
} catch { /* non-fatal */ }

let _userProfileSyncDone = Promise.resolve();

// Seed workspace
try { seedWorkspace(); } catch (err) { console.error("[workspace] seed error:", err.message); }
try { syncUserProfileFile(); } catch (err) { console.error("[workspace] user profile sync error:", err.message); }
_userProfileSyncDone = syncStoredUserProfile().catch((err) => {
  console.error("[workspace] stored user profile sync error:", err.message);
});

// Memory merges
try { mergeWorkLog(); } catch (err) { console.error("[work-log] error:", err.message); }
try { mergeOrphanedMemory(); } catch (err) { console.error("[memory] error:", err.message); }
try { injectCurrentDate(); } catch (err) { console.error("[date] error:", err.message); }

// Config enforcement
try { enforceAllConfig(); } catch (err) { console.error("[config] error:", err.message); }

// Ensure Slack channel config is synced from connector env vars into openclaw config
// This runs at startup in case a previous deploy wrote connectors.json but the config was lost
async function ensureSlackChannelConfig() {
  if (!isConfigured()) return;
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  if (!botToken || !appToken) return;
  await syncSlackChannelConfig({ botToken, appToken, logLabel: "slack-sync" });
}
// Await slack config sync before gateway starts (must not be fire-and-forget)
const _slackSyncDone = ensureSlackChannelConfig().catch(err => console.error("[slack-sync] error:", err.message));

// ─────────────────────────────────────────────
// Gateway Process Management
// ─────────────────────────────────────────────

let gatewayProcess = null;

async function isGatewayReachable() {
  try {
    const res = await fetch(`${GATEWAY_TARGET}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function ensureGatewayRunning() {
  // Wait for slack config sync to finish before starting gateway
  await _slackSyncDone;
  await _userProfileSyncDone;
  if (await isGatewayReachable()) {
    console.log("[gateway] already running");
    return;
  }
  if (!isConfigured()) {
    console.log("[gateway] not configured yet — waiting for /setup");
    return;
  }

  // Clean stale browser locks
  const browserDir = path.join(STATE_DIR, "browser");
  if (fs.existsSync(browserDir)) {
    for (const d of fs.readdirSync(browserDir)) {
      const lock = path.join(browserDir, d, "SingletonLock");
      try { fs.unlinkSync(lock); } catch { /* ignore */ }
    }
  }

  console.log("[gateway] starting...");
  gatewayProcess = childProcess.spawn("node", clawArgs([
    "gateway", "run",
    "--bind", "lan",
    "--port", String(INTERNAL_GATEWAY_PORT),
  ]), {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      OPENCLAW_CONFIG_PATH: GATEWAY_CONFIG_PATH,
    },
    stdio: "inherit",
  });

  gatewayProcess.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProcess = null;
  });

  gatewayProcess.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProcess = null;
  });

  // Wait for gateway to become reachable
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await isGatewayReachable()) {
      console.log("[gateway] started successfully");
      const cfg = readConfig();
      const slackCfg = asObject(cfg.channels?.slack);
      const slackPluginEnabled = cfg.plugins?.entries?.slack?.enabled === true;
      if (Object.keys(slackCfg).length > 0 || slackPluginEnabled) {
        console.log(
          `[gateway-diag] slack summary: ${formatSlackConfigSummary(slackCfg, slackPluginEnabled)}`,
        );
      }
      runCmd(clawArgs(["channels", "add", "--help"])).then(r => {
        const supported = ["slack", "whatsapp", "telegram", "discord"].filter(c => r.output.includes(c));
        console.log(`[gateway-diag] supported channels: ${supported.join(", ") || "(none found in help)"}`);
      }).catch(() => {});
      runCmd(clawArgs(["status"])).then(r => {
        console.log(`[gateway-diag] status: ${r.output.slice(0, 800)}`);
      }).catch(() => {});
      // Check the gateway log file for channel-related entries
      setTimeout(() => {
        try {
          const logFile = "/tmp/openclaw/openclaw-" + new Date().toISOString().slice(0, 10) + ".log";
          if (fs.existsSync(logFile)) {
            const log = fs.readFileSync(logFile, "utf8");
            const channelLines = log.split("\n").filter(l => /channel|slack|plugin|extension/i.test(l)).slice(-20);
            console.log(`[gateway-diag] log file channel lines (${channelLines.length}):\n${channelLines.join("\n")}`);
          } else {
            console.log(`[gateway-diag] log file not found: ${logFile}`);
          }
        } catch (err) { console.log(`[gateway-diag] log read error: ${err.message}`); }
      }, 5000);
      return;
    }
  }
  console.error("[gateway] failed to start within 120s");
}

// ─────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function isLoopbackRequest(req) {
  const remote = req.socket?.remoteAddress || "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

// ─────────────────────────────────────────────
// Token Bridge (writes gateway token to localStorage for WS auth)
// ─────────────────────────────────────────────

const TOKEN_SET_COOKIE = "oc_tok";
const SETUP_AUTH_COOKIE = "pm_setup_auth";
const SETUP_AUTH_MAX_AGE = 60 * 60 * 24 * 14;

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

function timingSafeMatch(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parseBasicCredentials(req) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    return {
      username: idx >= 0 ? decoded.slice(0, idx) : decoded,
      password: idx >= 0 ? decoded.slice(idx + 1) : "",
    };
  } catch {
    return null;
  }
}

function hasValidSetupCredentials(username, password) {
  if (!SETUP_PASSWORD) return false;
  return timingSafeMatch(username, SETUP_USERNAME) && timingSafeMatch(password, SETUP_PASSWORD);
}

function signSetupSession(username) {
  return crypto
    .createHmac("sha256", `${OPENCLAW_GATEWAY_TOKEN}:${SETUP_PASSWORD || ""}`)
    .update(String(username ?? ""))
    .digest("hex");
}

function buildSetupSessionCookie(username) {
  const encodedUser = Buffer.from(String(username ?? ""), "utf8").toString("base64url");
  return `${encodedUser}.${signSetupSession(username)}`;
}

function getSetupSessionUser(req) {
  const raw = getCookie(req, SETUP_AUTH_COOKIE);
  if (!raw || !SETUP_PASSWORD) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const encodedUser = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  let username = "";
  try {
    username = Buffer.from(encodedUser, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!timingSafeMatch(username, SETUP_USERNAME)) return null;
  if (!timingSafeMatch(signature, signSetupSession(username))) return null;
  return username;
}

function getAuthenticatedSetupUser(req) {
  const cookieUser = getSetupSessionUser(req);
  if (cookieUser) return cookieUser;
  const basic = parseBasicCredentials(req);
  if (basic && hasValidSetupCredentials(basic.username, basic.password)) return basic.username;
  return null;
}

function isHtmlRequest(req) {
  const accept = String(req.headers.accept || "");
  return req.method === "GET" && accept.includes("text/html");
}

function sanitizeNextPath(value) {
  const next = String(value || "").trim();
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setSetupSessionCookie(res, req, username) {
  const attrs = [
    `${SETUP_AUTH_COOKIE}=${buildSetupSessionCookie(username)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SETUP_AUTH_MAX_AGE}`,
  ];
  if (String(req.headers["x-forwarded-proto"] || "").includes("https")) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

function clearSetupSessionCookie(res, req) {
  const attrs = [
    `${SETUP_AUTH_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (String(req.headers["x-forwarded-proto"] || "").includes("https")) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

// Auth middleware for app pages + setup APIs
function setupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res.status(500).type("text/plain").send("SETUP_PASSWORD is not set. Set it in Railway Variables.");
  }
  const username = getAuthenticatedSetupUser(req);
  if (username) {
    req.setupUser = username;
    return next();
  }
  if (isHtmlRequest(req)) {
    return res.status(401).type("html").send(loginPage({
      next: sanitizeNextPath(req.originalUrl || "/"),
      username: SETUP_USERNAME,
    }));
  }
  res.set("WWW-Authenticate", 'Basic realm="PM Agent"');
  return res.status(401).send("Auth required");
}

function setupAuthOrLoopback(req, res, next) {
  if (isLoopbackRequest(req)) return next();
  return setupAuth(req, res, next);
}

const voiceDemo = createVoiceDemo({ workspaceDir: WORKSPACE_DIR, stateDir: STATE_DIR });
voiceDemo.registerRoutes(app, setupAuth, setupAuthOrLoopback);

function tokenBridgeHTML(redirectTo) {
  const tok = OPENCLAW_GATEWAY_TOKEN || "";
  const dest = redirectTo || "/chat?session=main";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connecting...</title></head><body>
<script>
try{var s=JSON.parse(localStorage.getItem("openclaw.control.settings.v1")||"{}");s.token="${tok}";localStorage.setItem("openclaw.control.settings.v1",JSON.stringify(s))}catch(e){}
location.replace("${dest}");
</script><noscript><a href="${dest}">Continue</a></noscript></body></html>`;
}

function sendTokenBridge(res, redirectTo) {
  res.set("Set-Cookie", `${TOKEN_SET_COOKIE}=1; Path=/; SameSite=Lax; Max-Age=86400`);
  return res.type("html").send(tokenBridgeHTML(redirectTo));
}

// ─────────────────────────────────────────────
// Home page
// ─────────────────────────────────────────────

app.get("/login", (req, res) => {
  const nextPath = sanitizeNextPath(req.query.next || "/");
  if (getAuthenticatedSetupUser(req)) {
    return res.redirect(nextPath);
  }
  return res.type("html").send(loginPage({ next: nextPath, username: SETUP_USERNAME }));
});

app.post("/login", (req, res) => {
  if (!SETUP_PASSWORD) {
    return res.status(500).type("text/plain").send("SETUP_PASSWORD is not set. Set it in Railway Variables.");
  }
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const nextPath = sanitizeNextPath(req.body.next || "/");
  if (!hasValidSetupCredentials(username, password)) {
    return res.status(401).type("html").send(loginPage({
      error: "Invalid username or password.",
      next: nextPath,
      username: SETUP_USERNAME,
      submittedUsername: username,
    }));
  }
  setSetupSessionCookie(res, req, username);
  return res.redirect(nextPath);
});

app.post("/logout", (req, res) => {
  clearSetupSessionCookie(res, req);
  return res.redirect("/login");
});

app.get("/logout", (req, res) => {
  clearSetupSessionCookie(res, req);
  return res.redirect("/login");
});

app.get("/", setupAuth, (req, res, next) => {
  if (!isConfigured()) return res.redirect("/setup");
  // Ensure the token bridge has run
  if (!getCookie(req, TOKEN_SET_COOKIE)) {
    return sendTokenBridge(res, "/");
  }
  return res.type("html").send(homePage());
});

// ─────────────────────────────────────────────
// /setup routes
// ─────────────────────────────────────────────

app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

app.get("/setup", setupAuth, (_req, res) => res.send(setupPage()));

app.get("/setup/api/status", setupAuth, async (_req, res) => {
  const reachable = await isGatewayReachable();
  res.json({
    configured: isConfigured(),
    gatewayRunning: reachable,
    stateDir: STATE_DIR,
    workspaceDir: WORKSPACE_DIR,
  });
});

app.post("/setup/api/onboard", setupAuth, async (req, res) => {
  const { provider, token, appToken } = req.body;

  // If already configured, skip onboard and just start the gateway
  if (isConfigured()) {
    try {
      enforceAllConfig();
      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already configured. Gateway started." });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Build onboard args matching powerus pattern
  const args = [
    OPENCLAW_ENTRY,
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace", WORKSPACE_DIR,
    "--gateway-bind", "loopback",
    "--gateway-port", String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth", "token",
    "--gateway-token", OPENCLAW_GATEWAY_TOKEN,
    "--flow", "quickstart",
  ];

  // Add OpenRouter auth if available
  const orKey = process.env.OPENROUTER_API_KEY?.trim();
  if (orKey) {
    args.push("--auth-choice", "openrouter-api-key", "--openrouter-api-key", orKey);
  }

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
  };

  try {
    const result = childProcess.execSync(
      args.map(a => a.includes(" ") ? `"${a}"` : a).join(" "),
      { env, timeout: 120000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    console.log(`[setup] onboard output: ${result.slice(0, 500)}`);

    // Write channel config via openclaw CLI (matching powerus pattern)
    const hasRealToken = token && token !== "webchat-only" && !token.startsWith("webchat");
    if (hasRealToken && provider === "slack") {
      await syncSlackChannelConfig({
        botToken: token,
        appToken: appToken || undefined,
        logLabel: "setup",
      });
    } else if (!hasRealToken) {
      console.log("[setup] no channel tokens provided — WebChat only mode");
    }

    enforceAllConfig();
    await ensureGatewayRunning();
    res.json({ ok: true, output: result });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

app.post("/setup/api/restart", setupAuth, async (_req, res) => {
  if (gatewayProcess) {
    gatewayProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 3000));
  }
  enforceAllConfig();
  await ensureGatewayRunning();
  res.json({ ok: true });
});

app.get("/setup/api/user-name", setupAuth, async (_req, res) => {
  try {
    const prefs = await getUserPrefs();
    res.json({ firstName: prefs.firstName || "", lastName: prefs.lastName || "" });
  } catch (err) {
    res.json({ firstName: "", lastName: "" });
  }
});

app.post("/setup/api/user-name", setupAuth, async (req, res) => {
  try {
    const prefs = await getUserPrefs();
    prefs.firstName = (req.body.firstName || "").trim();
    prefs.lastName = (req.body.lastName || "").trim();
    await setUserPrefs(prefs);
    syncUserProfileFile({ firstName: prefs.firstName, lastName: prefs.lastName }, { force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/setup/api/config", setupAuth, (_req, res) => {
  try { res.json(readConfig()); }
  catch { res.json({}); }
});

app.post("/setup/api/config", setupAuth, (req, res) => {
  try {
    writeConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// /connectors routes
// ─────────────────────────────────────────────

app.get("/connectors", setupAuth, (_req, res) => res.send(connectorsPage()));

app.get("/connectors/api/status", setupAuth, async (_req, res) => {
  const connectors = [
    {
      id: "slack",
      name: "Slack",
      description: "Chat with your agent in Slack channels and DMs",
      configured: !!(process.env.SLACK_BOT_TOKEN),
      envVars: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    },
    {
      id: "confluence",
      name: "Confluence",
      description: "Read and search your team's wiki pages",
      configured: !!(process.env.CONFLUENCE_URL && process.env.CONFLUENCE_TOKEN),
      envVars: ["CONFLUENCE_URL", "CONFLUENCE_EMAIL", "CONFLUENCE_TOKEN"],
    },
    {
      id: "github",
      name: "GitHub",
      description: "Monitor repos, PRs, and issues",
      configured: !!(process.env.GITHUB_TOKEN),
      envVars: ["GITHUB_TOKEN"],
    },
    {
      id: "voice",
      name: "Voice",
      description: "Monitor live call sessions, transcript, summary, and browser audio",
      configured: !!(voiceDemo.enabled && voiceDemo.configured),
      envVars: [],
    },
  ];
  res.json({ connectors });
});

app.get("/connectors/api/fields/:id", setupAuth, (req, res) => {
  const fields = CONNECTOR_FIELDS[req.params.id];
  if (!fields) return res.status(404).json({ error: "Unknown connector" });
  const cfg = readConnectorsConfig();
  const result = fields.map(f => {
    const val = cfg[f.key] || process.env[f.key] || "";
    const masked = val && f.type === "password"
      ? val.slice(0, 6) + "•".repeat(Math.max(0, val.length - 6))
      : val;
    return { ...f, currentValue: masked, hasValue: !!val };
  });
  res.json({ fields: result });
});

app.post("/connectors/api/save", setupAuth, async (req, res) => {
  const { id, fields } = req.body || {};
  if (!id || !CONNECTOR_FIELDS[id]) return res.status(400).json({ error: "Invalid connector id" });
  if (!fields || typeof fields !== "object") return res.status(400).json({ error: "Missing fields" });

  // Validate only known keys
  const allowed = new Set(CONNECTOR_FIELDS[id].map(f => f.key));
  for (const k of Object.keys(fields)) {
    if (!allowed.has(k)) return res.status(400).json({ error: `Unknown field: ${k}` });
  }

  // Merge into config
  const cfg = readConnectorsConfig();
  for (const [k, v] of Object.entries(fields)) {
    if (v && typeof v === "string" && v.trim()) {
      cfg[k] = v.trim();
      process.env[k] = v.trim();
    }
  }
  writeConnectorsConfig(cfg);

  // Write channel config via openclaw CLI (matching powerus pattern — avoids config read/write race)
  if (id === "slack" && cfg.SLACK_BOT_TOKEN) {
    await syncSlackChannelConfig({
      botToken: cfg.SLACK_BOT_TOKEN,
      appToken: cfg.SLACK_APP_TOKEN || undefined,
      logLabel: "connectors",
    });
  }

  // Restart gateway so new config takes effect
  try {
    if (gatewayProcess) {
      gatewayProcess.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 3000));
    }
    await ensureGatewayRunning();
  } catch (err) {
    console.error(`[connectors] gateway restart warning: ${err.message}`);
  }

  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// /chat — ensure token bridge before proxying to gateway
// ─────────────────────────────────────────────

app.get("/chat", setupAuth, (req, res, next) => {
  // Token bridge must fire first so the browser has the WS auth token
  if (!getCookie(req, TOKEN_SET_COOKIE)) {
    return sendTokenBridge(res, req.originalUrl || "/chat?session=main");
  }
  next(); // fall through to the proxy
});

// ─────────────────────────────────────────────
// /memory routes
// ─────────────────────────────────────────────

app.get("/memory", setupAuth, (_req, res) => res.send(memoryPage()));

app.get("/memory/api/sessions", setupAuth, async (_req, res) => {
  if (!chatSyncDbConfigured()) return res.json({ sessions: [] });
  try {
    const { sessions } = await chatSyncListSessions({ limit: 50 });
    console.log("[memory] sessions from DB:", sessions.map(s => ({ id: s.id, file: s.session_file, msgs: s.message_count })));
    res.json({
      sessions: sessions.map((s) => {
        // Derive a friendly name from session_file (e.g. "main/06903298-..." → "main")
        let name = s.session_file || "main";
        const parts = name.split("/");
        // If it looks like "agent/session-uuid", use the agent name
        if (parts.length >= 2) name = parts[0];
        // If it's just a UUID, call it "Chat"
        if (/^[0-9a-f-]{36}$/i.test(name)) name = "Chat";
        return {
          id: s.id,
          agent: name,
          size: s.message_count || 0,
          modified: s.last_message_at || s.started_at || "",
        };
      }),
    });
  } catch (err) {
    console.error("[memory] sessions error:", err.message);
    res.json({ sessions: [] });
  }
});

app.delete("/memory/api/session/:id", setupAuth, async (req, res) => {
  if (!chatSyncDbConfigured()) return res.status(503).json({ error: "DB not configured" });
  try {
    await chatSyncDeleteSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/memory/api/session/:agent/:id", setupAuth, async (req, res) => {
  if (!chatSyncDbConfigured()) return res.status(503).json({ error: "DB not configured" });
  try {
    const rows = await chatSyncGetMessages({ sessionId: req.params.id });
    const messages = rows
      .filter((m) => m.role && m.content)
      .map((m) => {
        let text = m.content;
        // Parse OpenClaw content blocks: [{"type":"text","text":"..."}]
        if (typeof text === "string" && text.startsWith("[")) {
          try {
            const blocks = JSON.parse(text);
            if (Array.isArray(blocks)) {
              text = blocks
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
                .join("\n");
            }
          } catch { /* not JSON, use as-is */ }
        }
        // Strip openclaw metadata prefix (conversation info block)
        text = text.replace(/^Conversation info \(untrusted metadata\):\n```json\n[\s\S]*?```\n\n/, "");
        // Strip [[reply_to_current]] prefix
        text = text.replace(/^\[\[reply_to_current\]\]\s*/, "");
        // Strip date prefix like "[Fri 2026-03-06 11:45 UTC] "
        text = text.replace(/^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+[\d:]+\s+\w+\]\s*/, "");
        return {
          role: m.role,
          content: text.trim(),
          sender: m.sender_name || "",
          time: m.created_at || "",
        };
      })
      .filter((m) => m.content);
    res.json({ messages });
  } catch (err) {
    console.error("[memory] session detail error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/memory/api/instructions", setupAuth, (_req, res) => {
  const FILES = [
    { file: "AGENTS.md", label: "Agent Config", description: "Core identity, rules, and behavior directives", category: "Identity & Rules" },
    { file: "BOOTSTRAP.md", label: "Bootstrap", description: "Startup defaults for fresh or reset sessions", category: "Identity & Rules" },
    { file: "IDENTITY.md", label: "Identity", description: "Default name, role, and persona", category: "Identity & Rules" },
    { file: "SOUL.md", label: "Personality", description: "Tone, voice, and communication style", category: "Identity & Rules" },
    { file: "TOOLS.md", label: "Tools", description: "Available tools and how to use them", category: "Identity & Rules" },
    { file: "USER.md", label: "User Rules", description: "Standing instructions and preferences", category: "Identity & Rules" },
    { file: "TEAM_RULES.md", label: "Team Rules", description: "Team-wide standing guidance", category: "Identity & Rules" },
    { file: "HEARTBEAT.md", label: "Heartbeat", description: "Scheduled check-in and monitoring cadence", category: "Identity & Rules" },
    { file: "WORK_LOG.md", label: "Work Log", description: "Running log of agent actions and outputs", category: "Identity & Rules" },
  ];
  const items = [];
  for (const f of FILES) {
    const full = path.join(WORKSPACE_DIR, f.file);
    try {
      const stat = fs.statSync(full);
      items.push({ path: f.file, label: f.label, description: f.description, category: f.category, size: stat.size, mtime: stat.mtime.toISOString() });
    } catch { /* file doesn't exist, skip */ }
  }
  // Auto-discover skills from skills/*/SKILL.md
  const skillsDir = path.join(WORKSPACE_DIR, "skills");
  try {
    for (const name of fs.readdirSync(skillsDir)) {
      const skillFile = path.join(skillsDir, name, "SKILL.md");
      try {
        const stat = fs.statSync(skillFile);
        const content = fs.readFileSync(skillFile, "utf8");
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const desc = descMatch ? descMatch[1].trim() : "Skill workflow";
        items.push({ path: `skills/${name}/SKILL.md`, label: name.charAt(0).toUpperCase() + name.slice(1), description: desc, category: "Skills", size: stat.size, mtime: stat.mtime.toISOString() });
      } catch { /* no SKILL.md */ }
    }
  } catch { /* no skills dir */ }
  res.json({ items });
});

app.get("/memory/api/file", setupAuth, (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ ok: false, error: "path parameter is required" });
  const resolved = path.resolve(WORKSPACE_DIR, relPath);
  if (!resolved.startsWith(path.resolve(WORKSPACE_DIR))) return res.status(403).json({ ok: false, error: "access denied" });
  try {
    const content = fs.readFileSync(resolved, "utf8");
    res.json({ ok: true, content, path: relPath });
  } catch (err) {
    res.status(404).json({ ok: false, error: "file not found" });
  }
});

// ─────────────────────────────────────────────
// /api/chat — memory layer (Supabase)
// ─────────────────────────────────────────────

app.get("/api/chat/search", setupAuthOrLoopback, async (req, res) => {
  if (!chatSyncDbConfigured()) return res.status(503).json({ error: "Chat sync DB not configured" });
  const { q: query, sender, from: dateFrom, to: dateTo, limit } = req.query;
  if (!query) return res.status(400).json({ error: "q parameter is required" });
  try {
    const results = await chatSyncSearchMessages({ query, sender, dateFrom, dateTo, limit });
    res.json({ results, count: results.length });
  } catch (err) {
    console.error("[api/chat/search]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/chat/stats", setupAuthOrLoopback, async (_req, res) => {
  if (!chatSyncDbConfigured()) return res.status(503).json({ error: "Chat sync DB not configured" });
  try {
    const stats = await chatSyncStats();
    res.json(stats);
  } catch (err) {
    console.error("[api/chat/stats]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat/sync", setupAuth, async (req, res) => {
  if (!chatSyncDbConfigured()) return res.status(503).json({ error: "Chat sync DB not configured" });
  try {
    const { sessionFile, startedAt, model, messages } = req.body;
    if (!sessionFile) return res.status(400).json({ error: "sessionFile is required" });
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages array is required" });

    // Upsert session
    const sessionId = await chatSyncUpsertSession({
      sessionFile,
      startedAt,
      model,
      messageCount: messages.length,
      totalTokens: messages.reduce((sum, m) => sum + (m.tokensUsed || 0), 0),
      totalCost: messages.reduce((sum, m) => sum + (m.cost || 0), 0),
      lastMessageAt: messages.length > 0 ? messages[messages.length - 1].createdAt : null,
    });

    // Delete old messages and re-insert (full re-sync)
    await chatSyncDeleteMessagesBySession(sessionId);
    const { inserted, ids } = await chatSyncInsertMessages(sessionId, messages);

    // Embed asynchronously (don't block the response)
    chatSyncEmbedMessages(ids).catch((err) =>
      console.error("[api/chat/sync] embedding error:", err.message),
    );

    res.json({ ok: true, sessionId, inserted });
  } catch (err) {
    console.error("[api/chat/sync]", err);
    res.status(500).json({ error: err.message });
  }
});

// Initialize chat sync schema on startup (non-blocking)
if (chatSyncDbConfigured()) {
  chatSyncEnsureSchema().catch((err) =>
    console.error("[chat-sync-db] schema init error:", err.message),
  );
}

// ─────────────────────────────────────────────
// Reverse Proxy to OpenClaw Gateway
// ─────────────────────────────────────────────

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: false,
  selfHandleResponse: true,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy] error:", err.message);
  if (res && res.writeHead) res.writeHead(502, { "Content-Type": "text/plain" }).end("Gateway unavailable");
});

// Intercept HTML responses from gateway to inject branding + style overrides
const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;

const GATEWAY_OVERRIDE_CSS = `<style id="pm-agent-overrides">
/* === PM Agent design system overrides (Cursor-style) === */
:root, html, body, openclaw-app, .shell, .nav, .content, .topbar,
input, select, textarea, button, .btn {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
  -webkit-font-smoothing: antialiased;
}

/* Light theme */
html, html[data-theme="light"] {
  --bg: #F9F9F9 !important;
  --bg-surface: #FFFFFF !important;
  --bg-hover: #F5F5F5 !important;
  --bg-active: #F0F0F0 !important;
  --text: #1E1E1E !important;
  --text-muted: #6B6B6B !important;
  --text-faint: #9CA3AF !important;
  --border: #E5E5E5 !important;
  --border-hover: #D0D0D0 !important;
  --accent: #2F2F2F !important;
  --accent-hover: #1a1a1a !important;
  --radius: 8px !important;
}

/* Topbar */
.topbar {
  background: #FFFFFF !important;
  border-bottom: 1px solid #E5E5E5 !important;
}

/* Brand */
.brand { cursor: pointer !important; pointer-events: auto !important; }
.brand * { pointer-events: auto !important; }
.brand-logo { display: none !important; }
.brand-title { font-size: 0 !important; }
.brand-title::after { content: "PM Agent"; font-size: 14px; font-weight: 700; letter-spacing: -0.02em; color: #1E1E1E; }
.brand-sub { font-size: 0 !important; }
.brand-sub::after { content: "OpenClaw"; font-size: 11px; color: #6B6B6B; }

/* Sidebar */
aside.nav {
  background: #FFFFFF !important;
  border-right: 1px solid #E5E5E5 !important;
}
.nav-item { color: #6B6B6B !important; border-radius: 6px !important; }
.nav-item:hover { background: #F5F5F5 !important; color: #1E1E1E !important; }
.nav-item.active { background: #F0F0F0 !important; color: #1E1E1E !important; font-weight: 600 !important; }
.nav-item__icon svg { stroke: currentColor !important; }
.nav-label__text { color: #6B6B6B !important; font-size: 11px !important; text-transform: uppercase !important; letter-spacing: 0.05em !important; }
.nav-label__chevron { color: #6B6B6B !important; }
.nav-group--links .nav-item { color: #6B6B6B !important; }

/* Main content */
.content { background: #F9F9F9 !important; }
.page-title { color: #1E1E1E !important; }
.page-sub { color: #6B6B6B !important; }

/* Status pill */
.pill {
  background: #FFFFFF !important;
  border: 1px solid #E5E5E5 !important;
  color: #1E1E1E !important;
  border-radius: 999px !important;
}
.statusDot.ok { background: #4CAF50 !important; }

/* Cards */
.card.chat, .card {
  background: #FFFFFF !important;
  border: 1px solid #E5E5E5 !important;
  border-radius: 8px !important;
}

/* Chat compose */
.chat-compose {
  background: #FFFFFF !important;
  border-top: 1px solid #E5E5E5 !important;
}
.chat-compose textarea {
  background: #FFFFFF !important;
  border: 1px solid #E5E5E5 !important;
  border-radius: 8px !important;
  color: #1E1E1E !important;
}
.chat-compose textarea:focus {
  border-color: #2F2F2F !important;
  outline: none !important;
}
.chat-compose__field span { color: #6B6B6B !important; }

/* Chat messages */
.chat-thread { color: #1E1E1E !important; }
.chat-group.user .chat-bubble {
  background: #F0F0F0 !important;
  border: 1px solid #E5E5E5 !important;
  color: #1E1E1E !important;
}
.chat-group.user .chat-bubble *,
.chat-group.user .chat-text,
.chat-group.user .chat-text *,
.chat-group.user .chat-group-footer,
.chat-group.user .chat-sender-name,
.chat-group.user .chat-group-timestamp {
  color: #1E1E1E !important;
}

/* Buttons */
.btn {
  background: #FFFFFF !important;
  border: 1px solid #E5E5E5 !important;
  color: #1E1E1E !important;
  border-radius: 8px !important;
  font-weight: 600 !important;
}
.btn:hover { border-color: #D0D0D0 !important; background: #F5F5F5 !important; }
.btn.primary, .btn--primary {
  background: #2F2F2F !important;
  border-color: #2F2F2F !important;
  color: #FFFFFF !important;
}
.btn.primary:hover, .btn--primary:hover { background: #1a1a1a !important; }

/* Selects and inputs */
select, .field select {
  background: #FFFFFF !important;
  border: 1px solid #E5E5E5 !important;
  border-radius: 8px !important;
  color: #1E1E1E !important;
}
select:focus, .field select:focus {
  border-color: #2F2F2F !important;
  outline: none !important;
}

/* Theme toggle */
.theme-toggle__track { background: #F0F0F0 !important; border: 1px solid #E5E5E5 !important; }
.theme-toggle__button { color: #6B6B6B !important; }
.theme-toggle__button.active { color: #1E1E1E !important; }
.theme-toggle__indicator { background: #FFFFFF !important; border: 1px solid #E5E5E5 !important; }

/* Content header */
.content-header { border-bottom: 1px solid #E5E5E5 !important; }

/* Chat controls */
.chat-controls__separator { color: #E5E5E5 !important; }
.btn--icon { color: #6B6B6B !important; }
.btn--icon:hover, .btn--icon.active { color: #1E1E1E !important; }

/* Keyboard shortcuts badge */
.btn-kbd { background: #F0F0F0 !important; border: 1px solid #E5E5E5 !important; color: #6B6B6B !important; }

/* Nav collapse */
.nav-collapse-toggle { color: #6B6B6B !important; }
.nav-collapse-toggle:hover { color: #1E1E1E !important; }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #D0D0D0; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #AAAAAA; }
</style>`;

proxy.on("proxyRes", (proxyRes, req, res) => {
  const ct = String(proxyRes.headers["content-type"] || "").toLowerCase();
  const isHtml = ct.includes("text/html");

  if (!isHtml) {
    // Non-HTML: pipe through untouched
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }

  // HTML: buffer, modify, send
  const chunks = [];
  proxyRes.on("data", (chunk) => chunks.push(chunk));
  proxyRes.on("end", () => {
    let body = Buffer.concat(chunks).toString("utf8");

    // Replace <title>
    body = body.replace(/<title>([^<]*)<\/title>/g, (_m, inner) =>
      `<title>${inner.replace(/OpenClaw/gi, "PM Agent").replace(/Gateway Dashboard/gi, "Dashboard")}</title>`
    );

    // Remove existing favicon links and inject our overrides into <head>
    body = body.replace(/<link[^>]*rel=["'](?:icon|apple-touch-icon)["'][^>]*>/gi, "");
    body = body.replace(/<head([^>]*)>/i, `<head$1>${FONT_LINKS}${GATEWAY_OVERRIDE_CSS}`);

    // Send modified response
    const headers = { ...proxyRes.headers };
    delete headers["content-length"];
    headers["content-type"] = "text/html; charset=utf-8";
    res.writeHead(proxyRes.statusCode, headers);
    res.end(body);
  });
});

// WebSocket upgrade
// ─────────────────────────────────────────────
// Background chat sync (JSONL → Supabase)
// ─────────────────────────────────────────────

let chatSyncRunning = false;

function parseChatSessionJSONL(jsonlContent) {
  const lines = String(jsonlContent || "").split("\n").filter((l) => l.trim());
  let sessionFile = null;
  let startedAt = null;
  let model = null;
  const messages = [];
  let totalTokens = 0;
  let totalCost = 0;
  let lastMessageAt = null;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const timestamp = entry.timestamp || null;

    if (entry.type === "session") {
      sessionFile = entry.id || null;
      startedAt = timestamp;
      continue;
    }
    if (entry.type === "model_change") {
      model = entry.modelId || entry.model || null;
      continue;
    }
    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      const role = msg.role;

      if (role === "user") {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        messages.push({ role: "user", content, createdAt: timestamp });
        if (timestamp) lastMessageAt = timestamp;
        continue;
      }
      if (role === "assistant") {
        const usage = msg.usage || {};
        const msgTokens = usage.totalTokens || 0;
        const msgCost = (usage.cost && usage.cost.total) ? usage.cost.total : 0;
        const msgModel = msg.model || model || null;
        totalTokens += msgTokens;
        totalCost += msgCost;

        const textParts = [];
        if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === "text" && item.text) textParts.push(item.text);
          }
        } else if (typeof msg.content === "string") {
          textParts.push(msg.content);
        }
        const textContent = textParts.join("\n").trim();
        if (textContent) {
          messages.push({ role: "assistant", content: textContent, model: msgModel, tokensUsed: msgTokens, cost: msgCost, createdAt: timestamp });
        }
        if (timestamp) lastMessageAt = timestamp;
      }
    }
  }

  return {
    session: { sessionFile, startedAt, model },
    messages,
    stats: { messageCount: messages.length, totalTokens, totalCost, lastMessageAt },
  };
}

async function runChatSync() {
  if (chatSyncRunning) return { ok: false, reason: "already running" };
  if (!chatSyncDbConfigured()) return { ok: false, reason: "DB not configured" };

  chatSyncRunning = true;
  const startMs = Date.now();
  const results = { synced: 0, skipped: 0, errors: 0 };

  try {
    await chatSyncEnsureSchema();
    const knownSizes = await chatSyncGetFileSizes();

    const agentsDir = path.join(STATE_DIR, "agents");
    if (!fs.existsSync(agentsDir)) { chatSyncRunning = false; return { ok: true, ...results }; }

    for (const agent of fs.readdirSync(agentsDir)) {
      const sDir = path.join(agentsDir, agent, "sessions");
      if (!fs.existsSync(sDir)) continue;

      for (const file of fs.readdirSync(sDir)) {
        if (!file.endsWith(".jsonl")) continue;
        try {
          const filePath = path.join(sDir, file);
          const stat = fs.statSync(filePath);
          const sessionKey = `${agent}/${file.replace(/\.jsonl$/, "")}`;

          // Skip if file size hasn't changed
          const knownSize = knownSizes.get(sessionKey);
          if (knownSize !== undefined && knownSize === stat.size) {
            results.skipped++;
            continue;
          }

          const content = fs.readFileSync(filePath, "utf8");
          const parsed = parseChatSessionJSONL(content);
          if (!parsed.session.sessionFile) parsed.session.sessionFile = sessionKey;

          const sessionId = await chatSyncUpsertSession({
            sessionFile: parsed.session.sessionFile,
            startedAt: parsed.session.startedAt,
            model: parsed.session.model,
            messageCount: parsed.stats.messageCount,
            totalTokens: parsed.stats.totalTokens,
            totalCost: parsed.stats.totalCost,
            fileSize: stat.size,
            lastMessageAt: parsed.stats.lastMessageAt,
          });

          await chatSyncDeleteMessagesBySession(sessionId);
          const allIds = [];
          const BATCH = 200;
          for (let i = 0; i < parsed.messages.length; i += BATCH) {
            const chunk = parsed.messages.slice(i, i + BATCH);
            const { ids } = await chatSyncInsertMessages(sessionId, chunk);
            if (ids) allIds.push(...ids);
          }

          if (allIds.length > 0) {
            chatSyncEmbedMessages(allIds).catch((err) =>
              console.error(`[chat-sync] embedding error for ${file}:`, err.message),
            );
          }
          results.synced++;
        } catch (err) {
          results.errors++;
          console.error(`[chat-sync] error syncing ${file}:`, err.message);
        }
      }
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    if (results.synced > 0) console.log(`[chat-sync] done in ${elapsed}s — synced=${results.synced} skipped=${results.skipped}`);
    return { ok: true, ...results };
  } catch (err) {
    console.error("[chat-sync] fatal error:", err);
    return { ok: false, error: String(err), ...results };
  } finally {
    chatSyncRunning = false;
  }
}

const server = app.listen(PORT, async () => {
  console.log(`[server] listening on :${PORT}`);
  await ensureGatewayRunning();

  // Sync chat sessions to Supabase on startup + every 5 min
  if (chatSyncDbConfigured()) {
    // One-time cleanup of test sessions
    (async () => {
      try {
        await chatSyncEnsureSchema();
        const { sessions } = await chatSyncListSessions({ limit: 200 });
        for (const s of sessions) {
          if (s.session_file && s.session_file.startsWith("test-")) {
            await chatSyncDeleteSession(s.id);
            console.log(`[cleanup] deleted test session: ${s.session_file}`);
          }
        }
      } catch (e) { console.warn("[cleanup] error:", e.message); }
    })();

    const CHAT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
    const doSync = () => runChatSync().catch((e) => console.warn("[chat-sync] error:", e));
    setTimeout(doSync, 10_000);
    setInterval(doSync, CHAT_SYNC_INTERVAL_MS);
  }
});

// Inject gateway auth token on all proxied requests (HTTP + WebSocket)
function injectProxyAuth(req) {
  req.headers["authorization"] = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
  // Rewrite host/origin so gateway treats requests as local
  req.headers.host = `127.0.0.1:${INTERNAL_GATEWAY_PORT}`;
  if (req.headers.origin) {
    req.headers.origin = `http://127.0.0.1:${INTERNAL_GATEWAY_PORT}`;
  }
  // Strip forwarded IP headers so gateway sees local connection
  delete req.headers["x-forwarded-for"];
  delete req.headers["x-forwarded-host"];
  delete req.headers["x-forwarded-proto"];
  delete req.headers["x-forwarded-port"];
  delete req.headers.forwarded;
  delete req.headers["x-real-ip"];
  delete req.headers["cf-connecting-ip"];
  delete req.headers["true-client-ip"];
  delete req.headers["x-client-ip"];
}

server.on("upgrade", (req, socket, head) => {
  if (voiceDemo.handleUpgrade(req, socket, head)) {
    return;
  }
  injectProxyAuth(req);
  proxy.ws(req, socket, head);
});

// Proxy everything not handled above to the gateway
app.use((req, res) => {
  injectProxyAuth(req);
  proxy.web(req, res);
});

// ─────────────────────────────────────────────
// HTML Pages
// ─────────────────────────────────────────────

const STYLE = `
:root {
  --bg: #F9F9F9;
  --text: #1E1E1E;
  --text-muted: #6B6B6B;
  --btn-secondary-bg: #E0E0E0;
  --btn-primary-bg: #2F2F2F;
  --success: #4CAF50;
  --danger: #E53935;
  --radius: 8px;
  --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --card-bg: #FFFFFF;
  --border: #E5E5E5;
  --card-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
  --card-shadow-hover: 0 4px 12px rgba(0,0,0,0.1);
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.6;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:'liga' 1,'calt' 1}
a{color:var(--text-muted);text-decoration:none;transition:color .15s}a:hover{color:var(--text)}
.container{max-width:900px;margin:0 auto;padding:2rem 2rem 4rem}
h1{font-size:1.75rem;font-weight:700;margin-bottom:.5rem;color:var(--text)}
.subtitle{font-size:.95rem;color:var(--text-muted);margin-bottom:2rem;line-height:1.5}
h2{font-size:1.1rem;font-weight:700;color:var(--text);margin:2rem 0 .75rem}
.card{background:var(--card-bg);border-radius:var(--radius);padding:1.5rem;margin-bottom:1rem;border:1px solid var(--border);box-shadow:var(--card-shadow);transition:box-shadow .2s}
.card:hover{box-shadow:var(--card-shadow-hover)}
.card h3{font-size:1rem;font-weight:700;margin-bottom:.25rem;color:var(--text)}
.card p{font-size:.875rem;color:var(--text-muted);line-height:1.5}
.badge{display:inline-block;padding:.2rem .6rem;border-radius:4px;font-size:.75rem;font-weight:600}
.badge.on{background:#E8F5E9;color:#2E7D32}
.badge.off{background:#FFEBEE;color:#C62828}
nav{display:flex;gap:1.5rem;margin-bottom:2rem;border-bottom:1px solid var(--border);padding-bottom:.75rem}
nav a{font-size:.9rem;font-weight:500;padding-bottom:.75rem;border-bottom:2px solid transparent;transition:all .15s}
nav a.active{color:var(--text);border-bottom-color:var(--text)}
.btn{display:inline-flex;align-items:center;gap:.4rem;padding:10px 20px;background:var(--btn-secondary-bg);border:none;border-radius:var(--radius);color:var(--text);font-size:.875rem;font-weight:500;cursor:pointer;transition:background .15s;font-family:var(--font)}
.btn:hover{background:#D0D0D0}
.btn.primary{background:var(--btn-primary-bg);color:#FFFFFF}.btn.primary:hover{background:#1a1a1a}
.btn.danger{background:var(--danger);color:#FFFFFF}.btn.danger:hover{background:#C62828}
label{display:block;font-size:.875rem;font-weight:500;color:var(--text);margin-top:.75rem;margin-bottom:.25rem}
input,select,textarea{width:100%;padding:10px 12px;margin:.25rem 0 .5rem;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:.875rem;font-family:var(--font);transition:border-color .15s}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--text)}
input::placeholder{color:#B0B0B0}
textarea{min-height:80px;resize:vertical}
.status-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:.5rem}
.status-dot.green{background:var(--success)}.status-dot.red{background:var(--danger)}.status-dot.yellow{background:#FFC107}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:600px){.grid-2{grid-template-columns:1fr}.container{padding:1rem}}
.mono{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:.8rem}
.messages{max-height:500px;overflow-y:auto;padding:1rem;background:var(--bg);border-radius:var(--radius);border:1px solid var(--border)}
.msg{padding:.75rem 0;border-bottom:1px solid var(--border)}
.msg:last-child{border-bottom:none}
.msg .role{font-size:.7rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
.msg .content{font-size:.875rem;white-space:pre-wrap;word-break:break-word;color:var(--text)}
.help-text{font-size:.8rem;color:var(--text-muted);margin-top:.25rem;line-height:1.4}
.status-banner{display:flex;align-items:center;padding:1rem 1.25rem;border-radius:var(--radius);margin-bottom:1.5rem;font-size:.9rem;font-weight:500}
.status-banner.running{background:#E8F5E9;color:#2E7D32;border:1px solid #C8E6C9}
.status-banner.stopped{background:#FFF3E0;color:#E65100;border:1px solid #FFE0B2}
.status-banner.unconfigured{background:#FFEBEE;color:#C62828;border:1px solid #FFCDD2}
.step-number{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--btn-primary-bg);color:#fff;font-size:.75rem;font-weight:700;margin-right:.5rem;flex-shrink:0}
.step{display:flex;align-items:flex-start;margin-bottom:1rem}
.step-content{flex:1}
.step-content strong{font-size:.9rem}
.step-content p{font-size:.825rem;color:var(--text-muted);margin-top:.15rem}
.divider{border:none;border-top:1px solid var(--border);margin:1.5rem 0}
`;

function pageHeader(active) {
  const links = [
    ["/", "Home"],
    ["/chat?session=main", "Chat"],
    ["/connectors", "Connectors"],
    ["/memory", "Memory"],
  ];
  return `<nav style="display:flex;align-items:center;justify-content:space-between;padding:0.875rem 1.25rem;border-bottom:1px solid #E5E5E5;box-sizing:border-box;margin:0">
  <a href="/" style="text-decoration:none;color:inherit;border-bottom:none;padding:1px">
    <div style="display:flex;flex-direction:column;gap:0.1rem">
      <span style="font-weight:700;font-size:1.1rem;letter-spacing:-0.02em;line-height:1">PM AGENT</span>
      <span style="color:#6B6B6B;font-size:.7rem">OpenClaw</span>
    </div>
  </a>
  <div style="display:flex;align-items:center;gap:1.25rem;font-size:.875rem">
    ${links.map(([href, label]) =>
      `<a href="${href}" style="color:${active === href ? '#1E1E1E;font-weight:600' : '#6B6B6B'};text-decoration:none;transition:color .15s;border-bottom:none;padding:1px">${label}</a>`
    ).join("")}
    <a id="nav-name-pill" href="/setup" style="display:none;padding:5px 12px;border-radius:8px;background:#2F2F2F;color:#fff;font-size:.75rem;font-weight:500;line-height:normal;text-decoration:none;transition:opacity .15s;white-space:nowrap;border-bottom:none" onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'"></a>
    <a id="nav-cog" href="/setup" style="display:flex;align-items:center;color:#6B6B6B;text-decoration:none;transition:color .15s;border-bottom:none;padding:1px" title="Settings">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </a>
  </div>
</nav>
<script>
(function(){
  fetch('/setup/api/user-name',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
    var full=((j.firstName||'')+' '+(j.lastName||'')).trim();
    if(full){
      var pill=document.getElementById('nav-name-pill');
      pill.textContent=full;
      pill.style.display='inline-block';
      document.getElementById('nav-cog').style.display='none';
    }
  }).catch(function(){});
})();
</script>`;
}

function loginPage({ error = "", next = "/", submittedUsername = "", username = SETUP_USERNAME } = {}) {
  const safeNext = escapeHtml(sanitizeNextPath(next));
  const initialUsername = escapeHtml(submittedUsername || username || "");
  const displayUsername = escapeHtml(username || SETUP_USERNAME);
  const safeError = escapeHtml(error);
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — PM Agent</title>
${FONT_LINKS}
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#F9F9F9;
  --text:#1E1E1E;
  --text-muted:#6B6B6B;
  --cta:#2F2F2F;
  --secondary:#E0E0E0;
  --surface:#FFFFFF;
  --border:#E5E5E5;
  --danger:#C62828;
  --danger-bg:#FFEBEE;
  --radius:8px;
  --shadow:0 1px 3px rgba(0,0,0,0.08),0 1px 2px rgba(0,0,0,0.06);
  --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh}
.shell{min-height:100vh;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(360px,.85fr)}
.hero{position:relative;padding:3rem 4rem;display:flex;align-items:center;justify-content:center}
.brand{position:absolute;top:3rem;left:4rem;display:flex;flex-direction:column;gap:.1rem}
.brand strong{font-size:1.15rem;letter-spacing:-.02em}
.brand span{font-size:.75rem;color:var(--text-muted)}
.hero-copy{max-width:560px}
.hero h1{font-size:3.25rem;line-height:1.05;letter-spacing:-.04em}
.side{display:flex;align-items:center;justify-content:center;padding:2rem;background:linear-gradient(180deg,#FFFFFF 0%,#F4F4F4 100%);border-left:1px solid var(--border)}
.login-card{width:min(420px,100%);background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 12px 30px rgba(0,0,0,0.08);padding:2rem}
.login-card h2{font-size:1.5rem;letter-spacing:-.02em;margin-bottom:.35rem}
.login-card p{font-size:.9rem;color:var(--text-muted);line-height:1.55;margin-bottom:1.25rem}
.error{padding:.8rem .9rem;border-radius:var(--radius);background:var(--danger-bg);border:1px solid #FFCDD2;color:var(--danger);font-size:.85rem;font-weight:500;margin-bottom:1rem}
label{display:block;font-size:.84rem;font-weight:600;margin:0 0 .35rem}
input{width:100%;padding:.8rem .9rem;border:1px solid var(--border);border-radius:var(--radius);font:inherit;color:var(--text);background:#fff;margin-bottom:.9rem}
input:focus{outline:none;border-color:var(--text)}
input::placeholder{color:#A9A9A9}
.btn{width:100%;display:inline-flex;align-items:center;justify-content:center;gap:.45rem;padding:.9rem 1rem;border:none;border-radius:var(--radius);font:inherit;font-weight:600;background:var(--cta);color:#fff;cursor:pointer;transition:opacity .15s}
.btn:hover{opacity:.88}
@media(max-width:980px){
  .shell{grid-template-columns:1fr}
  .hero{padding:2rem 1.25rem 1rem;display:flex;align-items:flex-start;justify-content:flex-start;flex-direction:column}
  .brand{position:static;margin-bottom:2rem}
  .side{padding:1.25rem;border-left:none;border-top:1px solid var(--border)}
  .hero h1{font-size:2.35rem}
}
</style></head><body>
<div class="shell">
  <section class="hero">
    <div class="brand">
      <strong>PM AGENT</strong>
      <span>OpenClaw</span>
    </div>
    <div class="hero-copy">
      <h1>Always-On PM Agent</h1>
    </div>
  </section>
  <aside class="side">
    <div class="login-card">
      <h2>Sign in</h2>
      <p>Use your operator credentials to access setup, chat, connectors, and memory.</p>
      ${error ? `<div class="error">${safeError}</div>` : ""}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${safeNext}">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" value="${initialUsername}" placeholder="${displayUsername}" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" placeholder="Enter password" autocomplete="current-password" required>
        <button class="btn" type="submit">Continue to PM Agent</button>
      </form>
    </div>
  </aside>
</div>
</body></html>`;
}

function homePage() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PM Agent</title>
${FONT_LINKS}
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#F9F9F9;
  --text:#1E1E1E;
  --text-muted:#6B6B6B;
  --cta:#2F2F2F;
  --secondary:#E0E0E0;
  --radius:8px;
  --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column}
.hero{flex:1;display:flex;align-items:center;justify-content:center;padding:2rem}
.hero-inner{max-width:800px;width:100%;text-align:center}
.hero h1{font-size:48px;font-weight:700;line-height:1.15;letter-spacing:-.02em;margin-bottom:1rem}
.hero p{font-size:16px;color:var(--text-muted);line-height:1.6;max-width:520px;margin:0 auto 2.5rem}
.btn-row{display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap}
.btn{display:inline-block;text-decoration:none;font-family:var(--font);font-size:.9375rem;font-weight:600;padding:.75rem 1.5rem;border-radius:var(--radius);transition:opacity .15s}
.btn:hover{opacity:.85}
.btn-primary{background:var(--cta);color:#fff}
.btn-secondary{background:var(--secondary);color:var(--text)}
.footer{width:100%;text-align:center;padding:2rem;font-size:.75rem;color:var(--text-muted)}
@media(max-width:600px){
  .hero h1{font-size:32px}
  .hero p{font-size:15px}
  .btn-row{flex-direction:column;align-items:center}
  .btn{width:100%;max-width:260px;text-align:center}
}
</style></head><body>

<a id="home-name-pill" href="/setup" style="display:none;position:absolute;top:1rem;right:1.25rem;padding:5px 12px;border-radius:8px;background:#2F2F2F;color:#fff;font-size:.75rem;font-weight:500;text-decoration:none;transition:opacity .15s" onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'"></a>
<a id="home-cog" href="/setup" style="position:absolute;top:1rem;right:1.25rem;color:#6B6B6B;text-decoration:none" title="Settings">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
</a>

<div class="hero">
  <div class="hero-inner">
    <h1>Your always-on PM agent</h1>
    <p>Monitors Slack, tracks decisions, and surfaces what needs your attention.</p>
    <div class="btn-row">
      <a href="/chat?session=main" class="btn btn-primary">Chat</a>
      <a href="/connectors" class="btn btn-secondary">Connectors</a>
      <a href="/memory" class="btn btn-secondary">Memory</a>
    </div>
  </div>
</div>

<div class="footer">
  PM Agent &middot; Powered by OpenClaw
</div>

<script>
(function(){
  fetch('/setup/api/user-name',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
    var full=((j.firstName||'')+' '+(j.lastName||'')).trim();
    if(full){
      var pill=document.getElementById('home-name-pill');
      pill.textContent=full;
      pill.style.display='inline-block';
      document.getElementById('home-cog').style.display='none';
    }
  }).catch(function(){});
})();
</script>
</body></html>`;
}

function setupPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Setup — PM Agent</title>
${FONT_LINKS}<style>${STYLE}</style></head><body>
${pageHeader("/setup")}
<div class="container">
<h1>Agent Setup</h1>
<p class="subtitle">Get your always-on PM agent running in a few steps. Once the gateway starts, your agent is live and ready to chat.</p>

<div id="status-banner" class="status-banner unconfigured">
  <span class="status-dot red"></span>
  <span>Checking status...</span>
</div>

<h2>Preflight Checklist</h2>
<div class="card">
  <p style="margin-bottom:.75rem">Confirm these before you run onboarding.</p>
  <div class="step">
    <span class="step-number">✓</span>
    <div class="step-content">
      <strong>Persistent volume mounted at <code class="mono">/data</code></strong>
      <p>The service expects persistent state in <code class="mono">/data/.openclaw</code> and workspace files in <code class="mono">/data/workspace</code>.</p>
    </div>
  </div>
  <div class="step">
    <span class="step-number">✓</span>
    <div class="step-content">
      <strong>Core environment variables are set</strong>
      <p>At minimum: <code class="mono">OPENROUTER_API_KEY</code>, <code class="mono">SUPABASE_POOLER_URL</code>, <code class="mono">OPENCLAW_STATE_DIR</code>, and <code class="mono">OPENCLAW_WORKSPACE_DIR</code>.</p>
    </div>
  </div>
  <div class="step">
    <span class="step-number">✓</span>
    <div class="step-content">
      <strong>Slack app is fully configured if you want DMs</strong>
      <p>Enable Socket Mode, App Home Messages Tab, the required bot scopes, the required bot events, and reinstall the app after scope changes.</p>
    </div>
  </div>
  <p class="help-text" style="margin-top:.75rem">Full operator setup is documented in <code class="mono">README.md</code>, <code class="mono">docs/deployment.md</code>, and <code class="mono">docs/slack-setup.md</code>.</p>
</div>

<h2>Getting Started</h2>
<div class="card">
  <div class="step">
    <span class="step-number">1</span>
    <div class="step-content">
      <strong>Connect a channel (optional)</strong>
      <p>Add Slack tokens below to let your agent listen in channels. You can skip this and use WebChat only.</p>
    </div>
  </div>
  <div class="step">
    <span class="step-number">2</span>
    <div class="step-content">
      <strong>Start the gateway</strong>
      <p>Click "Save & Start Gateway" to boot the OpenClaw engine. This runs the onboard process and launches the agent.</p>
    </div>
  </div>
  <div class="step">
    <span class="step-number">3</span>
    <div class="step-content">
      <strong>Start chatting</strong>
      <p>Once the gateway is running, go to the <a href="/" style="color:var(--btn-primary-bg);font-weight:500">Chat</a> tab to talk to your agent via WebChat.</p>
    </div>
  </div>
</div>

<h2>Your Name</h2>
<div class="card">
  <div style="display:flex;gap:.75rem">
    <div style="flex:1"><label>First Name</label><input type="text" id="firstName" placeholder="First"></div>
    <div style="flex:1"><label>Last Name</label><input type="text" id="lastName" placeholder="Last"></div>
  </div>
  <p class="help-text">Used to personalize startup behavior, <code class="mono">USER.md</code>, and the nav bar. Optional.</p>
  <div style="margin-top:.75rem;display:flex;align-items:center;gap:.75rem">
    <button class="btn" id="saveNameBtn">Save Name</button>
    <span id="nameStatus" style="font-size:.825rem;color:var(--text-muted)"></span>
  </div>
</div>

<h2>Channel Configuration</h2>
<div class="card">
  <label>Provider</label>
  <select id="provider">
    <option value="slack">Slack</option>
    <option value="telegram">Telegram</option>
    <option value="discord">Discord</option>
  </select>
  <p class="help-text">Choose where your agent will listen for messages. Slack is the most common choice.</p>

  <div id="slack-fields">
    <label>Bot Token</label>
    <input type="password" id="botToken" placeholder="xoxb-...">
    <p class="help-text">Find this in your Slack app settings under OAuth & Permissions. Starts with <code class="mono">xoxb-</code></p>

    <label>App Token</label>
    <input type="password" id="appToken" placeholder="xapp-...">
    <p class="help-text">Required for Socket Mode. Find it under Basic Information > App-Level Tokens. Starts with <code class="mono">xapp-</code></p>
  </div>

  <div id="generic-fields" style="display:none">
    <label>Bot Token</label>
    <input type="password" id="genericToken" placeholder="Bot token">
    <p class="help-text">Your bot's API token from the provider dashboard.</p>
  </div>

  <div style="margin-top:1.25rem;display:flex;align-items:center;gap:.75rem">
    <button class="btn primary" id="saveBtn">Save & Start Gateway &rarr;</button>
    <span id="saveStatus" style="font-size:.825rem;color:var(--text-muted)"></span>
  </div>
  <p class="help-text" style="margin-top:.5rem">You can leave token fields empty to use WebChat only. The gateway will still start.</p>
</div>

<hr class="divider">

<h2>Gateway Control</h2>
<div class="card">
  <p style="margin-bottom:.75rem">Restart the gateway if you've changed environment variables or updated the configuration below.</p>
  <div style="display:flex;align-items:center;gap:.75rem">
    <button class="btn" id="restartBtn">Restart Gateway</button>
    <span id="restartStatus" style="font-size:.825rem;color:var(--text-muted)"></span>
  </div>
</div>

<h2>Advanced Configuration</h2>
<div class="card">
  <p style="margin-bottom:.75rem">Raw OpenClaw config JSON. Edit carefully — invalid config can prevent the gateway from starting.</p>
  <textarea id="configEditor" class="mono" style="min-height:200px"></textarea>
  <div style="margin-top:.75rem;display:flex;align-items:center;gap:.75rem">
    <button class="btn" id="configSave">Save Config</button>
    <span id="configStatus" style="font-size:.825rem;color:var(--text-muted)"></span>
  </div>
</div>
</div>

<script>
(function(){
  var provider = document.getElementById('provider');
  var slackFields = document.getElementById('slack-fields');
  var genericFields = document.getElementById('generic-fields');

  provider.onchange = function() {
    slackFields.style.display = provider.value === 'slack' ? '' : 'none';
    genericFields.style.display = provider.value !== 'slack' ? '' : 'none';
  };

  function refreshStatus() {
    fetch('/setup/api/status',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
      var el = document.getElementById('status-banner');
      if (j.gatewayRunning) {
        el.className = 'status-banner running';
        el.innerHTML = '<span class="status-dot green"></span><span>Gateway is running. <a href="/" style="color:inherit;font-weight:600;text-decoration:underline">Open Chat &rarr;</a></span>';
      } else if (j.configured) {
        el.className = 'status-banner stopped';
        el.innerHTML = '<span class="status-dot yellow"></span><span>Configured but gateway is stopped. Click Restart Gateway below.</span>';
      } else {
        el.className = 'status-banner unconfigured';
        el.innerHTML = '<span class="status-dot red"></span><span>Not configured yet. Follow the steps below to get started.</span>';
      }
    });
  }

  refreshStatus();

  fetch('/setup/api/user-name',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
    if(j.firstName) document.getElementById('firstName').value = j.firstName;
    if(j.lastName) document.getElementById('lastName').value = j.lastName;
  });

  fetch('/setup/api/config',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
    document.getElementById('configEditor').value = JSON.stringify(j,null,2);
  });

  document.getElementById('saveNameBtn').onclick = function(){
    var nb = { firstName: document.getElementById('firstName').value, lastName: document.getElementById('lastName').value };
    fetch('/setup/api/user-name',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(nb)})
      .then(function(r){return r.json()}).then(function(j){
        document.getElementById('nameStatus').textContent = j.ok ? 'Saved!' : 'Error';
        if(j.ok) document.getElementById('nameStatus').style.color = 'var(--success)';
      }).catch(function(){ document.getElementById('nameStatus').textContent = 'Error'; });
  };

  document.getElementById('saveBtn').onclick = function(){
    var p = provider.value;
    var body = { provider: p };
    if (p === 'slack') {
      body.token = document.getElementById('botToken').value || 'webchat-only';
      body.appToken = document.getElementById('appToken').value;
    } else {
      body.token = document.getElementById('genericToken').value || 'webchat-only';
    }
    var btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Starting...';
    document.getElementById('saveStatus').textContent = 'Booting gateway — this may take up to 2 minutes...';
    fetch('/setup/api/onboard',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json()}).then(function(j){
        btn.disabled = false;
        btn.innerHTML = 'Save & Start Gateway &rarr;';
        document.getElementById('saveStatus').textContent = j.ok ? 'Gateway started successfully!' : ('Error: ' + (j.error||'unknown'));
        if (j.ok) document.getElementById('saveStatus').style.color = 'var(--success)';
        refreshStatus();
      }).catch(function(e){
        btn.disabled = false;
        btn.innerHTML = 'Save & Start Gateway &rarr;';
        document.getElementById('saveStatus').textContent = 'Error: '+e;
      });
  };

  document.getElementById('restartBtn').onclick = function(){
    var btn = document.getElementById('restartBtn');
    btn.disabled = true;
    document.getElementById('restartStatus').textContent = 'Restarting...';
    fetch('/setup/api/restart',{method:'POST',credentials:'same-origin'}).then(function(r){return r.json()}).then(function(){
      btn.disabled = false;
      document.getElementById('restartStatus').textContent = 'Restarted!';
      refreshStatus();
    });
  };

  document.getElementById('configSave').onclick = function(){
    try {
      var obj = JSON.parse(document.getElementById('configEditor').value);
      fetch('/setup/api/config',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)})
        .then(function(r){return r.json()}).then(function(j){ document.getElementById('configStatus').textContent = j.ok ? 'Saved!' : 'Error'; });
    } catch(e) { document.getElementById('configStatus').textContent = 'Invalid JSON'; }
  };
})();
</script></body></html>`;
}

function connectorsPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connectors — PM Agent</title>
${FONT_LINKS}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F9F9F9;color:#1E1E1E;-webkit-font-smoothing:antialiased}
.page{max-width:800px;margin:0 auto;padding:2.5rem 2rem 3rem}
.page-title{font-size:1.5rem;font-weight:700;margin-bottom:.25rem}
.page-desc{font-size:.875rem;color:#6B6B6B;margin-bottom:2rem}
.count{font-size:.8125rem;color:#6B6B6B;margin-bottom:1.25rem}
.count strong{color:#1E1E1E}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:640px){.grid{grid-template-columns:1fr}}
.card{display:flex;align-items:center;gap:14px;background:#FFFFFF;border:1px solid #E5E5E5;border-radius:10px;padding:16px 18px;transition:border-color .15s;cursor:pointer}
.card:hover{border-color:#D0D0D0;background:#FAFAFA}
.card-logo{width:40px;height:40px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:#F5F5F5;overflow:hidden}
.card-logo svg{width:24px;height:24px}
.card-body{flex:1;min-width:0}
.card-name{font-size:.875rem;font-weight:600;line-height:1.3}
.card-desc{font-size:.75rem;color:#6B6B6B;line-height:1.4;margin-top:2px}
.badge{flex-shrink:0;font-size:.6875rem;font-weight:600;padding:3px 8px;border-radius:999px}
.badge.connected{background:#ECFDF5;color:#059669}
.badge.not-configured{background:#F5F5F5;color:#9CA3AF}
nav{display:flex;align-items:center;justify-content:space-between;padding:0.875rem 1.25rem;border-bottom:1px solid #E5E5E5}
nav a{font-size:.875rem;color:#6B6B6B;text-decoration:none;transition:color .15s}
nav a:hover{color:#1E1E1E}
nav a.active{color:#1E1E1E;font-weight:600}

/* Slider */
.slider-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.2);z-index:100;opacity:0;pointer-events:none;transition:opacity .3s ease}
.slider-backdrop.open{opacity:1;pointer-events:auto}
.slider-pane{position:fixed;top:0;right:0;bottom:0;width:100%;max-width:480px;background:#FFFFFF;z-index:101;transform:translateX(100%);transition:transform .3s cubic-bezier(.16,1,.3,1);box-shadow:-8px 0 24px rgba(0,0,0,.1);display:flex;flex-direction:column}
.slider-pane.open{transform:translateX(0)}
.slider-header{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid #E5E5E5}
.slider-header .title{font-weight:700;font-size:1.125rem}
.slider-close{background:none;border:none;cursor:pointer;padding:4px;color:#6B6B6B;font-size:1.25rem;line-height:1}
.slider-close:hover{color:#1E1E1E}
.slider-body{flex:1;overflow-y:auto;padding:24px}
.field-group{margin-bottom:20px}
.field-label{display:block;font-size:.8125rem;font-weight:600;margin-bottom:6px;color:#1E1E1E}
.field-hint{font-size:.75rem;color:#9CA3AF;margin-bottom:6px}
.field-input{width:100%;padding:10px 12px;border:1px solid #E5E5E5;border-radius:8px;font-size:.875rem;font-family:inherit;transition:border-color .15s;background:#FAFAFA}
.field-input:focus{outline:none;border-color:#1E1E1E;background:#FFFFFF}
.field-input::placeholder{color:#C0C0C0}
.slider-footer{padding:16px 24px;border-top:1px solid #E5E5E5;display:flex;align-items:center;gap:12px}
.btn-save{padding:10px 24px;border:none;border-radius:8px;font-size:.875rem;font-weight:600;cursor:pointer;font-family:inherit;background:#1E1E1E;color:#FFFFFF;transition:opacity .15s}
.btn-save:hover{opacity:.85}
.btn-save:disabled{opacity:.5;cursor:not-allowed}
.save-status{font-size:.8125rem;color:#6B6B6B}
.save-status.error{color:#DC2626}
.save-status.success{color:#059669}
.voice-summary{padding:14px 16px;border:1px solid #E5E5E5;border-radius:10px;background:#FAFAFA;font-size:.875rem;color:#1E1E1E;line-height:1.5}
.voice-summary strong{display:block;font-size:.8125rem;text-transform:uppercase;letter-spacing:.05em;color:#6B6B6B;margin-bottom:6px}
.slider-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.slider-link{display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:8px;font-size:.875rem;font-weight:600;text-decoration:none;border:1px solid #E5E5E5;background:#FFFFFF;color:#1E1E1E;transition:all .15s}
.slider-link:hover{background:#F5F5F5;border-color:#D0D0D0}
.slider-link.primary{background:#1E1E1E;color:#FFFFFF;border-color:#1E1E1E}
.slider-link.primary:hover{opacity:.88}
.session-mini-list{display:flex;flex-direction:column;gap:10px;margin-top:18px}
.session-mini{display:block;padding:12px 14px;border:1px solid #E5E5E5;border-radius:10px;background:#FCFCFC;text-decoration:none;color:#1E1E1E;transition:border-color .15s,background .15s}
.session-mini:hover{border-color:#D0D0D0;background:#FAFAFA}
.session-mini strong{display:block;font-size:.875rem;line-height:1.3}
.session-mini span{display:block;font-size:.75rem;color:#6B6B6B;margin-top:4px}
@media(max-width:640px){.slider-pane{max-width:100%}}
</style></head><body>
${pageHeader("/connectors")}
<div class="page">
  <h1 class="page-title">Connectors</h1>
  <p class="page-desc">External tools and services connected to your PM agent.</p>
  <div class="count" id="count"></div>
  <div class="grid" id="grid"><p style="color:#6B6B6B;font-size:.875rem">Loading connectors...</p></div>
</div>

<div class="slider-backdrop" id="sliderBackdrop"></div>
<div class="slider-pane" id="sliderPane">
  <div class="slider-header">
    <span class="title" id="sliderTitle">Configure</span>
    <button class="slider-close" id="sliderClose">&times;</button>
  </div>
  <div class="slider-body" id="sliderBody"></div>
  <div class="slider-footer">
    <button class="btn-save" id="sliderSave">Save</button>
    <span class="save-status" id="sliderStatus"></span>
  </div>
</div>

<script>
(function(){
  var LOGOS = {
    slack: '<svg viewBox="0 0 127 127" xmlns="http://www.w3.org/2000/svg"><path d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2S.8 87.3.8 80s5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2s13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2s-13.2-5.9-13.2-13.2V80z" fill="#E01E5A"/><path d="M47 27c-7.3 0-13.2-5.9-13.2-13.2S39.7.6 47 .6s13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2s-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9s5.9-13.2 13.2-13.2H47z" fill="#36C5F0"/><path d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2s13.2 5.9 13.2 13.2-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2s-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6s13.2 5.9 13.2 13.2v33.1z" fill="#2EB67D"/><path d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2s-5.9 13.2-13.2 13.2-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2s5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2s-5.9 13.2-13.2 13.2H80.1z" fill="#ECB22E"/></svg>',
    confluence: '<svg viewBox="0 0 24 24" fill="#1868DB"><path d="M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.488-.834.81-1.416 1.47-2.654 2.96-2.343 5.661-1.167l4.763 2.074a.764.764 0 0 0 .994-.41l2.166-5.163a.757.757 0 0 0-.394-.982c-1.463-.636-4.337-1.886-6.8-2.958-5.658-2.465-10.44-1.899-12.715 4.943zM23.131 5.743c.248-.382.53-.875.764-1.245a.764.764 0 0 0-.256-1.04L18.674.404a.764.764 0 0 0-1.058.26c-.2.332-.489.834-.81 1.416-1.47 2.654-2.96 2.343-5.662 1.167L6.381 1.174a.764.764 0 0 0-.994.41L3.221 6.747a.757.757 0 0 0 .394.982c1.464.636 4.337 1.886 6.801 2.958 5.658 2.465 10.44 1.899 12.715-4.944z"/></svg>',
    github: '<svg viewBox="0 0 24 24" fill="#1E1E1E"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>',
    voice: '<svg viewBox="0 0 24 24" fill="none" stroke="#1E1E1E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M4 12a8 8 0 0 1 8-8"/><path d="M20 12a8 8 0 0 0-8-8"/><path d="M6.5 12a5.5 5.5 0 0 1 5.5-5.5"/><path d="M17.5 12A5.5 5.5 0 0 0 12 6.5"/><path d="M12 14.75a2.75 2.75 0 1 0 0-5.5a2.75 2.75 0 0 0 0 5.5Z"/><path d="M9.75 17.5c.74.33 1.48.5 2.25.5s1.51-.17 2.25-.5"/></svg>',
  };

  var currentConnectorId = null;
  var connectorsList = [];

  function connectorById(id) {
    return connectorsList.find(function(item){ return item.id === id; }) || null;
  }

  function showVoicePanel() {
    var connector = connectorById('voice') || { configured: false, name: 'Voice' };
    document.getElementById('sliderTitle').textContent = connector.name;
    document.getElementById('sliderStatus').textContent = '';
    document.getElementById('sliderSave').style.display = 'none';
    document.getElementById('sliderBody').innerHTML = '<p style="color:#6B6B6B;font-size:.875rem">Loading voice sessions...</p>';

    fetch('/api/voice-demo/sessions', { credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(j){
        var sessions = j.sessions || [];
        var latest = sessions[0] || null;
        var html = ''
          + '<div class="voice-summary"><strong>Voice</strong>'
          + (connector.configured
            ? 'Start voice calls from chat with the voice discovery skill, then monitor the live session here.'
            : 'Voice is not fully configured on the server yet. Once the backend is ready, this drawer will link into the live session workspace.')
          + '</div>'
          + '<div class="slider-actions">'
          + '<a class="slider-link primary" href="/voice/live">Open live sessions</a>'
          + (latest ? '<a class="slider-link" href="/voice/live?sessionId=' + encodeURIComponent(latest.id) + '">Open latest session</a>' : '')
          + '</div>';

        if (sessions.length) {
          html += '<div class="session-mini-list">';
          sessions.slice(0, 5).forEach(function(session){
            var label = session.targetBusiness || session.targetName || session.toNumber || 'Untitled session';
            var stamp = session.updatedAt ? new Date(session.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
            html += '<a class="session-mini" href="/voice/live?sessionId=' + encodeURIComponent(session.id) + '">'
              + '<strong>' + label + '</strong>'
              + '<span>' + (session.status || 'idle') + (stamp ? ' · ' + stamp : '') + '</span>'
              + '</a>';
          });
          html += '</div>';
        } else {
          html += '<p class="field-hint" style="margin-top:16px">No recent sessions yet. Start one from chat and come back here to monitor it.</p>';
        }
        document.getElementById('sliderBody').innerHTML = html;
      })
      .catch(function(){
        document.getElementById('sliderBody').innerHTML = '<p style="color:#DC2626">Failed to load voice sessions.</p>';
      });
  }

  function openSlider(id, name) {
    currentConnectorId = id;
    document.getElementById('sliderTitle').textContent = id === 'voice' ? name : 'Configure ' + name;
    document.getElementById('sliderBody').innerHTML = '<p style="color:#6B6B6B;font-size:.875rem">Loading fields...</p>';
    document.getElementById('sliderStatus').textContent = '';
    document.getElementById('sliderSave').style.display = id === 'voice' ? 'none' : 'inline-flex';
    document.getElementById('sliderBackdrop').classList.add('open');
    document.getElementById('sliderPane').classList.add('open');

    if (id === 'voice') {
      showVoicePanel();
      return;
    }

    fetch('/connectors/api/fields/' + id, {credentials:'same-origin'})
      .then(function(r){ return r.json(); })
      .then(function(j){
        var html = '';
        j.fields.forEach(function(f){
          html += '<div class="field-group">';
          html += '<label class="field-label">' + f.label + '</label>';
          if (f.hint) html += '<div class="field-hint">' + f.hint + '</div>';
          html += '<input class="field-input" data-key="' + f.key + '" type="' + (f.type || 'text') + '" placeholder="' + (f.placeholder || '') + '" value="' + (f.hasValue ? f.currentValue : '') + '">';
          html += '</div>';
        });
        document.getElementById('sliderBody').innerHTML = html;
      })
      .catch(function(){ document.getElementById('sliderBody').innerHTML = '<p style="color:#DC2626">Failed to load fields.</p>'; });
  }

  function closeSlider() {
    document.getElementById('sliderBackdrop').classList.remove('open');
    document.getElementById('sliderPane').classList.remove('open');
    document.getElementById('sliderSave').style.display = 'inline-flex';
    currentConnectorId = null;
  }

  document.getElementById('sliderBackdrop').addEventListener('click', closeSlider);
  document.getElementById('sliderClose').addEventListener('click', closeSlider);

  document.getElementById('sliderSave').addEventListener('click', function(){
    if (!currentConnectorId) return;
    var fields = {};
    var inputs = document.getElementById('sliderBody').querySelectorAll('.field-input');
    var hasValue = false;
    inputs.forEach(function(inp){
      var val = inp.value.trim();
      // Skip masked values (contain bullet chars) unless user edited
      if (val && val.indexOf('\u2022') === -1) {
        fields[inp.getAttribute('data-key')] = val;
        hasValue = true;
      }
    });
    if (!hasValue) { document.getElementById('sliderStatus').textContent = 'Enter at least one value'; return; }

    var btn = document.getElementById('sliderSave');
    var status = document.getElementById('sliderStatus');
    btn.disabled = true;
    status.className = 'save-status';
    status.textContent = 'Saving...';

    fetch('/connectors/api/save', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ id: currentConnectorId, fields: fields })
    })
    .then(function(r){ return r.json().then(function(j){ return {ok: r.ok, body: j}; }); })
    .then(function(res){
      btn.disabled = false;
      if (res.ok && res.body.ok) {
        status.className = 'save-status success';
        status.textContent = 'Saved! Gateway restarting...';
        refreshCards();
        setTimeout(function(){ status.textContent = ''; }, 3000);
      } else {
        status.className = 'save-status error';
        status.textContent = res.body.error || 'Save failed';
      }
    })
    .catch(function(){
      btn.disabled = false;
      status.className = 'save-status error';
      status.textContent = 'Network error';
    });
  });

  function refreshCards() {
    fetch('/connectors/api/status',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
      connectorsList = j.connectors;
      var connected = connectorsList.filter(function(c){return c.configured}).length;
      document.getElementById('count').innerHTML = '<strong>'+connected+'</strong> of '+connectorsList.length+' connected';
      document.getElementById('grid').innerHTML = connectorsList.map(function(c){
        var isConn = c.configured;
        var badgeCls = isConn ? 'badge connected' : 'badge not-configured';
        var badgeText = isConn ? 'Connected' : 'Not configured';
        var logo = LOGOS[c.id] || '<svg viewBox="0 0 24 24" fill="#9CA3AF"><circle cx="12" cy="12" r="10"/></svg>';
        return '<div class="card" data-id="'+c.id+'" data-name="'+c.name+'">'
          + '<div class="card-logo">'+logo+'</div>'
          + '<div class="card-body"><div class="card-name">'+c.name+'</div><div class="card-desc">'+c.description+'</div></div>'
          + '<span class="'+badgeCls+'">'+badgeText+'</span></div>';
      }).join('');

      // Attach click handlers
      document.querySelectorAll('.card[data-id]').forEach(function(card){
        card.addEventListener('click', function(){
          openSlider(card.getAttribute('data-id'), card.getAttribute('data-name'));
        });
      });
    });
  }

  refreshCards();
})();
</script></body></html>`;
}

function memoryPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Memory — PM Agent</title>
${FONT_LINKS}<style>${STYLE}
.tab-bar{display:flex;gap:0;border-bottom:1px solid #E5E5E5;margin-bottom:1.5rem}
.tab-btn{padding:.75rem 1.25rem;font-size:.875rem;font-weight:600;color:var(--text-muted);background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;transition:all .15s;font-family:var(--font)}
.tab-btn:hover{color:var(--text)}
.tab-btn.active{color:var(--text);border-bottom-color:var(--text)}
.tab-content{display:none}
.tab-content.active{display:block}

.brain-section{margin-bottom:28px}
.brain-section-title{font-size:13px;font-weight:700;color:var(--text-muted);margin:0 0 10px;padding:0;text-transform:uppercase;letter-spacing:0.5px}
.brain-intro{font-size:14px;color:var(--text-muted);margin-bottom:28px;line-height:1.5;max-width:720px}
.inst-table{width:100%;border-collapse:collapse;background:#FFFFFF;border-radius:var(--radius);overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);border:1px solid #E5E5E5}
.inst-table th{text-align:left;font-size:12px;color:var(--text-muted);padding:12px 16px;border-bottom:1px solid #E5E5E5;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
.inst-table td{padding:12px 16px;border-bottom:1px solid #E5E5E5;font-size:14px;vertical-align:middle}
.inst-table tr:last-child td{border-bottom:none}
.inst-table tr:hover{background:#FAFAFA}
td.brain-desc{font-size:13px;color:var(--text-muted);line-height:1.4;max-width:420px}

.view-btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid #E5E5E5;background:#FFFFFF;color:var(--text);padding:8px 16px;border-radius:var(--radius);cursor:pointer;font-weight:500;font-size:14px;font-family:var(--font);transition:all .2s}
.view-btn:hover{background:#F5F5F5;border-color:#D0D0D0}

.preview-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.2);z-index:100;opacity:0;pointer-events:none;transition:opacity 0.3s ease}
.preview-backdrop.open{opacity:1;pointer-events:auto}
.preview-pane{position:fixed;top:0;right:0;bottom:0;width:100%;max-width:800px;background:#FFFFFF;z-index:101;transform:translateX(100%);transition:transform 0.3s cubic-bezier(0.16,1,0.3,1);box-shadow:-8px 0 24px rgba(0,0,0,0.1);display:flex;flex-direction:column}
.preview-pane.open{transform:translateX(0)}
.preview-header{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid #E5E5E5;background:#FFFFFF}
.preview-header .name{font-weight:600;font-size:16px;color:var(--text);word-break:break-all}
#previewContent{padding:32px 48px;overflow-y:auto;flex:1}
#previewContent pre{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;background:#F5F5F5;padding:16px;border-radius:var(--radius);margin:0}
#previewContent .md-body{font-size:15px;line-height:1.6;color:var(--text);max-width:700px;margin:0 auto}
#previewContent .md-body h1,#previewContent .md-body h2,#previewContent .md-body h3,#previewContent .md-body h4{font-weight:700;margin:1.5em 0 0.75em;color:var(--text)}
#previewContent .md-body h1{font-size:28px;border-bottom:1px solid #E5E5E5;padding-bottom:8px}
#previewContent .md-body h2{font-size:22px;border-bottom:1px solid #E5E5E5;padding-bottom:6px}
#previewContent .md-body h3{font-size:18px}
#previewContent .md-body p{margin-bottom:1em}
#previewContent .md-body a{color:var(--text);font-weight:500;text-underline-offset:2px}
#previewContent .md-body ul,#previewContent .md-body ol{margin-bottom:1em;padding-left:24px}
#previewContent .md-body li{margin-bottom:0.5em}
#previewContent .md-body table{border:1px solid #E5E5E5;margin:16px 0;border-radius:var(--radius);overflow:hidden;box-shadow:none;width:100%;border-collapse:collapse}
#previewContent .md-body th{background:#FAFAFA;border-bottom:1px solid #E5E5E5;padding:10px 16px;text-align:left}
#previewContent .md-body td{border-bottom:1px solid #E5E5E5;padding:10px 16px}
#previewContent .md-body code{background:#F5F5F5;padding:3px 6px;border-radius:4px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
#previewContent .md-body pre code{background:none;padding:0;font-size:inherit}
#previewContent .md-body blockquote{border-left:3px solid var(--btn-primary-bg);margin:16px 0;padding:4px 16px;color:var(--text-muted);background:#FAFAFA;border-radius:0 8px 8px 0}

.close-btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;padding:8px 16px;border-radius:var(--radius);cursor:pointer;font-weight:500;font-size:14px;font-family:var(--font);transition:all .2s;background:var(--btn-secondary-bg);color:var(--text)}
.close-btn:hover{background:#D5D5D5}

@media(max-width:768px){
  .preview-pane{max-width:100%}
  #previewContent{padding:24px}
  td.brain-desc{max-width:200px}
}
</style></head><body>
${pageHeader("/memory")}
<div class="container">
<h1>Memory</h1>
<p class="subtitle">Conversations and instructions that shape the agent's behavior.</p>

<div class="tab-bar">
  <button class="tab-btn active" data-tab="conversations">Conversations</button>
  <button class="tab-btn" data-tab="instructions">Instructions</button>
</div>

<div id="tab-conversations" class="tab-content active">
<div style="display:grid;grid-template-columns:280px 1fr;gap:1rem;min-height:60vh">
  <div id="sessionList" style="overflow-y:auto;max-height:70vh"></div>
  <div id="sessionDetail" class="card"><p style="color:var(--text-muted)">Select a session to view its transcript.</p></div>
</div>
</div>

<div id="tab-instructions" class="tab-content">
<div id="instructionsList"></div>
</div>

</div>

<div id="previewBackdrop" class="preview-backdrop"></div>
<div id="preview" class="preview-pane">
  <div class="preview-header">
    <span class="name" id="previewName"></span>
    <button class="close-btn" id="previewClose">Close</button>
  </div>
  <div id="previewContent"></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js" async></script>
<script>
(function(){
  var previewEl = document.getElementById('preview');
  var previewBackdropEl = document.getElementById('previewBackdrop');
  var previewNameEl = document.getElementById('previewName');
  var previewContentEl = document.getElementById('previewContent');
  var previewCloseEl = document.getElementById('previewClose');

  previewCloseEl.addEventListener('click', closePreview);
  previewBackdropEl.addEventListener('click', closePreview);

  function closePreview(){
    previewEl.classList.remove('open');
    previewBackdropEl.classList.remove('open');
    setTimeout(function(){
      if(!previewEl.classList.contains('open')){
        previewContentEl.innerHTML = '';
      }
    }, 300);
  }

  /* ── Tab switching ── */
  var instrLoaded = false;
  function switchTab(tab){
    document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.tab===tab); });
    document.querySelectorAll('.tab-content').forEach(function(c){ c.classList.remove('active'); });
    document.getElementById('tab-'+tab).classList.add('active');
    if(tab==='instructions' && !instrLoaded){ instrLoaded=true; loadInstructions(); }
  }
  document.querySelectorAll('.tab-btn[data-tab]').forEach(function(btn){
    btn.addEventListener('click', function(){ switchTab(btn.dataset.tab); });
  });

  /* ── Conversations tab ── */
  fetch('/memory/api/sessions',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
    var el = document.getElementById('sessionList');
    var html = '';
    j.sessions.forEach(function(s){
      var date = s.modified ? new Date(s.modified).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
      var msgs = s.size || 0;
      html += '<div class="card" style="cursor:pointer;padding:1rem" onclick="loadSession(\\''+s.agent+'\\',\\''+s.id+'\\')">'
        + '<div style="font-size:.875rem;font-weight:600;color:var(--text)">'+escHtml(s.agent)+'</div>'
        + '<div style="font-size:.8rem;color:var(--text-muted);margin-top:.2rem">'+date+(msgs ? ' &middot; '+msgs+' msgs' : '')+'</div></div>';
    });
    el.innerHTML = html || '<p style="color:var(--text-muted);font-size:.875rem">No sessions yet. Start a chat to see conversations here.</p>';
  });

  window.loadSession = function(agent, id){
    window._currentSessionId = id;
    var el = document.getElementById('sessionDetail');
    el.innerHTML = '<p style="color:var(--text-muted)">Loading...</p>';
    fetch('/memory/api/session/'+agent+'/'+id,{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
      if(j.error){ el.innerHTML='<p style="color:#DC2626">'+escHtml(j.error)+'</p>'; return; }
      var html = '<div style="display:flex;justify-content:flex-end;margin-bottom:.75rem"><button onclick="deleteSession()" style="background:none;border:1px solid #E5E5E5;border-radius:6px;padding:4px 10px;font-size:.75rem;color:#DC2626;cursor:pointer">Delete</button></div>';
      html += '<div class="messages">';
      j.messages.forEach(function(m){
        var isAssistant = m.role === 'assistant';
        var label = m.sender || m.role;
        var time = m.time ? new Date(m.time).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : '';
        html += '<div class="msg"><div class="role">'+escHtml(label)+(time ? ' <span style="font-weight:400;color:var(--text-muted);font-size:.75rem">'+time+'</span>' : '')+'</div><div class="content" style="color:'+(isAssistant ? 'var(--text-muted)' : 'var(--text)')+'">'+escHtml(m.content)+'</div></div>';
      });
      html += '</div>';
      el.innerHTML = html;
    });
  };

  window.deleteSession = function(){
    if(!window._currentSessionId || !confirm('Delete this conversation?')) return;
    fetch('/memory/api/session/'+window._currentSessionId,{method:'DELETE',credentials:'same-origin'}).then(function(r){return r.json()}).then(function(){
      location.reload();
    });
  };

  /* ── Instructions tab ── */
  function fmtRelative(iso){
    if(!iso) return '';
    var now = Date.now(), then = new Date(iso).getTime(), diff = now - then;
    var mins = Math.floor(diff/60000);
    if(mins<1) return 'just now';
    if(mins<60) return mins+'m ago';
    var hrs = Math.floor(mins/60);
    if(hrs<24) return hrs+'h ago';
    var days = Math.floor(hrs/24);
    if(days<30) return days+'d ago';
    return new Date(iso).toLocaleDateString();
  }

  function loadInstructions(){
    fetch('/memory/api/instructions',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
      var el = document.getElementById('instructionsList');
      if(!j.items||!j.items.length){ el.innerHTML='<p style="color:var(--text-muted)">No instruction files found in workspace.</p>'; return; }
      var cats = {};
      j.items.forEach(function(it){ if(!cats[it.category]) cats[it.category]=[]; cats[it.category].push(it); });
      var html = '<p class="brain-intro">These files define how the agent thinks, talks, and operates. Click any file to read the full instructions the agent receives.</p>';
      Object.keys(cats).forEach(function(cat){
        html += '<div class="brain-section">';
        html += '<h3 class="brain-section-title">'+escHtml(cat)+'</h3>';
        html += '<table class="inst-table"><thead><tr><th>Name</th><th>Description</th><th>Last Modified</th><th></th></tr></thead><tbody>';
        cats[cat].forEach(function(it){
          html += '<tr>'
            + '<td style="white-space:nowrap;font-weight:500"><a href="#" class="preview-link" data-path="'+escAttr(it.path)+'" data-label="'+escAttr(it.label)+'" style="color:var(--text);text-decoration:underline;text-decoration-color:#E5E5E5;text-underline-offset:4px">'+escHtml(it.label)+'</a></td>'
            + '<td class="brain-desc">'+escHtml(it.description)+'</td>'
            + '<td class="muted" style="white-space:nowrap;color:var(--text-muted)">'+fmtRelative(it.mtime)+'</td>'
            + '<td style="text-align:right"><a href="#" class="preview-link view-btn" data-path="'+escAttr(it.path)+'" data-label="'+escAttr(it.label)+'">View</a></td>'
            + '</tr>';
        });
        html += '</tbody></table></div>';
      });
      el.innerHTML = html;

      el.querySelectorAll('.preview-link').forEach(function(a){
        a.addEventListener('click', function(e){
          e.preventDefault();
          viewFile(a.dataset.path, a.dataset.label);
        });
      });
    });
  }

  function viewFile(filePath, label){
    previewNameEl.textContent = label;
    previewContentEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Loading preview...</div>';
    previewEl.classList.add('open');
    previewBackdropEl.classList.add('open');

    fetch('/memory/api/file?path='+encodeURIComponent(filePath),{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
      if(!j.ok){
        previewContentEl.innerHTML = '<div style="color:#DC2626;font-size:13px">Error: '+(j.error||'unknown')+'</div>';
        return;
      }
      var ext = (filePath.match(/\\.[^.]+$/) || [''])[0].toLowerCase();
      if(ext === '.md' && typeof marked !== 'undefined'){
        previewContentEl.innerHTML = '<div class="md-body">' + marked.parse(j.content) + '</div>';
      } else {
        previewContentEl.innerHTML = '<pre>' + escHtml(j.content) + '</pre>';
      }
    });
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/>/g,'&gt;');
  }
  function escAttr(s) {
    return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
})();
</script></body></html>`;
}
