import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { TEST_DIGEST, buildTestAlert, main, maskChatId, maskToken } from "../src/actions.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const dirs = [];
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `alherdr-${label}-`));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function runActions(command, overrides = {}) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    ...overrides,
  };
  return spawnSync(process.execPath, ["src/actions.mjs", command], {
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
    ...extra,
  };
}

test("maskToken never reveals the secret half", () => {
  assert.equal(maskToken("123456:super-secret"), "123456:***");
  assert.equal(maskToken(""), "(not configured)");
  assert.equal(maskToken("garbage"), "***");
  assert.ok(!maskToken("123456:super-secret").includes("super-secret"));
});

test("maskChatId reveals at most the last four digits", () => {
  assert.equal(maskChatId("998877"), "***8877");
  assert.equal(maskChatId("12"), "***");
  assert.equal(maskChatId(""), "(not configured)");
});

test("buildTestAlert reads HERDR_PLUGIN_CONTEXT_JSON", () => {
  const alert = buildTestAlert({
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: "w1",
      pane: { pane_id: "w1:p2" },
      agent: { name: "claude" },
    }),
  });
  assert.equal(alert.kind, "blocked");
  assert.equal(alert.paneId, "w1:p2");
  assert.equal(alert.workspaceId, "w1");
  assert.equal(alert.agent, "claude");
  assert.equal(alert.displayAgent, "claude");
});

test("buildTestAlert falls back to the HERDR_* pane ids", () => {
  const alert = buildTestAlert({
    HERDR_PANE_ID: "p9",
    HERDR_WORKSPACE_ID: "w9",
    HERDR_TAB_ID: "t9",
  });
  assert.equal(alert.paneId, "p9");
  assert.equal(alert.workspaceId, "w9");
  assert.equal(alert.tabId, "t9");
  assert.equal(alert.agent, "test-agent");
});

test("send-test in dry-run prints the alert, the result and a masked summary", () => {
  const dir = tempDir("actions-send-test");
  const result = runActions("send-test", {
    ...scenarioEnv(dir),
    ALHERDR_DRY_RUN: "1",
    TELEGRAM_BOT_TOKEN: "123456:super-secret",
    TELEGRAM_CHAT_ID: "998877",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: "w1",
      pane: { pane_id: "w1:p2" },
      agent: { name: "claude" },
    }),
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /🙋 claude needs your answer/);
  assert.match(result.stdout, /claude · w1/);
  assert.match(result.stdout, /Agent Alerts test message/);
  assert.match(result.stdout, /result: ok · status 0 · dry-run: not sent/);
  assert.match(result.stdout, /token: 123456:\*\*\*/);
  assert.match(result.stdout, /chat: \*\*\*8877/);
  assert.ok(!result.stdout.includes("super-secret"));
});

test("send-test renders the three-line anatomy with an injected snapshot and context", async (t) => {
  const dir = tempDir("actions-location");
  const writes = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });

  const snapshot = {
    workspaces: [
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
    ],
    tabs: [{ tab_id: "wB:t1", workspace_id: "wB", label: "[1] pi" }],
    panes: [
      {
        pane_id: "wB:p1",
        workspace_id: "wB",
        tab_id: "wB:t1",
        cwd: "/worktrees/example-repo/feat-example",
      },
    ],
  };

  const code = await main(["send-test"], {
    env: {
      ...scenarioEnv(dir),
      ALHERDR_DRY_RUN: "1",
      TELEGRAM_BOT_TOKEN: "123456:super-secret",
      TELEGRAM_CHAT_ID: "998877",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        pane: { pane_id: "wB:p1" },
        workspace_id: "wB",
        tab_id: "wB:t1",
        agent: { name: "claude" },
      }),
    },
    snapshot,
    branchResolver: () => ({ branch: "feat/example" }),
  });

  assert.equal(code, 0);
  const lines = writes.join("").split("\n");
  assert.equal(lines[0], "🙋 claude needs your answer");
  assert.equal(lines[1], "example-repo · feat/example · worktree 2/2");
  assert.equal(lines[2], "ws 2 · tab 1 · wB:p1");
  assert.equal(lines[3], "────────────");
  assert.equal(lines[4], TEST_DIGEST);
  assert.match(writes.join(""), /result: ok · status 0 · dry-run: not sent/);
});

