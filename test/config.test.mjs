import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { loadConfig } from "../src/config.mjs";

const dirs = [];
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `alherdr-${label}-`));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function isolatedEnv(extra = {}) {
  const root = tempDir("config-root");
  const config = tempDir("config-dir");
  const state = tempDir("config-state");
  return {
    env: {
      HERDR_PLUGIN_ROOT: root,
      HERDR_PLUGIN_CONFIG_DIR: config,
      HERDR_PLUGIN_STATE_DIR: state,
      ...extra,
    },
    root,
    config,
    state,
  };
}

test("applies sane defaults when nothing is configured", () => {
  const { env, root, config, state } = isolatedEnv();
  const cfg = loadConfig(env);
  assert.equal(cfg.token, null);
  assert.equal(cfg.chatId, null);
  assert.deepEqual([...cfg.statuses].sort(), ["blocked", "done"]);
  assert.equal(cfg.alertReleased, true);
  assert.equal(cfg.alertExited, true);
  assert.equal(cfg.digestLines, 40);
  assert.equal(cfg.digestMaxChars, 1200);
  assert.equal(cfg.dedupeSeconds, 30);
  assert.equal(cfg.enabledByDefault, true);
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.debugDump, null);
  assert.equal(cfg.configDir, config);
  assert.equal(cfg.stateDir, state);
  assert.equal(cfg.pluginRoot, root);
  assert.equal(cfg.herdrBin, "herdr");
});

test("real environment variables win over dotenv file values", () => {
  const { env, config } = isolatedEnv({
    TELEGRAM_BOT_TOKEN: "env-token",
    ALHERDR_STATUSES: "blocked",
    ALHERDR_DRY_RUN: "1",
  });
  writeFileSync(
    join(config, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=file-token",
      "ALHERDR_STATUSES=working",
      "ALHERDR_DRY_RUN=0",
    ].join("\n"),
  );
  const cfg = loadConfig(env);
  assert.equal(cfg.token, "env-token");
  assert.deepEqual([...cfg.statuses], ["blocked"]);
  assert.equal(cfg.dryRun, true);
});

test("falls back to the plugin root .env and lets the config dir win", () => {
  const { env, config, root } = isolatedEnv();
  writeFileSync(
    join(config, ".env"),
    "TELEGRAM_BOT_TOKEN=config-token\nALHERDR_STATUSES=done\n",
  );
  writeFileSync(
    join(root, ".env"),
    "TELEGRAM_BOT_TOKEN=root-token\nTELEGRAM_CHAT_ID=root-chat\nALHERDR_STATUSES=working\n",
  );
  const cfg = loadConfig(env);
  assert.equal(cfg.token, "config-token");
  assert.equal(cfg.chatId, "root-chat");
  assert.deepEqual([...cfg.statuses], ["done"]);
});

test("parses statuses, ignoring unknown names and normalizing case", () => {
  const { env } = isolatedEnv({ ALHERDR_STATUSES: "blocked,BANANA,  Working ,unknown" });
  const cfg = loadConfig(env);
  assert.deepEqual([...cfg.statuses].sort(), ["blocked", "unknown", "working"]);
});

test("parses boolean variants and falls back on garbage", () => {
  const variants = [
    ["1", true],
    ["TRUE", true],
    ["yes", true],
    ["On", true],
    ["0", false],
    ["false", false],
    ["NO", false],
    ["off", false],
    ["maybe", true], // fallback = true for alerts released
  ];
  for (const [value, expected] of variants) {
    const { env } = isolatedEnv({ ALHERDR_ALERT_RELEASED: value });
    assert.equal(loadConfig(env).alertReleased, expected, `ALHERDR_ALERT_RELEASED=${value}`);
  }
  const { env } = isolatedEnv({ ALHERDR_ENABLED: "maybe" });
  assert.equal(loadConfig(env).enabledByDefault, true);
});

test("falls back to defaults for unparsable numbers", () => {
  const { env } = isolatedEnv({
    ALHERDR_DIGEST_LINES: "banana",
    ALHERDR_DIGEST_MAX_CHARS: "-5",
    ALHERDR_DEDUPE_SECONDS: "",
  });
  const cfg = loadConfig(env);
  assert.equal(cfg.digestLines, 40);
  assert.equal(cfg.digestMaxChars, 1200);
  // An empty string parses as 0, which is a valid "no dedupe" setting.
  assert.equal(cfg.dedupeSeconds, 0);
});

test("parses dotenv quotes and ignores comments and malformed lines", () => {
  const { env, config } = isolatedEnv();
  writeFileSync(
    join(config, ".env"),
    [
      "# comment",
      'TELEGRAM_BOT_TOKEN="quoted:token"',
      "TELEGRAM_CHAT_ID='123'",
      "ALHERDR_DEDUPE_SECONDS=5",
      "not a valid line",
      "=missing-key",
    ].join("\n"),
  );
  const cfg = loadConfig(env);
  assert.equal(cfg.token, "quoted:token");
  assert.equal(cfg.chatId, "123");
  assert.equal(cfg.dedupeSeconds, 5);
});

test("derives configDir/stateDir/pluginRoot in development runs", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.configDir, cfg.pluginRoot);
  assert.equal(cfg.stateDir, join(cfg.pluginRoot, "state"));
  assert.equal(cfg.herdrBin, "herdr");
});

test("reads ALHERDR_DEBUG_DUMP from env or a dotenv file", () => {
  const { env } = isolatedEnv({ ALHERDR_DEBUG_DUMP: "/tmp/env-events.jsonl" });
  assert.equal(loadConfig(env).debugDump, "/tmp/env-events.jsonl");

  const { env: fileEnv, config } = isolatedEnv();
  writeFileSync(join(config, ".env"), "ALHERDR_DEBUG_DUMP=/tmp/file-events.jsonl\n");
  assert.equal(loadConfig(fileEnv).debugDump, "/tmp/file-events.jsonl");
});

test("prefers HERDR_BIN_PATH over the bare herdr name", () => {
  const { env } = isolatedEnv({ HERDR_BIN_PATH: "/opt/herdr/bin/herdr" });
  assert.equal(loadConfig(env).herdrBin, "/opt/herdr/bin/herdr");
});
