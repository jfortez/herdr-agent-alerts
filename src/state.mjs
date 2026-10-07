import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseBoolean } from "./config.mjs";

const PRUNE_MS = 24 * 60 * 60 * 1000;

function enabledFile(cfg) {
  return join(cfg.stateDir, "enabled");
}

function alertsFile(cfg) {
  return join(cfg.stateDir, "last-alerts.json");
}

function ensureStateDir(cfg) {
  mkdirSync(cfg.stateDir, { recursive: true });
}

/** Missing or unreadable enabled file falls back to `cfg.enabledByDefault`. */
export function isEnabled(cfg) {
  let raw;
  try {
    raw = readFileSync(enabledFile(cfg), "utf8");
  } catch {
    return Boolean(cfg.enabledByDefault);
  }
  const parsed = parseBoolean(raw, null);
  return parsed === null ? Boolean(cfg.enabledByDefault) : parsed;
}

export function setEnabled(cfg, value) {
  ensureStateDir(cfg);
  writeFileSync(enabledFile(cfg), value ? "1" : "0");
  return Boolean(value);
}

function readAlertStore(cfg) {
  try {
    const parsed = JSON.parse(readFileSync(alertsFile(cfg), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    // Corrupt or missing state must fail open: notify rather than crash.
    return {};
  }
}

function writeAlertStore(cfg, store) {
  try {
    ensureStateDir(cfg);
    writeFileSync(alertsFile(cfg), JSON.stringify(store));
  } catch (err) {
    // A read-only state dir must not stop an alert from being delivered.
    console.error(`[alherdr] could not save alert state: ${err?.message ?? err}`);
  }
}

/**
 * True when `key` has not alerted within `cfg.dedupeSeconds`. The decision is
 * recorded so a repeat inside the window is suppressed. Corrupt state fails
 * open (returns true).
 */
export function shouldNotify(cfg, key, now = Date.now()) {
  const store = readAlertStore(cfg);
  const windowMs = Math.max(0, Number(cfg?.dedupeSeconds) || 0) * 1000;
  const last = Object.hasOwn(store, key) ? Number(store[key]) : 0;

  if (windowMs > 0 && Number.isFinite(last) && last > 0 && now - last < windowMs) {
    return false;
  }

  const cutoff = now - Math.max(PRUNE_MS, windowMs * 10);
  for (const [entryKey, entryValue] of Object.entries(store)) {
    if (!Number.isFinite(Number(entryValue)) || Number(entryValue) < cutoff) delete store[entryKey];
  }
  store[key] = now;
  writeAlertStore(cfg, store);
  return true;
}

/** Snapshot for the actions entrypoint. */
export function readState(cfg) {
  return {
    enabled: isEnabled(cfg),
    lastAlerts: readAlertStore(cfg),
    stateDir: cfg.stateDir,
  };
}
