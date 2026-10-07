import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { main, senseEvent } from "../src/notify.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CFG = {
  statuses: new Set(["blocked", "done"]),
  alertReleased: true,
  alertExited: true,
};

const dirs = [];
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `alherdr-${label}-`));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function runNotify(overrides = {}) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    ...overrides,
  };
  return spawnSync(process.execPath, ["src/notify.mjs"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 20000,
  });
}

function scenarioEnv(dir, extra = {}) {
  return {
    HERDR_PLUGIN_ROOT: REPO_ROOT,
    HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
    HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
    HERDR_BIN_PATH: join(dir, "no-such-herdr"),
    ALHERDR_DRY_RUN: "1",
    ...extra,
  };
}

function statusEvent(overrides = {}) {
  return {
    event: "pane.agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: "w1J:p1",
      workspace_id: "w1J",
      agent_status: "done",
      agent: "pi",
      display_agent: "pi",
      title: "pi - demo",
      ...overrides,
    },
  };
}

// --- classification ---------------------------------------------------------

test("classifies blocked and done status changes", () => {
  const blocked = senseEvent(
    { HERDR_PLUGIN_EVENT: "pane.agent_status_changed" },
    statusEvent({ agent_status: "blocked", agent: "claude", display_agent: "Claude" }),
    DEFAULT_CFG,
  );
  assert.equal(blocked.kind, "blocked");
  assert.equal(blocked.paneId, "w1J:p1");
  assert.equal(blocked.workspaceId, "w1J");
  assert.equal(blocked.agent, "claude");
  assert.equal(blocked.displayAgent, "Claude");
  assert.equal(blocked.title, "pi - demo");

  const done = senseEvent(
    { HERDR_PLUGIN_EVENT: "pane.agent_status_changed" },
    statusEvent(),
    DEFAULT_CFG,
  );
  assert.equal(done.kind, "done");
});

test("only alerts statuses enabled in cfg.statuses", () => {
  const working = statusEvent({ agent_status: "working" });
  assert.equal(
    senseEvent({ HERDR_PLUGIN_EVENT: "pane.agent_status_changed" }, working, DEFAULT_CFG),
    null,
  );
  const custom = { ...DEFAULT_CFG, statuses: new Set(["working"]) };
  assert.equal(
    senseEvent({ HERDR_PLUGIN_EVENT: "pane.agent_status_changed" }, working, custom).kind,
    "working",
  );
});

test("agent_detected only alerts on released=true with an agent", () => {
  const env = { HERDR_PLUGIN_EVENT: "pane.agent_detected" };
  const start = {
    event: "pane.agent_detected",
    data: { pane_id: "p1", agent: "pi", released: false, title: "t" },
  };
  const released = {
    event: "pane.agent_detected",
    data: { pane_id: "p1", agent: "pi", display_agent: "pi", released: true, title: "t" },
  };
  const noAgent = {
    event: "pane.agent_detected",
    data: { pane_id: "p1", agent: null, released: true, title: "t" },
  };
  const objectAgent = {
    event: "pane.agent_detected",
    data: { pane_id: "p1", agent: { name: "codex" }, released: true, title: "t" },
  };

  assert.equal(senseEvent(env, start, DEFAULT_CFG), null);
  assert.equal(senseEvent(env, released, DEFAULT_CFG).kind, "released");
  assert.equal(senseEvent(env, noAgent, DEFAULT_CFG), null);
  assert.equal(senseEvent(env, objectAgent, DEFAULT_CFG).agent, "codex");
  assert.equal(
    senseEvent(env, released, { ...DEFAULT_CFG, alertReleased: false }),
    null,
  );
});

test("pane.exited alerts unless alertExited is off", () => {
  const env = { HERDR_PLUGIN_EVENT: "pane.exited" };
  const exited = { event: "pane.exited", data: { pane_id: "p1" } };
  assert.equal(senseEvent(env, exited, DEFAULT_CFG).kind, "exited");
  assert.equal(senseEvent(env, exited, { ...DEFAULT_CFG, alertExited: false }), null);
});

test("accepts flat payloads, nested statuses and envelope event names", () => {
  const flat = senseEvent(
    { HERDR_PLUGIN_EVENT: "pane.agent_status_changed" },
    { agent_status: "blocked", pane_id: "p2" },
    DEFAULT_CFG,
  );
  assert.equal(flat.kind, "blocked");
  assert.equal(flat.paneId, "p2");

  const nested = senseEvent(
    { HERDR_PLUGIN_EVENT: "pane.agent_status_changed" },
    { data: { pane_id: "p3", state: { agent_status: "done" } } },
    DEFAULT_CFG,
  );
  assert.equal(nested.kind, "done");

  const fromEnvelope = senseEvent(
    {},
    {
      event: "pane.agent_detected",
      data: { pane_id: "p4", agent: "pi", released: true },
    },
    DEFAULT_CFG,
  );
  assert.equal(fromEnvelope.kind, "released");

  const fromEnvJson = senseEvent(
    { HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent({ agent_status: "blocked" })) },
    undefined,
    DEFAULT_CFG,
  );
  assert.equal(fromEnvJson.kind, "blocked");
});

