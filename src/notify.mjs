import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { readPaneDigest } from "./digest.mjs";
import { isEnabled, shouldNotify } from "./state.mjs";
import { renderAlert, sendTelegram } from "./telegram.mjs";
import { defaultBranchResolver, readSnapshot, resolveLocation } from "./topology.mjs";

const DEFAULT_GATES = {
  statuses: new Set(["blocked", "done"]),
  alertReleased: true,
  alertExited: true,
};

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function stringFrom(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return firstString(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "object") {
    return firstString(value.name, value.id, value.command, value.display, value.display_name);
  }
  return null;
}

function pickAgent(data) {
  return (
    stringFrom(data?.agent) ??
    firstString(data?.agent_name, data?.agentName, data?.display_agent, data?.displayAgent) ??
    null
  );
}

function pickStatus(data) {
  const direct = firstString(data?.agent_status, data?.agentStatus);
  if (direct) return direct.toLowerCase();
  const nested = firstString(
    data?.state?.agent_status,
    data?.state?.agentStatus,
    data?.state?.status,
  );
  if (nested) return nested.toLowerCase();
  const agentNested = firstString(
    data?.agent?.agent_status,
    data?.agent?.status,
    data?.agent?.state?.agent_status,
    data?.agent?.state?.status,
  );
  if (agentNested) return agentNested.toLowerCase();
  const fallback = firstString(data?.status, data?.payload?.agent_status, data?.payload?.status);
  return fallback ? fallback.toLowerCase() : null;
}

function pickReleased(data) {
  for (const key of ["released", "agent_released", "agentReleased"]) {
    const value = data?.[key];
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
  }
  return false;
}

function eventFields(data) {
  return {
    paneId: firstString(data?.pane_id, data?.paneId, data?.pane?.pane_id, data?.pane?.id),
    workspaceId: firstString(
      data?.workspace_id,
      data?.workspaceId,
      data?.workspace?.workspace_id,
      data?.workspace?.id,
    ),
    tabId: firstString(data?.tab_id, data?.tabId, data?.tab?.tab_id, data?.tab?.id),
    cwd: firstString(data?.cwd, data?.foreground_cwd, data?.pane?.cwd, data?.pane?.foreground_cwd),
    title: firstString(data?.title, data?.pane_title, data?.paneTitle),
    agent: pickAgent(data),
    displayAgent: firstString(data?.display_agent, data?.displayAgent),
  };
}

/**
 * Classify one Herdr event into at most one alert, or null. Accepts the
 * `{ event, data }` envelope and a flat payload; never throws on malformed
 * JSON (logs to stderr and returns null).
 */
