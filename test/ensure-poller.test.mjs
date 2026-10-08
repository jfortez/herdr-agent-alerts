import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "ensure-poller.sh");
const LOCK_DIR_NAME = "telegram-poller.lock";
// The lock directory, never written by ensure-poller.sh itself.
const LOCK_PID_PATH = [LOCK_DIR_NAME, "pid"];

// Synthetic stub only; the tests never talk to Telegram. It mimics the
// poller's side of the contract: claim the lock, then run. SIGTERM exits 0 so
// the supervisor stops instead of restarting it and leaking past the test.
const STUB_SOURCE = [
  'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  "const lockDir = join(process.env.HERDR_PLUGIN_STATE_DIR, \"telegram-poller.lock\");",
  "mkdirSync(lockDir, { recursive: true });",
  'writeFileSync(join(lockDir, "pid"), `${process.pid}\\n`);',
  "appendFileSync(process.env.STUB_MARKER, `${process.pid}\\n`);",
  'process.on("SIGTERM", () => process.exit(0));',
  "setInterval(() => {}, 60000);",
].join("\n");

const dirs = [];
const spawnedPids = [];

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `alherdr-${label}-`));
  dirs.push(dir);
  return dir;
}

after(async () => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  // Give the stubs a moment to exit before their temp dirs disappear.
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scenario(label) {
  const base = tempDir(label);
  const configDir = join(base, "config");
  const stateDir = join(base, "state");
  const rootDir = join(base, "root");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(rootDir, { recursive: true });
  const stub = join(base, "stub-poller.mjs");
  writeFileSync(stub, STUB_SOURCE);
  return { base, configDir, stateDir, rootDir, stub, marker: join(base, "marker.txt") };
}

function runEnsure({ rootDir, configDir, stateDir, stub, marker, env = {} }) {
  return spawnSync("bash", [SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? tmpdir(),
      HERDR_PLUGIN_ROOT: rootDir,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      ALHERDR_POLLER_NODE: process.execPath,
      ALHERDR_POLLER_ENTRY: stub,
      STUB_MARKER: marker,
      ...env,
    },
    encoding: "utf8",
    timeout: 20000,
  });
}

function readMarker(marker) {
  try {
    return readFileSync(marker, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isSafeInteger(pid));
  } catch {
    return [];
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the stub poller");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("ensure-poller exits without spawning when ALHERDR_TELEGRAM_COMMANDS is off", () => {
  const box = scenario("ensure-off");
  const result = runEnsure({ ...box, env: { ALHERDR_TELEGRAM_COMMANDS: "0" } });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(box.marker));
  assert.ok(!existsSync(join(box.stateDir, LOCK_DIR_NAME)));
});

test("ensure-poller reads the dotenv file, defaults to off there too", () => {
  const box = scenario("ensure-dotenv-off");
  writeFileSync(join(box.configDir, ".env"), "ALHERDR_TELEGRAM_COMMANDS=0\n");
  const result = runEnsure(box);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(box.marker));
  assert.ok(!existsSync(join(box.stateDir, LOCK_DIR_NAME)));
});

test("ensure-poller does not spawn while a live process holds the lock", () => {
  const box = scenario("ensure-live");
  const lockPid = join(box.stateDir, ...LOCK_PID_PATH);
  mkdirSync(join(box.stateDir, LOCK_DIR_NAME), { recursive: true });
  writeFileSync(lockPid, `${process.pid}\n`);

  // The dotenv says on; the live lock must still win.
  writeFileSync(join(box.configDir, ".env"), "ALHERDR_TELEGRAM_COMMANDS=1\n");
  const result = runEnsure(box);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(box.marker));
  assert.equal(readFileSync(lockPid, "utf8").trim(), String(process.pid));
});

test("ensure-poller spawns the supervisor once and the poller records its pid", async () => {
  const box = scenario("ensure-spawn");
  writeFileSync(join(box.configDir, ".env"), "ALHERDR_TELEGRAM_COMMANDS=on\n");

  const first = runEnsure(box);
  assert.equal(first.status, 0, first.stderr);
  await waitFor(() => readMarker(box.marker).length === 1);

  const lockPid = join(box.stateDir, ...LOCK_PID_PATH);
  const firstPids = readMarker(box.marker);
  spawnedPids.push(...firstPids);
  assert.equal(readFileSync(lockPid, "utf8").trim(), String(firstPids[0]));
  assert.ok(isAlive(firstPids[0]), "the detached poller should be alive");
  // The old ensure-owned PID file is gone for good.
  assert.ok(!existsSync(join(box.stateDir, "telegram-poller.pid")));

  // The startup hook runs again on live handoff: it must not start a second poller.
  const second = runEnsure(box);
  assert.equal(second.status, 0, second.stderr);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(readMarker(box.marker), firstPids);
  assert.equal(readFileSync(lockPid, "utf8").trim(), String(firstPids[0]));
});

test("ensure-poller starts despite a stale lock and the poller replaces it", async () => {
  const box = scenario("ensure-stale");
  writeFileSync(join(box.configDir, ".env"), "ALHERDR_TELEGRAM_COMMANDS=1\n");
  mkdirSync(join(box.stateDir, LOCK_DIR_NAME), { recursive: true });

  // A process that has already exited: its PID cannot be recycled this fast.
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  const lockPid = join(box.stateDir, ...LOCK_PID_PATH);
  writeFileSync(lockPid, `${dead.pid}\n`);

  const result = runEnsure(box);
  assert.equal(result.status, 0, result.stderr);
  await waitFor(() => readMarker(box.marker).length === 1);

  const [pid] = readMarker(box.marker);
  spawnedPids.push(pid);
  assert.equal(readFileSync(lockPid, "utf8").trim(), String(pid));
  assert.notEqual(pid, dead.pid);
});