test("returns null for unknown events and malformed JSON without throwing", () => {
  assert.equal(senseEvent({ HERDR_PLUGIN_EVENT: "pane.focused" }, { data: {} }, DEFAULT_CFG), null);
  assert.equal(senseEvent({ HERDR_PLUGIN_EVENT: "pane.agent_status_changed" }, "{oops", DEFAULT_CFG), null);
  assert.equal(senseEvent({ HERDR_PLUGIN_EVENT: "pane.agent_status_changed" }, "", DEFAULT_CFG), null);
  assert.equal(senseEvent({}, undefined, DEFAULT_CFG), null);
  // Default gates apply when cfg is omitted.
  assert.equal(
    senseEvent({ HERDR_PLUGIN_EVENT: "pane.agent_status_changed" }, statusEvent({ agent_status: "blocked" }))
      .kind,
    "blocked",
  );
});

// --- notify.mjs pipeline ----------------------------------------------------

test("REGRESSION: plain-text pane stdout reaches the rendered alert end to end", async (t) => {
  const dir = tempDir("notify-plaintext");
  const writes = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });

  const spawnCalls = [];
  const spawnImpl = (bin, args) => {
    spawnCalls.push({ bin, args });
    return {
      status: 0,
      // The verified contract: raw terminal text on stdout, no JSON envelope.
      stdout: " ▎ I need your approval to apply the change.\n ▎ ✿ waiting for input\n",
      stderr: "",
    };
  };

  const code = await main({
    env: {
      ...scenarioEnv(dir),
      HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent({ agent_status: "blocked" })),
    },
    spawnImpl,
  });

  assert.equal(code, 0);
  assert.equal(spawnCalls.length, 2);
  // The digest read runs first; the snapshot read follows the dedupe gate.
  assert.deepEqual(spawnCalls[1].args, ["api", "snapshot"]);
  const output = writes.join("");
  assert.match(output, /I need your approval to apply the change\./);
  assert.ok(!output.includes("waiting for input"));
});

test("an injected snapshot resolves the location into the rendered three-line alert", async (t) => {
  const dir = tempDir("notify-location");
  const writes = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });

  const snapshot = {
    workspaces: [
      {
        workspace_id: "wA",
        label: "[1] example-repo",
        worktree: {
          checkout_path: "/repos/example-repo",
          is_linked_worktree: false,
          repo_name: "example-repo",
          repo_root: "/repos/example-repo",
        },
      },
      {
        workspace_id: "wB",
        label: "[2] feat-example",
        worktree: {
          checkout_path: "/worktrees/example-repo/feat-example",
          is_linked_worktree: true,
          repo_name: "example-repo",
          repo_root: "/repos/example-repo",
        },
      },
    ],
    tabs: [{ tab_id: "wB:t1", workspace_id: "wB", label: "[1] pi", number: 19 }],
    panes: [
      {
        pane_id: "wB:p1",
        workspace_id: "wB",
        tab_id: "wB:t1",
        cwd: "/worktrees/example-repo/feat-example",
        foreground_cwd: "/worktrees/example-repo/feat-example",
      },
    ],
  };

  const code = await main({
    env: {
      ...scenarioEnv(dir),
      HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify(
        statusEvent({ pane_id: "wB:p1", workspace_id: "wB", agent_status: "blocked" }),
      ),
    },
    snapshot,
    branchResolver: () => ({ branch: "feat/example" }),
    spawnImpl: () => ({ status: 1, stdout: "", stderr: "no digest" }),
  });

  assert.equal(code, 0);
  const output = writes.join("");
  assert.match(output, /^🙋 pi needs your answer\n/);
  assert.match(output, /example-repo · feat\/example · worktree 2\/2/);
  assert.match(output, /ws 2 · tab 1 · wB:p1/);
});

test("a failed snapshot still renders a usable alert and exits 0", async (t) => {
  const dir = tempDir("notify-snapshot-fail");
  const writes = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });

  const spawnImpl = (bin, args) => {
    if (args[0] === "api") return { status: 1, stdout: "", stderr: "snapshot unavailable" };
    return { status: 0, stdout: " ▎ Approve the patch?\n", stderr: "" };
  };

  const code = await main({
    env: {
      ...scenarioEnv(dir),
      HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify(
        statusEvent({ pane_id: "wA:p1", workspace_id: "wA", agent_status: "blocked" }),
      ),
    },
    spawnImpl,
  });

  assert.equal(code, 0);
  assert.equal(
    writes.join(""),
    [
      "🙋 pi needs your answer",
      "pi · pi - demo · wA:p1",
      "────────────",
      "Approve the patch?",
    ].join("\n") + "\n",
  );
});

test("the hook exits 0 with an empty digest when every read source fails", async (t) => {
  const dir = tempDir("notify-read-fail");
  const writes = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });

  const calls = [];
  const spawnImpl = (bin, args) => {
    calls.push(args);
    return { status: 1, stdout: "", stderr: "agent_not_idle" };
  };

  const code = await main({
    env: {
      ...scenarioEnv(dir),
      HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent({ agent_status: "blocked" })),
    },
    spawnImpl,
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 3);
  const output = writes.join("");
  assert.match(output, /needs your answer/);
  assert.ok(!output.includes("────"));
});

