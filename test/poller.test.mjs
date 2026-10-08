import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTH_BACKOFF_MS,
  CONFLICT_BACKOFF_MS,
  NETWORK_BACKOFF_MS,
  POLLER_OFFSET_FILE,
  POLLER_PID_FILE,
  claimPidFile,
  formatReply,
  main,
  parseCommand,
  readOffset,
  releasePidFile,
  runPoller,
  writeHeartbeat,
} from "../src/poller.mjs";
import { POLLER_HEARTBEAT_FILE } from "../src/report.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Synthetic identifiers only: no real token, chat id or workspace label.
const CHAT = "998877";

const dirs = [];
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `alherdr-${label}-`));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function testCfg(dir, extra = {}) {
  return {
    token: "123456:synthetic-token",
    chatId: CHAT,
    stateDir: join(dir, "state"),
    telegramCommands: true,
    herdrBin: "herdr",
    ...extra,
  };
}

const SNAPSHOT = {
  workspaces: [
    {
      workspace_id: "wA",
      label: "[1] example",
      worktree: {
        checkout_path: "/repos/example",
        is_linked_worktree: false,
        repo_name: "example",
        repo_root: "/repos/example",
      },
    },
  ],
  tabs: [{ tab_id: "wA:t1", workspace_id: "wA", label: "[1] api" }],
  panes: [{ pane_id: "wA:p1", workspace_id: "wA", tab_id: "wA:t1", cwd: "/repos/example" }],
  agents: [
    { agent: "pi<&>", agent_status: "blocked", pane_id: "wA:p1" },
    { agent: "claude", agent_status: "working", pane_id: "wA:p1" },
  ],
};

function snapshotSpawn() {
  const calls = [];
  const spawnImpl = (bin, args) => {
    calls.push([bin, ...args]);
    return { status: 0, stdout: JSON.stringify({ result: { snapshot: SNAPSHOT } }) };
  };
  return { spawnImpl, calls };
}

function commandUpdate(text, { chatId = CHAT, id = 1 } = {}) {
  return { update_id: id, message: { message_id: id, chat: { id: chatId }, text } };
}

function telegramFetch({ updates = [], onGetUpdates } = {}) {
  const calls = { getUpdates: [], sendMessage: [] };
  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(options.body ?? "{}");
    if (String(url).includes("/sendMessage")) {
      calls.sendMessage.push({ url, body });
      return { status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }
    calls.getUpdates.push({ url, body });
    if (onGetUpdates) return onGetUpdates(body, calls.getUpdates.length);
    return { status: 200, json: async () => ({ ok: true, result: updates }) };
  };
  return { fetchImpl, calls };
}

function collectingSleep(sleeps) {
  return async (ms) => {
    sleeps.push(ms);
  };
}

function quietLog(lines) {
  return (line) => {
    lines.push(String(line));
  };
}

// --- command parsing and reply formatting -----------------------------------

test("parseCommand reads /status, /help and @BotName suffixes, and ignores chatter", () => {
  assert.equal(parseCommand("/status"), "status");
  assert.equal(parseCommand("/STATUS"), "status");
  assert.equal(parseCommand("/status@ExampleBot"), "status");
  assert.equal(parseCommand("  /help please "), "help");
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand("/"), null);
  assert.equal(parseCommand(null), null);
});

test("formatReply keeps alignment, escapes dynamic values and fits one message", () => {
  const reply = formatReply("pi<&>  ·  wA:p1\nnext");
  assert.equal(reply.text, "<pre>pi&lt;&amp;&gt;  ·  wA:p1\nnext</pre>");
  assert.equal(reply.plainText, "pi<&>  ·  wA:p1\nnext");

  const huge = formatReply("x".repeat(9000));
  assert.ok(huge.text.length <= 4000);
  assert.ok(huge.text.startsWith("<pre>"));
  assert.ok(huge.text.endsWith("</pre>"));
});

// --- polling cycles ----------------------------------------------------------

