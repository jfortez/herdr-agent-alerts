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
const PID_FILE_NAME = "telegram-poller.pid";

// Synthetic stub only; the tests never talk to Telegram.

const STUB_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "appendFileSync(process.env.STUB_MARKER, `${process.pid}\\n`);",
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
  assert.ok(!existsSync(join(box.stateDir, PID_FILE_NAME)));
});

test("ensure-poller reads the dotenv file, defaults to off there too", () => {
  const box = scenario("ensure-dotenv-off");
  writeFileSync(join(box.configDir, ".env"), "ALHERDR_TELEGRAM_COMMANDS=0\n");
  const result = runEnsure(box);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(box.marker));
  assert.ok(!existsSync(join(box.stateDir, PID_FILE_NAME)));
});

test("ensure-poller does not spawn while a live process holds the PID file", () => {
  const box = scenario("ensure-live");
  mkdirSync(box.stateDir, { recursive: true });
  const pidFile = join(box.stateDir, PID_FILE_NAME);
  writeFileSync(pidFile, `${process.pid}\n`);

  // The dotenv says on; the live PID file must still win.
  writeFileSync(join(box.configDir, ".env"), "ALHERDR_TELEGRAM_COMMANDS=1\n");
  const result = runEnsure(box);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(box.marker));
  assert.equal(readFileSync(pidFile, "utf8").trim(), String(process.pid));
});

test("ensure-poller spawns a detached poller once and records its PID", async () => {
  const box = scenario("ensure-spawn");
  writeFileSync(join(box.configDir, ".env"), "ALHERDR_TELEGRAM_COMMANDS=on\n");

  const first = runEnsure(box);
  assert.equal(first.status, 0, first.stderr);
  await waitFor(() => readMarker(box.marker).length === 1);

  const pidFile = join(box.stateDir, PID_FILE_NAME);
  const firstPids = readMarker(box.marker);
  spawnedPids.push(...firstPids);
  assert.equal(readFileSync(pidFile, "utf8").trim(), String(firstPids[0]));
  assert.ok(isAlive(firstPids[0]), "the detached poller should be alive");

  // The startup hook runs again on live handoff: it must not start a second poller.
  const second = runEnsure(box);
  assert.equal(second.status, 0, second.stderr);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(readMarker(box.marker), firstPids);
  assert.equal(readFileSync(pidFile, "utf8").trim(), String(firstPids[0]));
});

test("ensure-poller replaces a stale PID file and records the new process", async () => {
  const box = scenario("ensure-stale");
  writeFileSync(join(box.configDir, ".env"), "ALHERDR_TELEGRAM_COMMANDS=1\n");
  mkdirSync(box.stateDir, { recursive: true });

  // A process that has already exited: its PID cannot be recycled this fast.
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  const pidFile = join(box.stateDir, PID_FILE_NAME);
  writeFileSync(pidFile, `${dead.pid}\n`);

  const result = runEnsure(box);
  assert.equal(result.status, 0, result.stderr);
  await waitFor(() => readMarker(box.marker).length === 1);

  const [pid] = readMarker(box.marker);
  spawnedPids.push(pid);
  assert.equal(readFileSync(pidFile, "utf8").trim(), String(pid));
  assert.notEqual(pid, dead.pid);
});
