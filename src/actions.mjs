import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { isEnabled, readState, setEnabled } from "./state.mjs";
import { renderAlert, sendTelegram } from "./telegram.mjs";
import { defaultCheckoutProbe, readSnapshot, resolveLocation } from "./topology.mjs";

export const TEST_DIGEST =
  "Agent Alerts test message. If you can read this, the Telegram configuration works.";

function parseJsonTolerant(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function stringFrom(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return firstString(value);
  if (typeof value === "object") {
    return firstString(value.name, value.id, value.command, value.display, value.display_name);
  }
  return null;
}

/** Never prints more of the bot token than the public numeric bot id. */
export function maskToken(token) {
  const text = String(token ?? "");
  if (!text) return "(not configured)";
  const separator = text.indexOf(":");
  if (separator <= 0) return "***";
  return `${text.slice(0, separator)}:***`;
}

export function maskChatId(chatId) {
  const text = String(chatId ?? "");
  if (!text) return "(not configured)";
  if (text.length <= 4) return "***";
  return `***${text.slice(-4)}`;
}

/** Synthetic `blocked` alert for `send-test`, built from the invocation context. */
export function buildTestAlert(env = process.env) {
  const context = parseJsonTolerant(env.HERDR_PLUGIN_CONTEXT_JSON) ?? {};
  const data = context.data && typeof context.data === "object" ? context.data : context;

  const paneId =
    firstString(
      data.pane_id,
      data.paneId,
      data.pane?.pane_id,
      data.pane?.id,
      data.focused_pane?.pane_id,
      data.focusedPane?.paneId,
      context.pane_id,
      env.HERDR_PANE_ID,
    ) ?? "no-pane";
  const workspaceId = firstString(
    data.workspace_id,
    data.workspaceId,
    data.workspace?.workspace_id,
    data.workspace?.id,
    context.workspace_id,
    env.HERDR_WORKSPACE_ID,
  );
  const tabId = firstString(
    data.tab_id,
    data.tabId,
    data.tab?.tab_id,
    data.tab?.id,
    context.tab_id,
    env.HERDR_TAB_ID,
  );
  const agent =
    stringFrom(data.agent) ??
    firstString(data.agent_name, data.agentName, data.display_agent, data.displayAgent) ??
    "test-agent";
  const displayAgent = firstString(data.display_agent, data.displayAgent) ?? agent;
  const title = firstString(data.title, data.pane_title, context.title, workspaceId, tabId);
  const cwd = firstString(
    data.cwd,
    data.foreground_cwd,
    data.pane?.cwd,
    data.pane?.foreground_cwd,
    context.cwd,
    context.foreground_cwd,
  );

  return {
    kind: "blocked",
    agent,
    displayAgent,
    title,
    workspaceId,
    tabId,
    cwd,
    paneId,
  };
}

async function sendTest(cfg, env, { fetchImpl = fetch, spawnImpl, snapshot, checkoutProbe } = {}) {
  const alert = buildTestAlert(env);
  // A test message must be unmistakably a test: always the fixed body, never a
  // live pane digest. This also skips the pane-read subprocess entirely.
  alert.digest = TEST_DIGEST;

  // Same topology resolution and degradation as notify.mjs: one snapshot call,
  // same branch resolver seam, and a legacy line when nothing was resolved.
  let location = null;
  if (alert.paneId && alert.paneId !== "no-pane") {
    const currentSnapshot =
      snapshot !== undefined
        ? snapshot
        : readSnapshot({ herdrBin: cfg.herdrBin, spawnImpl: spawnImpl ?? undefined });
    location = resolveLocation(currentSnapshot, {
      workspaceId: alert.workspaceId,
      tabId: alert.tabId,
      paneId: alert.paneId,
      cwd: alert.cwd,
      checkoutProbe:
        checkoutProbe ??
        ((args) => defaultCheckoutProbe({ ...args, spawnImpl: spawnImpl ?? undefined })),
    });
  }

  const text = renderAlert({ ...alert, location });
  process.stdout.write(text + "\n");

  let result;
  if (cfg.dryRun) {
    result = { ok: true, status: 0, description: "dry-run: not sent" };
  } else if (!cfg.token || !cfg.chatId) {
    result = {
      ok: false,
      status: 0,
      description: "missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID",
    };
  } else {
    try {
      result = await sendTelegram({ token: cfg.token, chatId: cfg.chatId, text, fetchImpl });
    } catch (err) {
      result = { ok: false, status: 0, description: `network failure: ${err?.message ?? err}` };
    }
  }

  const state = readState(cfg);
  process.stdout.write(
    `\nresult: ${result.ok ? "ok" : "fail"} · status ${result.status}` +
      `${result.description ? ` · ${result.description}` : ""}\n`,
  );
  process.stdout.write(
    `token: ${maskToken(cfg.token)} · chat: ${maskChatId(cfg.chatId)}` +
      ` · alerts: ${state.enabled ? "enabled" : "disabled"} · state: ${state.stateDir}\n`,
  );
  return result.ok ? 0 : 1;
}

function printEnabled(cfg, enabled) {
  console.log(
    `alherdr: alerts ${enabled ? "enabled" : "disabled"} (state in ${cfg.stateDir})`,
  );
}

export async function main(
  argv = process.argv.slice(2),
  { env = process.env, fetchImpl = fetch, spawnImpl, snapshot, checkoutProbe } = {},
) {
  const cfg = loadConfig(env);
  const command = String(argv[0] ?? "").trim().toLowerCase();

  switch (command) {
    case "toggle": {
      const enabled = !isEnabled(cfg);
      setEnabled(cfg, enabled);
      printEnabled(cfg, enabled);
      return 0;
    }
    case "enable": {
      setEnabled(cfg, true);
      printEnabled(cfg, true);
      return 0;
    }
    case "disable": {
      setEnabled(cfg, false);
      printEnabled(cfg, false);
      return 0;
    }
    case "send-test":
      return sendTest(cfg, env, { fetchImpl, spawnImpl, snapshot, checkoutProbe });
    default:
      console.error("usage: node src/actions.mjs <toggle|enable|disable|send-test>");
      return 2;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[alherdr] unexpected error: ${err?.message ?? err}`);
      process.exitCode = 1;
    });
}