test("/status from the configured chat sends one report with the aligned waiting list", async () => {
  const dir = tempDir("poller-status");
  const cfg = testCfg(dir);
  const { spawnImpl, calls: spawnCalls } = snapshotSpawn();
  const { fetchImpl, calls } = telegramFetch({ updates: [commandUpdate("/status", { id: 41 })] });
  const sleeps = [];
  const logs = [];

  const outcome = await runPoller({
    cfg,
    fetchImpl,
    spawnImpl,
    sleepImpl: collectingSleep(sleeps),
    log: quietLog(logs),
    maxCycles: 1,
  });

  assert.deepEqual({ cycles: outcome.cycles, reason: outcome.reason }, { cycles: 1, reason: "max-cycles" });
  assert.equal(calls.getUpdates.length, 1);
  assert.equal(calls.getUpdates[0].body.offset, 0);
  assert.equal(calls.getUpdates[0].body.timeout, 30);
  assert.equal(calls.sendMessage.length, 1);

  const sent = calls.sendMessage[0].body;
  assert.equal(sent.chat_id, CHAT);
  assert.equal(sent.parse_mode, "HTML");
  assert.match(sent.text, /^<pre>/);
  assert.match(sent.text, /waiting for you/);
  assert.match(sent.text, /pi&lt;&amp;&gt;/);
  assert.match(sent.text, /wA:p1/);
  assert.ok(!sent.text.includes("pi<&>"));
  // Exactly one snapshot read: the same report the status action renders.
  assert.deepEqual(spawnCalls, [["herdr", "api", "snapshot"]]);
  assert.ok(existsSync(join(cfg.stateDir, "telegram-poller.offset")));
  assert.equal(readOffset(cfg), 42);
  assert.equal(sleeps.length, 0);
});

test("/status from a different chat is ignored entirely: no reply, no snapshot", async () => {
  const dir = tempDir("poller-other-chat");
  const cfg = testCfg(dir);
  const { spawnImpl, calls: spawnCalls } = snapshotSpawn();
  const { fetchImpl, calls } = telegramFetch({
    updates: [commandUpdate("/status", { chatId: "111111", id: 5 })],
  });

  await runPoller({
    cfg,
    fetchImpl,
    spawnImpl,
    sleepImpl: collectingSleep([]),
    log: quietLog([]),
    maxCycles: 1,
  });

  assert.equal(calls.sendMessage.length, 0);
  assert.equal(spawnCalls.length, 0);
  // The update was still consumed, so a restart does not replay it.
  assert.equal(readOffset(cfg), 6);
});

test("never replies for anything but a command from the configured chat", async () => {
  const dir = tempDir("poller-no-reply");
  const cfg = testCfg(dir);
  const { spawnImpl } = snapshotSpawn();
  const { fetchImpl, calls } = telegramFetch({
    updates: [
      commandUpdate("hello there", { id: 1 }),
      commandUpdate("/status", { chatId: "222222", id: 2 }),
      { update_id: 3, edited_message: { chat: { id: CHAT }, text: "/status" } },
      { update_id: 4 },
    ],
  });

  await runPoller({
    cfg,
    fetchImpl,
    spawnImpl,
    sleepImpl: collectingSleep([]),
    log: quietLog([]),
    maxCycles: 1,
  });

  assert.equal(calls.sendMessage.length, 0);
  assert.equal(readOffset(cfg), 5);
});

test("/help, /start and an unknown command each reply once", async () => {
  const dir = tempDir("poller-help");
  const cfg = testCfg(dir);
  const { spawnImpl } = snapshotSpawn();
  const { fetchImpl, calls } = telegramFetch({
    updates: [
      commandUpdate("/help", { id: 1 }),
      commandUpdate("/start", { id: 2 }),
      commandUpdate("/banana", { id: 3 }),
    ],
  });

  await runPoller({
    cfg,
    fetchImpl,
    spawnImpl,
    sleepImpl: collectingSleep([]),
    log: quietLog([]),
    maxCycles: 1,
  });

  assert.equal(calls.sendMessage.length, 3);
  assert.match(calls.sendMessage[0].body.text, /\/status/);
  assert.match(calls.sendMessage[1].body.text, /\/status/);
  assert.match(calls.sendMessage[2].body.text, /Unknown command/);
  for (const sent of calls.sendMessage) assert.equal(sent.body.chat_id, CHAT);
});

