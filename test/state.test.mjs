import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { isEnabled, readState, setEnabled, shouldNotify } from "../src/state.mjs";

const dirs = [];
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `alherdr-${label}-`));
  dirs.push(dir);
  return dir;
}
function makeCfg(overrides = {}) {
  return { stateDir: tempDir("state"), enabledByDefault: true, dedupeSeconds: 30, ...overrides };
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a missing enabled file means the default applies", () => {
  assert.equal(isEnabled(makeCfg()), true);
  assert.equal(isEnabled(makeCfg({ enabledByDefault: false })), false);
});

test("setEnabled overrides the default and round-trips", () => {
  const cfg = makeCfg({ enabledByDefault: false });
  setEnabled(cfg, true);
  assert.equal(isEnabled(cfg), true);
  assert.equal(readFileSync(join(cfg.stateDir, "enabled"), "utf8"), "1");

  setEnabled(cfg, false);
  assert.equal(isEnabled(cfg), false);
  assert.equal(readFileSync(join(cfg.stateDir, "enabled"), "utf8"), "0");
});

test("a corrupt enabled file falls back to the default", () => {
  const cfg = makeCfg({ enabledByDefault: true });
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(join(cfg.stateDir, "enabled"), "banana");
  assert.equal(isEnabled(cfg), true);
});

test("dedupe suppresses a repeat inside the window and allows it after", () => {
  const cfg = makeCfg({ dedupeSeconds: 30 });
  const t0 = 1_700_000_000_000;
  assert.equal(shouldNotify(cfg, "p1|blocked", t0), true);
  assert.equal(shouldNotify(cfg, "p1|blocked", t0 + 1000), false);
  assert.equal(shouldNotify(cfg, "p1|blocked", t0 + 29_999), false);
  assert.equal(shouldNotify(cfg, "p1|blocked", t0 + 30_000), true);
});

test("dedupe keys are independent", () => {
  const cfg = makeCfg({ dedupeSeconds: 60 });
  const t0 = 1_700_000_000_000;
  assert.equal(shouldNotify(cfg, "p1|blocked", t0), true);
  assert.equal(shouldNotify(cfg, "p1|done", t0), true);
  assert.equal(shouldNotify(cfg, "p2|blocked", t0), true);
  assert.equal(shouldNotify(cfg, "p1|blocked", t0 + 1), false);
});

test("dedupeSeconds 0 disables suppression", () => {
  const cfg = makeCfg({ dedupeSeconds: 0 });
  assert.equal(shouldNotify(cfg, "k", 1000), true);
  assert.equal(shouldNotify(cfg, "k", 1000), true);
});

test("corrupt dedupe state fails open and is rewritten", () => {
  const cfg = makeCfg();
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(join(cfg.stateDir, "last-alerts.json"), "{not json");
  assert.equal(shouldNotify(cfg, "p1|blocked", 1000), true);
  const store = JSON.parse(readFileSync(join(cfg.stateDir, "last-alerts.json"), "utf8"));
  assert.equal(store["p1|blocked"], 1000);
});

test("readState reports the enabled flag and the state dir", () => {
  const cfg = makeCfg();
  setEnabled(cfg, false);
  shouldNotify(cfg, "p1|done", 5000);
  const snapshot = readState(cfg);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.stateDir, cfg.stateDir);
});