test("send-test degrades to a usable single line and still delivers when the snapshot fails", async (t) => {
  const dir = tempDir("actions-snapshot-fail");
  const writes = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });

  const spawnCalls = [];
  const spawnImpl = (bin, args) => {
    spawnCalls.push(args);
    return { status: 1, stdout: "", stderr: "snapshot unavailable" };
  };

  const fetchCalls = [];
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
  };

  const code = await main(["send-test"], {
    env: {
      ...scenarioEnv(dir),
      ALHERDR_DRY_RUN: "0",
      TELEGRAM_BOT_TOKEN: "123456:super-secret",
      TELEGRAM_CHAT_ID: "998877",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        pane: { pane_id: "wZ:p9" },
        workspace_id: "wZ",
        title: "demo title",
        agent: { name: "claude" },
      }),
    },
    spawnImpl,
    fetchImpl,
  });

  assert.equal(code, 0);
  assert.equal(fetchCalls.length, 1);
  // Only the topology snapshot is read; the action never reads the pane.
  assert.deepEqual(spawnCalls, [["api", "snapshot"]]);
  const body = JSON.parse(fetchCalls[0].options.body);
  assert.equal(
    body.text,
    [
      "🙋 claude needs your answer",
      "claude · demo title · wZ:p9",
      "────────────",
      TEST_DIGEST,
    ].join("\n"),
  );
  assert.ok(!writes.join("").includes("\nws "));
  assert.ok(!writes.join("").includes("super-secret"));
});

test("send-test never uses a live pane digest even when a pane read would succeed", async (t) => {
  const dir = tempDir("actions-no-digest");
  const writes = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });

  const spawnCalls = [];
  const spawnImpl = (bin, args) => {
    spawnCalls.push(args);
    if (args[0] === "agent") {
      // A readable live digest, if the action still asked for one.
      return { status: 0, stdout: " ▎ LIVE DIGEST TEXT that must never be sent\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "snapshot unavailable" };
  };

  const fetchCalls = [];
  const fetchImpl = async (url, options) => {
    fetchCalls.push(JSON.parse(options.body).text);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
  };

  const code = await main(["send-test"], {
    env: {
      ...scenarioEnv(dir),
      ALHERDR_DRY_RUN: "0",
      TELEGRAM_BOT_TOKEN: "123456:super-secret",
      TELEGRAM_CHAT_ID: "998877",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        pane: { pane_id: "wZ:p9" },
        workspace_id: "wZ",
        agent: { name: "claude" },
      }),
    },
    spawnImpl,
    fetchImpl,
  });

  assert.equal(code, 0);
  assert.equal(fetchCalls.length, 1);
  assert.ok(!fetchCalls[0].includes("LIVE DIGEST"));
  assert.ok(fetchCalls[0].includes(TEST_DIGEST));
  assert.deepEqual(spawnCalls, [["api", "snapshot"]]);
  assert.ok(!writes.join("").includes("LIVE DIGEST"));
});

test("send-test fails cleanly when credentials are missing", () => {
  const dir = tempDir("actions-no-creds");
  const result = runActions("send-test", scenarioEnv(dir, { ALHERDR_DRY_RUN: "0" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /result: fail · status 0 · missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID/);
  assert.match(result.stdout, /token: \(not configured\)/);
});

test("disable, enable and toggle write the enabled state file", () => {
  const dir = tempDir("actions-toggle");
  const env = scenarioEnv(dir);

  const disabled = runActions("disable", env);
  assert.equal(disabled.status, 0);
  assert.match(disabled.stdout, /alerts disabled/);
  assert.equal(readFileSync(join(dir, "state", "enabled"), "utf8"), "0");

  const toggled = runActions("toggle", env);
  assert.equal(toggled.status, 0);
  assert.match(toggled.stdout, /alerts enabled/);
  assert.equal(readFileSync(join(dir, "state", "enabled"), "utf8"), "1");

  const enabled = runActions("enable", env);
  assert.equal(enabled.status, 0);
  assert.match(enabled.stdout, /alerts enabled/);
});

test("an unknown action prints usage and exits 2", () => {
  const dir = tempDir("actions-unknown");
  const result = runActions("banana", scenarioEnv(dir));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node src\/actions\.mjs/);
});