export function senseEvent(env = {}, eventJson, cfg = null) {
  const raw =
    eventJson !== undefined && eventJson !== null
      ? eventJson
      : env.HERDR_PLUGIN_EVENT_JSON ?? env.HERDR_PLUGIN_EVENT ?? null;
  if (raw === null || raw === undefined || raw === "") return null;

  let parsed = raw;
  if (typeof raw !== "object") {
    try {
      parsed = JSON.parse(String(raw));
    } catch (err) {
      console.error(`[alherdr] unreadable event JSON: ${err?.message ?? err}`);
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") {
    console.error("[alherdr] event JSON has no object");
    return null;
  }

  const name = firstString(
    env.HERDR_PLUGIN_EVENT,
    parsed.event,
    parsed.name,
    parsed.type,
    parsed.data?.type,
    parsed.event_type,
  );
  if (!name) return null;

  const data = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
  const gates = cfg ?? DEFAULT_GATES;
  const statuses =
    gates.statuses instanceof Set
      ? gates.statuses
      : new Set(Array.isArray(gates.statuses) ? gates.statuses : []);
  const normalized = name.toLowerCase().replace(/[.\s-]+/g, "_");

  if (normalized.endsWith("agent_status_changed")) {
    const status = pickStatus(data);
    if (!status || !statuses.has(status)) return null;
    return { kind: status, ...eventFields(data) };
  }

  if (normalized.endsWith("agent_detected")) {
    // The same event fires when an agent is DETECTED (a start); only a
    // release with an identifiable agent is a stop.
    if (!pickReleased(data)) return null;
    if (!pickAgent(data)) return null;
    if (gates.alertReleased === false) return null;
    return { kind: "released", ...eventFields(data) };
  }

  if (normalized === "pane_exited" || normalized === "exited") {
    if (gates.alertExited === false) return null;
    return { kind: "exited", ...eventFields(data) };
  }

  return null;
}

function dedupeKeyFor(alert, paneId) {
  if (alert.kind === "released" || alert.kind === "exited") {
    // One agent exit can emit both; treat them as one user-visible event.
    return `${paneId}|stop`;
  }
  return `${paneId}|${alert.kind}`;
}

/**
 * Append one JSON line describing the event before any filtering runs, so a
 * filtered-out event is still captured. Never throws: an unwritable path is
 * logged and ignored.
 */
function writeDebugDump(cfg, env, kind) {
  try {
    const raw = env.HERDR_PLUGIN_EVENT_JSON ?? null;
    let parsed = null;
    if (raw && typeof raw === "object") parsed = raw;
    else if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    appendFileSync(
      cfg.debugDump,
      JSON.stringify({ ts: new Date().toISOString(), raw, parsed, kind: kind ?? null }) + "\n",
    );
  } catch (err) {
    console.error(`[alherdr] could not write ALHERDR_DEBUG_DUMP: ${err?.message ?? err}`);
  }
}

export async function main({
  env = process.env,
  fetchImpl = fetch,
  spawnImpl,
  snapshot,
  branchResolver,
} = {}) {
  const cfg = loadConfig(env);
  const alert = senseEvent(env, undefined, cfg);
  if (cfg.debugDump) writeDebugDump(cfg, env, alert?.kind);

  if (!isEnabled(cfg)) return 0;

  if (!alert) return 0;

  const paneId = alert.paneId ?? firstString(env.HERDR_PANE_ID) ?? "no-pane";
  const eventPaneId = alert.paneId ?? firstString(env.HERDR_PANE_ID);
  const isStop = alert.kind === "released" || alert.kind === "exited";
  let digest = "";
  if (!isStop) {
    try {
      digest = readPaneDigest({
        herdrBin: cfg.herdrBin,
        paneId,
        lines: cfg.digestLines,
        maxChars: cfg.digestMaxChars,
        spawnImpl: spawnImpl ?? undefined,
      });
    } catch (err) {
      console.error(`[alherdr] digest unavailable: ${err?.message ?? err}`);
    }
  }

  if (!shouldNotify(cfg, dedupeKeyFor(alert, paneId))) return 0;

  // One snapshot call per alert, skipped entirely when the event names no
  // pane. On failure `resolveLocation` degrades to the legacy location line.
  let location = null;
  if (eventPaneId !== null) {
    const currentSnapshot =
      snapshot !== undefined
        ? snapshot
        : readSnapshot({ herdrBin: cfg.herdrBin, spawnImpl: spawnImpl ?? undefined });
    location = resolveLocation(currentSnapshot, {
      workspaceId: alert.workspaceId,
      tabId: alert.tabId,
      paneId: eventPaneId,
      cwd: alert.cwd,
      branchResolver:
        branchResolver ??
        ((args) => defaultBranchResolver({ ...args, spawnImpl: spawnImpl ?? undefined })),
    });
  }

  const text = renderAlert({ ...alert, paneId, digest, location });

  if (cfg.dryRun) {
    process.stdout.write(text + "\n");
    return 0;
  }

  if (!cfg.token || !cfg.chatId) {
    console.error("[alherdr] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID; alert not sent");
    return 0;
  }

  try {
    const result = await sendTelegram({
      token: cfg.token,
      chatId: cfg.chatId,
      text,
      fetchImpl,
    });
    if (!result.ok) {
      console.error(
        `[alherdr] Telegram rejected the alert (${result.status}): ${result.description}`,
      );
    }
  } catch (err) {
    console.error(`[alherdr] network failure while sending to Telegram: ${err?.message ?? err}`);
  }
  // Herdr event hooks must always exit 0, even when delivery fails.
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    console.error(`[alherdr] unexpected error: ${err?.message ?? err}`);
  });
}
