import { firstString, stringFrom } from "./strings.mjs";
import { resolveLocation } from "./topology.mjs";

/**
 * Heartbeat contract for the detached Telegram poller (a later change).
 *
 * The poller must beat at least once every 30 seconds by touching or
 * rewriting `<stateDir>/telegram-poller.heartbeat`. The file's mtime is the
 * last beat; no content is required. A beat older than `POLLER_STALE_MS`
 * (90 s, two missed 30 s beats) reports `stale` instead of `running`, so a
 * crashed poller cannot look alive. A missing file reports `off`.
 */
export const POLLER_HEARTBEAT_FILE = "telegram-poller.heartbeat";
export const POLLER_STALE_MS = 90_000;

function agentStatusOf(agent) {
  const raw = firstString(agent?.agent_status, agent?.agentStatus, agent?.status);
  return raw === null ? null : raw.toLowerCase();
}

function agentNameOf(agent) {
  return (
    firstString(agent?.display_agent, agent?.displayAgent) ??
    stringFrom(agent?.agent) ??
    "unknown"
  );
}

/**
 * PURE: summarize a `herdr api snapshot` into the status report's agent view.
 * `blocked` is waiting for the human, `working` is running, `idle` and `done`
 * are settled. Anything else (including a missing status) is settled but
 * counted separately under `unknown`. A snapshot that is null or has no
 * `agents` array is `unavailable` rather than a throw.
 *
 * Every waiting entry carries the agent name and the `resolveLocation` view of
 * its pane, so the workspace order and tab numbering stay in topology.mjs.
 */
export function summarizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.agents)) {
    return {
      waiting: [],
      running: 0,
      idle: 0,
      done: 0,
      unknown: 0,
      settled: 0,
      unavailable: true,
    };
  }

  const waiting = [];
  let running = 0;
  let idle = 0;
  let done = 0;
  let unknown = 0;

  for (const agent of snapshot.agents) {
    if (!agent || typeof agent !== "object") {
      unknown += 1;
      continue;
    }

    const status = agentStatusOf(agent);
    if (status === "blocked") {
      waiting.push({
        agent: agentNameOf(agent),
        location: resolveLocation(snapshot, {
          workspaceId: agent.workspace_id ?? agent.workspaceId,
          tabId: agent.tab_id ?? agent.tabId,
          paneId: agent.pane_id ?? agent.paneId,
          cwd: firstString(agent.cwd, agent.foreground_cwd),
        }),
      });
    } else if (status === "working") {
      running += 1;
    } else if (status === "idle") {
      idle += 1;
    } else if (status === "done") {
      done += 1;
    } else {
      unknown += 1;
    }
  }

  return {
    waiting,
    running,
    idle,
    done,
    unknown,
    settled: idle + done + unknown,
    unavailable: false,
  };
}

/**
 * PURE: classify a heartbeat timestamp. `running` inside the stale threshold,
 * `stale` at or past it, `off` when there is no usable timestamp.
 */
export function pollerStatus({ atMs, nowMs } = {}) {
  const at = Number(atMs);
  const now = Number(nowMs);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return { state: "off", ageMs: null };
  const ageMs = Math.max(0, now - at);
  return { state: ageMs >= POLLER_STALE_MS ? "stale" : "running", ageMs };
}

function stripIndexPrefix(label) {
  return String(label).replace(/^\[\d+\]\s*/, "");
}

/** Tab name like the alert address line: strip `[N]`; drop empty/numeric. */
function tabNameOf(location) {
  const raw = firstString(location?.tabLabel);
  if (raw === null) return null;
  const name = stripIndexPrefix(raw).trim();
  if (name === "" || /^\d+$/.test(name)) return null;
  return name;
}

function pollerText(poller) {
  if (!poller || (poller.state !== "running" && poller.state !== "stale")) return "off";
  const seconds = Math.max(0, Math.floor(Number(poller.ageMs) / 1000));
  return `${poller.state} (${seconds}s ago)`;
}

function padEnd(value, width) {
  return String(value).padEnd(width);
}

/**
 * PURE: render the status action's plain-text report from a state object:
 *
 *   {
 *     enabled, defaulted,          // alerts switch and whether the default decided it
 *     token, chatId,               // raw values; rendered only as set/missing
 *     poller: { state, ageMs },
 *     summary: { waiting, running, idle, done, unknown, unavailable },
 *   }
 *
 * Credentials never reach the text; only `set`/`missing` is printed. When the
 * summary is unavailable the local state still renders and the agent counts
 * are replaced by one line. Returns the text without a trailing newline.
 */
export function renderReport(state = {}) {
  const lines = [];
  const defaulted = state.defaulted ? " (default)" : "";
  lines.push(
    `alherdr: alerts ${state.enabled ? "enabled" : "disabled"}${defaulted}` +
      ` · token ${state.token ? "set" : "missing"}` +
      ` · chat ${state.chatId ? "set" : "missing"}` +
      ` · poller ${pollerText(state.poller)}`,
  );

  const summary = state.summary;
  if (!summary || summary.unavailable) {
    lines.push("agent counts unavailable");
    return lines.join("\n");
  }

  const waiting = Array.isArray(summary.waiting) ? summary.waiting : [];
  if (waiting.length === 0) {
    lines.push("nothing waiting for you");
  } else {
    lines.push(`${waiting.length} waiting for you:`);
    const rows = waiting.map((entry) => {
      const location = entry?.location ?? {};
      return {
        agent: String(entry?.agent ?? "unknown"),
        pane: firstString(location.paneId) ?? "no-pane",
        tab: tabNameOf(location) ?? "-",
        ws: location.workspaceNumber != null ? `ws ${location.workspaceNumber}` : "ws ?",
        tabNo: location.tabNumber != null ? `tab ${location.tabNumber}` : "tab ?",
      };
    });
    const agentWidth = Math.max(...rows.map((row) => row.agent.length));
    const paneWidth = Math.max(...rows.map((row) => row.pane.length));
    const tabWidth = Math.max(...rows.map((row) => row.tab.length));
    for (const row of rows) {
      lines.push(
        `  ${padEnd(row.agent, agentWidth)} · ${padEnd(row.pane, paneWidth)} · ` +
          `${padEnd(row.tab, tabWidth)} · ${row.ws} · ${row.tabNo}`,
      );
    }
  }

  const counts = [
    `${summary.running ?? 0} running`,
    `${summary.idle ?? 0} idle`,
    `${summary.done ?? 0} done`,
  ];
  if (Number(summary.unknown) > 0) counts.push(`${summary.unknown} unknown`);
  lines.push(counts.join(" · "));

  return lines.join("\n");
}
