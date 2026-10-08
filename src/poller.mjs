/**
 * Detached Telegram command responder.
 *
 * Herdr plugin hooks are event-driven: a command runs, does its job and dies.
 * Answering an inbound `/status` needs something listening, so this module is a
 * long-polling process that `scripts/ensure-poller.sh` spawns detached from the
 * `[[startup]]` hook. It is strictly read-only: it reads one `herdr api
 * snapshot` for `/status` and sends a reply. It never sends keys, prompts an
 * agent, or mutates anything.
 *
 * Hard security boundary: only updates whose chat is the configured
 * `TELEGRAM_CHAT_ID` are answered. Every other chat is ignored entirely — no
 * reply, not even an error.
 *
 * The loop never crashes: a network failure, a 429, a bad token (401/403) or a
 * 409 from `getUpdates` is logged and retried with a bounded backoff. The
 * heartbeat contract lives in report.mjs (`POLLER_HEARTBEAT_FILE`,
 * `POLLER_STALE_MS`): a beat is written after every poll cycle, so the status
 * action reports `running` while a cycle can take at most ~45 s + backoff.
 */
import {
  mkdirSync,
  readFileSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildStatusReport } from "./actions.mjs";
import { loadConfig } from "./config.mjs";
import { POLLER_HEARTBEAT_FILE } from "./report.mjs";
import { MAX_MESSAGE_CHARS, escapeHtml, sendTelegram } from "./telegram.mjs";

/** Files the poller owns in the state dir. Kept in step with ensure-poller.sh. */
export const POLLER_PID_FILE = "telegram-poller.pid";
export const POLLER_OFFSET_FILE = "telegram-poller.offset";
export const POLLER_LOG_FILE = "telegram-poller.log";

export const LONG_POLL_SECONDS = 30;
export const FETCH_TIMEOUT_MS = 45_000;
export const MAX_BACKOFF_MS = 60_000;
/** A bad token cannot recover by retrying faster: back off a full minute. */
export const AUTH_BACKOFF_MS = 60_000;
/** 409 means another poller or a webhook is competing; retry slowly. */
export const CONFLICT_BACKOFF_MS = 30_000;
export const NETWORK_BACKOFF_MS = 5_000;
export const MAX_LOG_BYTES = 256 * 1024;

export const USAGE_LINE = "Agent Alerts: /status — who is waiting · /help — this line";
export const UNKNOWN_REPLY = "Unknown command. Try /status or /help.";

function statePath(cfg, name) {
  return join(cfg.stateDir, name);
}

function consoleLog(line) {
  console.log(`[alherdr] poller: ${line}`);
}

function describeError(err) {
  if (err && typeof err === "object" && err.message) return String(err.message);
  return String(err);
}