test("the offset advances and survives a simulated restart", async () => {
  const dir = tempDir("poller-offset");
  const cfg = testCfg(dir);
  const { spawnImpl } = snapshotSpawn();

  const first = telegramFetch({ updates: [commandUpdate("/help", { id: 7 })] });
  await runPoller({
    cfg,
    fetchImpl: first.fetchImpl,
    spawnImpl,
    sleepImpl: collectingSleep([]),
    log: quietLog([]),
    maxCycles: 1,
  });
  assert.equal(first.calls.getUpdates[0].body.offset, 0);
  assert.equal(readOffset(cfg), 8);
  assert.equal(readFileSync(join(cfg.stateDir, POLLER_OFFSET_FILE), "utf8").trim(), "8");

  const second = telegramFetch({ updates: [commandUpdate("/help", { id: 9 })] });
  await runPoller({
    cfg,
    fetchImpl: second.fetchImpl,
    spawnImpl,
    sleepImpl: collectingSleep([]),
    log: quietLog([]),
    maxCycles: 1,
  });
  assert.equal(second.calls.getUpdates[0].body.offset, 8);
  assert.equal(readOffset(cfg), 10);
});

// --- failure handling --------------------------------------------------------

test("a network error backs off without throwing", async () => {
  const dir = tempDir("poller-network");
  const cfg = testCfg(dir);
  const sleeps = [];
  const logs = [];

  const outcome = await runPoller({
    cfg,
    fetchImpl: async () => {
      throw new Error("network is down");
    },
    sleepImpl: collectingSleep(sleeps),
    log: quietLog(logs),
    maxCycles: 1,
  });

  assert.equal(outcome.reason, "max-cycles");
  assert.deepEqual(sleeps, [NETWORK_BACKOFF_MS]);
  assert.ok(logs.some((line) => /network is down/.test(line)));
});

test("a 409 from getUpdates logs the conflict and backs off", async () => {
  const dir = tempDir("poller-409");
  const cfg = testCfg(dir);
  const sleeps = [];
  const logs = [];

  await runPoller({
    cfg,
    fetchImpl: async () => ({
      status: 409,
      json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates" }),
    }),
    sleepImpl: collectingSleep(sleeps),
    log: quietLog(logs),
    maxCycles: 1,
  });

  assert.deepEqual(sleeps, [CONFLICT_BACKOFF_MS]);
  assert.ok(logs.some((line) => /409/.test(line) && /webhook|poller/i.test(line)));
});

test("a 401 backs off hard and keeps backing off hard", async () => {
  const dir = tempDir("poller-401");
  const cfg = testCfg(dir);
  const sleeps = [];
  const logs = [];

  await runPoller({
    cfg,
    fetchImpl: async () => ({
      status: 401,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    }),
    sleepImpl: collectingSleep(sleeps),
    log: quietLog(logs),
    maxCycles: 2,
  });

  assert.deepEqual(sleeps, [AUTH_BACKOFF_MS, AUTH_BACKOFF_MS]);
  assert.ok(AUTH_BACKOFF_MS >= 60_000);
  assert.ok(logs.some((line) => /401/.test(line)));
});

test("the heartbeat is written after every cycle, even a failed one", async () => {
  const dir = tempDir("poller-heartbeat");
  const cfg = testCfg(dir);

  await runPoller({
    cfg,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    sleepImpl: collectingSleep([]),
    log: quietLog([]),
    maxCycles: 1,
  });

  const heartbeat = join(cfg.stateDir, POLLER_HEARTBEAT_FILE);
  const stats = statSync(heartbeat);
  assert.ok(Math.abs(Date.now() - stats.mtimeMs) < 10_000);
  assert.notEqual(readFileSync(heartbeat, "utf8").trim(), "");
});

// --- PID ownership -----------------------------------------------------------

test("claimPidFile refuses a PID file held by a live process", () => {
  const dir = tempDir("poller-pid");
  const cfg = testCfg(dir);
  mkdirSync(cfg.stateDir, { recursive: true });
  const file = join(cfg.stateDir, POLLER_PID_FILE);
  writeFileSync(file, "424242\n");

  assert.equal(
    claimPidFile(cfg, { pid: 111, alive: (pid) => pid === 424242 }),
    false,
  );
  assert.equal(readFileSync(file, "utf8").trim(), "424242");

  writeFileSync(file, "424242\n");
  assert.equal(
    claimPidFile(cfg, { pid: 111, alive: () => false }),
    true,
  );
  assert.equal(readFileSync(file, "utf8").trim(), "111");
});