test("dry-run smoke: prints the rendered alert and exits 0", () => {
  const dir = tempDir("notify-dry");
  const result = runNotify({
    ...scenarioEnv(dir),
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent()),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /✅ pi finished/);
  assert.match(result.stdout, /pi · pi - demo · w1J:p1/);
  assert.equal(result.stdout.trim().split("\n").length, 2);
});

test("dry-run includes a pane digest read through HERDR_BIN_PATH", () => {
  const dir = tempDir("notify-digest");
  const fakeHerdr = join(dir, "fake-herdr.mjs");
  writeFileSync(
    fakeHerdr,
    `#!/usr/bin/env node
// herdr agent read emits raw terminal text on stdout, not JSON.
process.stdout.write(" ▎ agent question\\n ▎ ✿ waiting for input\\n");
`,
    { mode: 0o755 },
  );

  const result = runNotify({
    ...scenarioEnv(dir, { HERDR_BIN_PATH: fakeHerdr }),
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent({ agent_status: "blocked" })),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /needs your answer/);
  assert.match(result.stdout, /agent question/);
  assert.ok(!result.stdout.includes("waiting for input"));
});

test("dedupe suppresses a repeated status within the window", () => {
  const dir = tempDir("notify-dedupe");
  const env = {
    ...scenarioEnv(dir, { ALHERDR_DEDUPE_SECONDS: "600" }),
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent({ agent_status: "blocked" })),
  };
  const first = runNotify(env);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /needs your answer/);

  const second = runNotify(env);
  assert.equal(second.status, 0);
  assert.equal(second.stdout.trim(), "");
});

test("released and exited are one user-visible event for a pane", () => {
  const dir = tempDir("notify-stop");
  const base = scenarioEnv(dir, { ALHERDR_DEDUPE_SECONDS: "600" });
  const released = {
    event: "pane.agent_detected",
    data: { pane_id: "p1", agent: "pi", display_agent: "pi", released: true, title: "t" },
  };
  const exited = { event: "pane.exited", data: { pane_id: "p1" } };

  const first = runNotify({
    ...base,
    HERDR_PLUGIN_EVENT: "pane.agent_detected",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(released),
  });
  assert.equal(first.status, 0);
  assert.match(first.stdout, /left the pane/);

  const second = runNotify({
    ...base,
    HERDR_PLUGIN_EVENT: "pane.exited",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(exited),
  });
  assert.equal(second.status, 0);
  assert.equal(second.stdout.trim(), "");
});

test("a disabled plugin exits 0 silently", () => {
  const dir = tempDir("notify-disabled");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "enabled"), "0");

  const result = runNotify({
    ...scenarioEnv(dir),
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent()),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("a non-dry-run alert without credentials exits 0 and logs to stderr", () => {
  const dir = tempDir("notify-nocreds");
  const result = runNotify({
    ...scenarioEnv(dir, { ALHERDR_DRY_RUN: "0" }),
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent({ agent_status: "blocked" })),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID/);
});

test("ALHERDR_DEBUG_DUMP appends raw, parsed and kind for filtered-out events", () => {
  const dir = tempDir("notify-debug");
  const dump = join(dir, "events.jsonl");
  const env = {
    ...scenarioEnv(dir),
    ALHERDR_DEBUG_DUMP: dump,
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent({ agent_status: "working" })),
  };

  const first = runNotify(env);
  assert.equal(first.status, 0);
  assert.equal(first.stdout.trim(), ""); // working is not in cfg.statuses

  const second = runNotify({
    ...env,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent({ agent_status: "blocked" })),
  });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /needs your answer/);

  const lines = readFileSync(dump, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const filtered = JSON.parse(lines[0]);
  assert.equal(filtered.raw, env.HERDR_PLUGIN_EVENT_JSON);
  assert.equal(filtered.parsed.event, "pane.agent_status_changed");
  assert.equal(filtered.parsed.data.agent_status, "working");
  assert.equal(filtered.kind, null);
  assert.equal(JSON.parse(lines[1]).kind, "blocked");
});

test("ALHERDR_DEBUG_DUMP captures events even while alerts are disabled", () => {
  const dir = tempDir("notify-debug-disabled");
  const dump = join(dir, "events.jsonl");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "enabled"), "0");

  const result = runNotify({
    ...scenarioEnv(dir),
    ALHERDR_DEBUG_DUMP: dump,
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent()),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(readFileSync(dump, "utf8").trim()).kind, "done");
});

test("an unwritable ALHERDR_DEBUG_DUMP is logged and ignored", () => {
  const dir = tempDir("notify-debug-bad");
  const result = runNotify({
    ...scenarioEnv(dir),
    ALHERDR_DEBUG_DUMP: join(dir, "missing-dir", "events.jsonl"),
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(statusEvent()),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /finished/);
  assert.match(result.stderr, /could not write ALHERDR_DEBUG_DUMP/);
});
