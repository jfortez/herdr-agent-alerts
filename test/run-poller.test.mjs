import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPERVISOR = join(REPO_ROOT, "scripts", "run-poller.sh");
const ENSURE = join(REPO_ROOT, "scripts", "ensure-poller.sh");

// Synthetic commands only: no test ever starts a real poller.

const dirs = [];
const running = [];

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `alherdr-${label}-`));
  dirs.push(dir);
  return dir;
}

after(async () => {
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function supervisorEnv(env = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    ...env,
  };
}

function spawnSupervisor(args, env = {}) {
  const child = spawn("bash", [SUPERVISOR, ...args], {
    env: supervisorEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  return child;
}

function exitCode(child, timeoutMs = 8000) {
  return new Promise((resolvePromise, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise(child.exitCode);
      return;
    }
    const timer = setTimeout(() => reject(new Error("supervisor did not exit in time")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

function readPidFile(file) {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
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

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the supervisor");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function countLines(file) {
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}

test("both poller scripts parse under bash", () => {
  for (const script of [SUPERVISOR, ENSURE]) {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test("supervisor exits 0 when its child exits 0", () => {
  const result = spawnSync("bash", [SUPERVISOR, process.execPath, "-e", "process.exit(0)"], {
    env: supervisorEnv(),
    encoding: "utf8",
    timeout: 10000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(!/restarting/.test(result.stdout), result.stdout);
});

test("supervisor restarts a child that exits non-zero, then stops on TERM", async () => {
  const dir = tempDir("supervisor-restart");
  const marker = join(dir, "marker.txt");
  const child = spawnSupervisor(
    [
      process.execPath,
      "-e",
      "require('node:fs').appendFileSync(process.env.STUB_MARKER, 'restart\\n'); process.exit(3);",
    ],
    { STUB_MARKER: marker, ALHERDR_POLLER_RESTART_DELAY: "0" },
  );
  let stdout = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });

  await waitFor(() => countLines(marker) >= 2);
  child.kill("SIGTERM");
  const code = await exitCode(child);

  assert.equal(code, 0);
  assert.match(stdout, /poller exited 3; restarting in 0s/);
});

test("supervisor TERM kills its child and exits 0", async () => {
  const dir = tempDir("supervisor-term");
  const pidFile = join(dir, "child.pid");
  const child = spawnSupervisor(
    [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.env.STUB_PIDFILE, String(process.pid)); setInterval(() => {}, 1000);",
    ],
    { STUB_PIDFILE: pidFile },
  );

  await waitFor(() => readPidFile(pidFile) !== null);
  const pollerPid = readPidFile(pidFile);
  assert.ok(pollerPid !== null && isAlive(pollerPid));

  child.kill("SIGTERM");
  const code = await exitCode(child);

  assert.equal(code, 0);
  await waitFor(() => !isAlive(pollerPid));
});