test("releasePidFile only removes the file when it still names this process", () => {
  const dir = tempDir("poller-release");
  const cfg = testCfg(dir);
  mkdirSync(cfg.stateDir, { recursive: true });
  const file = join(cfg.stateDir, POLLER_PID_FILE);

  writeFileSync(file, "222\n");
  assert.equal(releasePidFile(cfg, { pid: 111 }), false);
  assert.ok(existsSync(file));

  writeFileSync(file, "111\n");
  assert.equal(releasePidFile(cfg, { pid: 111 }), true);
  assert.ok(!existsSync(file));
});

test("runPoller exits without polling when the PID file names another process", async () => {
  const dir = tempDir("poller-pid-lost");
  const cfg = testCfg(dir);
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(join(cfg.stateDir, POLLER_PID_FILE), "424242\n");
  let polls = 0;

  const outcome = await runPoller({
    cfg,
    fetchImpl: async () => {
      polls += 1;
      return { status: 200, json: async () => ({ ok: true, result: [] }) };
    },
    sleepImpl: collectingSleep([]),
    log: quietLog([]),
    pid: 111,
    maxCycles: 5,
  });

  assert.equal(polls, 0);
  assert.equal(outcome.reason, "pid-lost");
});

// --- main --------------------------------------------------------------------

test("main claims the PID file while polling and releases it at exit", async () => {
  const dir = tempDir("poller-main");
  const stateDir = join(dir, "state");
  const pidFile = join(stateDir, POLLER_PID_FILE);
  const { fetchImpl, calls } = telegramFetch({ updates: [commandUpdate("/help", { id: 3 })] });
  let pidDuringPoll = null;

  const wrappedFetch = async (url, options) => {
    if (String(url).includes("/getUpdates")) pidDuringPoll = readFileSync(pidFile, "utf8").trim();
    return fetchImpl(url, options);
  };

  const code = await main({
    env: {
      HERDR_PLUGIN_ROOT: REPO_ROOT,
      HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
      HERDR_PLUGIN_STATE_DIR: stateDir,
      ALHERDR_TELEGRAM_COMMANDS: "1",
      TELEGRAM_BOT_TOKEN: "123456:synthetic-token",
      TELEGRAM_CHAT_ID: CHAT,
    },
    fetchImpl: wrappedFetch,
    sleepImpl: collectingSleep([]),
    log: quietLog([]),
    maxCycles: 1,
  });

  assert.equal(code, 0);
  assert.equal(pidDuringPoll, String(process.pid));
  assert.equal(calls.sendMessage.length, 1);
  assert.ok(!existsSync(pidFile));
});

test("main is a no-op that creates nothing when the command responder is off", async () => {
  const dir = tempDir("poller-main-off");
  const stateDir = join(dir, "state");
  let fetched = 0;

  const code = await main({
    env: {
      HERDR_PLUGIN_ROOT: REPO_ROOT,
      HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
      HERDR_PLUGIN_STATE_DIR: stateDir,
      ALHERDR_TELEGRAM_COMMANDS: "0",
      TELEGRAM_BOT_TOKEN: "123456:synthetic-token",
      TELEGRAM_CHAT_ID: CHAT,
    },
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("must not be called");
    },
    sleepImpl: collectingSleep([]),
    log: quietLog([]),
  });

  assert.equal(code, 0);
  assert.equal(fetched, 0);
  assert.ok(!existsSync(stateDir));
  // The default is off too.
  assert.equal(
    await main({ env: { ...process.env, ALHERDR_TELEGRAM_COMMANDS: "" }, log: quietLog([]) }),
    0,
  );
});

test("main exits cleanly without a PID file when credentials are missing", async () => {
  const dir = tempDir("poller-main-nocreds");
  const stateDir = join(dir, "state");

  const code = await main({
    env: {
      HERDR_PLUGIN_ROOT: REPO_ROOT,
      HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
      HERDR_PLUGIN_STATE_DIR: stateDir,
      ALHERDR_TELEGRAM_COMMANDS: "1",
    },
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
    log: quietLog([]),
  });

  assert.equal(code, 1);
  assert.ok(!existsSync(join(stateDir, POLLER_PID_FILE)));
});

test("writeHeartbeat creates the state dir and beats the contract file", () => {
  const dir = tempDir("poller-beat");
  const cfg = testCfg(dir);
  writeHeartbeat(cfg, 1234567890);
  const file = join(cfg.stateDir, POLLER_HEARTBEAT_FILE);
  assert.equal(readFileSync(file, "utf8").trim(), "1234567890");
});
