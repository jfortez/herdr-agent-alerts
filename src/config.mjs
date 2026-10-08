import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = resolve(HERE, "..");

const KNOWN_STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);
const DEFAULT_STATUSES = ["blocked", "done"];
const KNOWN_KINDS = new Set(["blocked", "done", "released", "exited"]);
const DEFAULT_SILENT_KINDS = ["released", "exited"];

const DEFAULTS = {
  digestLines: 24,
  digestMaxChars: 1200,
  dedupeSeconds: 30,
};

export function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseDotenv(text) {
  const values = {};
  for (const line of String(text).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim().replace(/^export\s+/, "");
    if (!key) continue;
    let value = trimmed.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readEnvFile(file) {
  try {
    return parseDotenv(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function trimOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function parseNameSet(value, known, defaults) {
  if (value === undefined || value === null) return new Set(defaults);
  const names = new Set();
  for (const raw of String(value).split(",")) {
    const name = raw.trim().toLowerCase();
    if (known.has(name)) names.add(name);
  }
  return names;
}

function parseStatuses(value) {
  return parseNameSet(value, KNOWN_STATUSES, DEFAULT_STATUSES);
}

function parseSilentKinds(value) {
  return parseNameSet(value, KNOWN_KINDS, DEFAULT_SILENT_KINDS);
}

/**
 * Configuration for one invocation. Real environment variables always win
 * over dotenv values. The dotenv file is read from the plugin config dir,
 * falling back to the plugin root (development runs).
 */
export function loadConfig(env = process.env) {
  const pluginRoot = trimOrNull(env.HERDR_PLUGIN_ROOT) ?? DEFAULT_PLUGIN_ROOT;
  const configDir = trimOrNull(env.HERDR_PLUGIN_CONFIG_DIR) ?? pluginRoot;
  const stateDir = trimOrNull(env.HERDR_PLUGIN_STATE_DIR) ?? join(pluginRoot, "state");

  const configFile = resolve(join(configDir, ".env"));
  const fileValues = readEnvFile(configFile);
  const rootFile = resolve(join(pluginRoot, ".env"));
  if (rootFile !== configFile) {
    for (const [key, value] of Object.entries(readEnvFile(rootFile))) {
      if (!Object.hasOwn(fileValues, key)) fileValues[key] = value;
    }
  }

  const read = (key) => (env[key] !== undefined ? env[key] : fileValues[key]);

  return {
    token: trimOrNull(read("TELEGRAM_BOT_TOKEN")),
    chatId: trimOrNull(read("TELEGRAM_CHAT_ID")),
    statuses: parseStatuses(read("ALHERDR_STATUSES")),
    silentKinds: parseSilentKinds(read("ALHERDR_SILENT_KINDS")),
    alertReleased: parseBoolean(read("ALHERDR_ALERT_RELEASED"), true),
    alertExited: parseBoolean(read("ALHERDR_ALERT_EXITED"), true),
    digestLines: parseNumber(read("ALHERDR_DIGEST_LINES"), DEFAULTS.digestLines),
    digestMaxChars: parseNumber(read("ALHERDR_DIGEST_MAX_CHARS"), DEFAULTS.digestMaxChars),
    dedupeSeconds: parseNumber(read("ALHERDR_DEDUPE_SECONDS"), DEFAULTS.dedupeSeconds),
    enabledByDefault: parseBoolean(read("ALHERDR_ENABLED"), true),
    telegramCommands: parseBoolean(read("ALHERDR_TELEGRAM_COMMANDS"), false),
    dryRun: parseBoolean(read("ALHERDR_DRY_RUN"), false),
    debugDump: trimOrNull(read("ALHERDR_DEBUG_DUMP")),
    configDir,
    stateDir,
    pluginRoot,
    herdrBin: trimOrNull(env.HERDR_BIN_PATH) ?? "herdr",
  };
}