/** Offset for the next `getUpdates` call; 0 (Telegram's "everything") when absent. */
export function readOffset(cfg) {
  try {
    const value = Number.parseInt(readFileSync(statePath(cfg, POLLER_OFFSET_FILE), "utf8").trim(), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeOffset(cfg, offset) {
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(statePath(cfg, POLLER_OFFSET_FILE), `${offset}\n`);
}

/** One heartbeat beat: the file's mtime is the contract. */
export function writeHeartbeat(cfg, now = Date.now()) {
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(statePath(cfg, POLLER_HEARTBEAT_FILE), `${now}\n`);
}

/** Keep the detached process's log small by truncating, never by growing. */
export function maybeTruncateLog(cfg) {
  try {
    const file = statePath(cfg, POLLER_LOG_FILE);
    if (statSync(file).size > MAX_LOG_BYTES) truncateSync(file, 0);
  } catch {
    // Log housekeeping must never stop the poller.
  }
}

function pidFilePath(cfg) {
  return statePath(cfg, POLLER_PID_FILE);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

/**
 * Take the PID file unless a live process already holds it. A stale file (its
 * PID is gone) is overwritten; the caller owns the file after `true`.
 */
export function claimPidFile(cfg, { pid = process.pid, alive = isProcessAlive } = {}) {
  let holder = null;
  try {
    holder = readFileSync(pidFilePath(cfg), "utf8").trim();
  } catch {
    holder = null;
  }
  if (holder !== null && holder !== "" && holder !== String(pid)) {
    if (alive(Number.parseInt(holder, 10))) return false;
  }
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(pidFilePath(cfg), `${pid}\n`);
  return true;
}

/** Remove the PID file only when it still names us; never fight over it. */
export function releasePidFile(cfg, { pid = process.pid } = {}) {
  try {
    if (readFileSync(pidFilePath(cfg), "utf8").trim() !== String(pid)) return false;
    unlinkSync(pidFilePath(cfg));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when some other process has taken the PID file. A missing file is not
 * a takeover: the loop keeps running so a manual cleanup cannot kill it.
 */
function pidFileNamesOther(cfg, pid) {
  try {
    const holder = readFileSync(pidFilePath(cfg), "utf8").trim();
    return holder !== "" && holder !== String(pid);
  } catch {
    return false;
  }
}

/**
 * PURE: the `/name` of a Telegram command message, lowercased and stripped of
 * the `@BotName` suffix. Plain text that is not a command is null.
 */
export function parseCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.split(/\s+/)[0].slice(1).split("@")[0].trim().toLowerCase();
  return name === "" ? null : name;
}

/**
 * PURE: escape the report and wrap it in `<pre>` so the aligned waiting list
 * keeps its columns in Telegram. Truncated to one message; `plainText` is the
 * unescaped fallback sendTelegram uses if the HTML entities are rejected.
 */
export function formatReply(text) {
  const raw = String(text ?? "");
  let end = raw.length;
  let escaped = escapeHtml(raw);
  while (`<pre>${escaped}</pre>`.length > MAX_MESSAGE_CHARS && end > 0) {
    const overflow = `<pre>${escaped}</pre>`.length - MAX_MESSAGE_CHARS;
    end = Math.max(0, end - Math.max(1, Math.ceil(overflow / 5)));
    escaped = escapeHtml(raw.slice(0, end));
  }
  if (end < raw.length) {
    const plainText = `${raw.slice(0, Math.max(0, end - 1))}…`;
    return { text: `<pre>${escapeHtml(plainText)}</pre>`, plainText };
  }
  return { text: `<pre>${escaped}</pre>`, plainText: raw };
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Fetch with both our stop signal and a hard per-request timeout. */
function pollSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function requestUpdates({ cfg, offset, fetchImpl, signal }) {
  const url = `https://api.telegram.org/bot${cfg.token}/getUpdates`;
  const request = pollSignal(signal, FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset,
        timeout: LONG_POLL_SECONDS,
        allowed_updates: ["message"],
      }),
      signal: request.signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  } finally {
    request.clear();
  }
}

function backoffFrom(failures, baseMs) {
  const step = Math.min(Math.max(0, failures - 1), 4);
  return Math.min(baseMs * 2 ** step, MAX_BACKOFF_MS);
}

/** Decide the next wait for one failed poll and say so in the log. */
function failureBackoff(status, payload, failures, log) {
  const description = String(payload?.description ?? "");
  if (status === 401 || status === 403) {
    log(`getUpdates rejected with ${status} (bad or revoked token); backing off ${AUTH_BACKOFF_MS / 1000}s`);
    return AUTH_BACKOFF_MS;
  }
  if (status === 409) {
    log("getUpdates returned 409: another poller or a Telegram webhook is competing; backing off");
    return backoffFrom(failures, CONFLICT_BACKOFF_MS);
  }
  if (status === 429) {
    const retryAfter = Number(payload?.parameters?.retry_after);
    const wait =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
        : 1000;
    log(`getUpdates rate limited (429); retrying in ${Math.round(wait / 1000)}s`);
    return Math.max(wait, 1000);
  }
  log(`getUpdates failed with status ${status}${description ? `: ${description}` : ""}`);
  return backoffFrom(failures, NETWORK_BACKOFF_MS);
}

/**
 * Answer one update. Returns without sending anything unless it is a command
 * from the configured chat; replies go to the configured chat id only.
 */
export async function handleUpdate(update, { cfg, fetchImpl, sleepImpl, spawnImpl, now, log }) {
  const message = update?.message;
  if (!message || typeof message !== "object") return "skip";
  const chatId = message.chat?.id;
  if (chatId === undefined || chatId === null) return "skip";
  if (String(chatId) !== String(cfg.chatId)) {
    log("ignored an update from an unconfigured chat");
    return "ignored";
  }

  const command = parseCommand(message.text);
  if (command === null) return "skip";

  let reply;
  if (command === "status") {
    reply = formatReply(buildStatusReport(cfg, { spawnImpl, now: now() }));
  } else if (command === "help" || command === "start") {
    reply = formatReply(USAGE_LINE);
  } else {
    reply = formatReply(UNKNOWN_REPLY);
  }

  const result = await sendTelegram({
    token: cfg.token,
    chatId: cfg.chatId,
    text: reply.text,
    plainText: reply.plainText,
    fetchImpl,
    sleepImpl,
  });
  log(`replied /${command}: ${result.ok ? "ok" : `failed with status ${result.status}`}`);
  return "replied";
}

/**
 * The poll loop. One cycle is one `getUpdates` long poll (< 30 s) plus the
 * handling of its updates and the heartbeat beat; a failed cycle logs and
 * sleeps for a bounded backoff. Resolves only when stopped: `signal` aborts,
 * `maxCycles` (tests) is reached, or another process has claimed the PID file.
 */
export async function runPoller({
  cfg,
  fetchImpl = fetch,
  sleepImpl = abortableSleep,
  spawnImpl,
  log = consoleLog,
  now = Date.now,
  signal,
  maxCycles = Infinity,
  pid = process.pid,
} = {}) {
  let cycles = 0;
  let failures = 0;
  let reason = "max-cycles";

  while (cycles < maxCycles) {
    if (signal?.aborted) {
      reason = "aborted";
      break;
    }
    if (pidFileNamesOther(cfg, pid)) {
      log("the PID file no longer names this process; exiting");
      reason = "pid-lost";
      break;
    }
    cycles += 1;

    let backoff = 0;
    try {
      writeHeartbeat(cfg, now());
      const offset = readOffset(cfg);
      const response = await requestUpdates({ cfg, offset, fetchImpl, signal });

      if (response.payload?.ok === true && Array.isArray(response.payload.result)) {
        let next = offset;
        for (const update of response.payload.result) {
          const updateId = Number(update?.update_id);
          if (Number.isSafeInteger(updateId) && updateId >= next) next = updateId + 1;
          try {
            await handleUpdate(update, { cfg, fetchImpl, sleepImpl, spawnImpl, now, log });
          } catch (err) {
            // One undeliverable reply must not stop the batch or replay the rest.
            log(`could not answer an update: ${describeError(err)}`);
          }
        }
        if (next !== offset) writeOffset(cfg, next);
        failures = 0;
      } else {
        failures += 1;
        backoff = failureBackoff(response.status, response.payload, failures, log);
      }
    } catch (err) {
      if (signal?.aborted) {
        reason = "aborted";
        break;
      }
      failures += 1;
      log(`getUpdates failed: ${describeError(err)}`);
      backoff = backoffFrom(failures, NETWORK_BACKOFF_MS);
    }

    writeHeartbeat(cfg, now());
    maybeTruncateLog(cfg);
    if (backoff > 0) await sleepImpl(backoff, signal);
  }

  if (signal?.aborted) reason = "aborted";
  return { cycles, reason };
}

/**
 * The detached process entrypoint. Refuses to run when the responder is off or
 * the credentials are missing, claims the PID file, and releases it again on
 * SIGTERM/SIGINT or a normal stop.
 */
export async function main({
  env = process.env,
  cfg: cfgOverride,
  fetchImpl = fetch,
  sleepImpl = abortableSleep,
  spawnImpl,
  log = consoleLog,
  now = Date.now,
  maxCycles = Infinity,
} = {}) {
  const cfg = cfgOverride ?? loadConfig(env);
  if (!cfg.telegramCommands) return 0;
  if (!cfg.token || !cfg.chatId) {
    log("telegram commands are enabled but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing; exiting");
    return 1;
  }
  if (!claimPidFile(cfg)) {
    log("another poller already holds the PID file; exiting");
    return 0;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    await runPoller({
      cfg,
      fetchImpl,
      sleepImpl,
      spawnImpl,
      log,
      now,
      signal: controller.signal,
      maxCycles,
    });
    return 0;
  } catch (err) {
    log(`stopped after an unexpected error: ${describeError(err)}`);
    return 1;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    releasePidFile(cfg);
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[alherdr] poller crashed: ${describeError(err)}`);
      process.exitCode = 1;
    });
}
