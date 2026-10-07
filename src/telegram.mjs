export const MAX_MESSAGE_CHARS = 4000;
export const SEPARATOR = "────────────";

// Delivery retry policy: three attempts total (the original plus two retries),
// a bounded backoff between them, and a cap on Telegram's 429 retry_after so a
// hostile value cannot stall a Herdr event hook.
export const MAX_SEND_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = Object.freeze([400, 1200]);
export const MAX_RETRY_AFTER_MS = 5000;

const HEADLINES = {
  blocked: "needs your answer",
  done: "finished",
  released: "left the pane",
  exited: "process exited",
};

const EMOJIS = {
  blocked: "🙋",
  done: "✅",
  released: "👋",
  exited: "🏁",
};

function firstValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text !== "") return text;
  }
  return null;
}

function stripIndexPrefix(label) {
  return String(label).replace(/^\[\d+\]\s*/, "");
}

/** Line 2: repo · branch · worktree k/n, or the workspace label, or a fallback. */
function placeLine(location, alert) {
  const parts = [];
  if (firstValue(location.repoName)) {
    parts.push(String(location.repoName));
    if (firstValue(location.branch)) parts.push(String(location.branch));
    if (Number(location.worktreeTotal) > 1 && location.worktreeIndex != null) {
      parts.push(`worktree ${location.worktreeIndex}/${location.worktreeTotal}`);
    }
  } else if (firstValue(location.workspaceLabel)) {
    parts.push(stripIndexPrefix(location.workspaceLabel));
  } else {
    const fallback = firstValue(alert.title, alert.workspaceId, alert.tabId);
    if (fallback) parts.push(fallback);
  }
  return parts.join(" · ");
}

/** Line 3: ws n · tab n · pane id. */
function addressLine(location, alert) {
  const parts = [];
  if (location.workspaceNumber != null) parts.push(`ws ${location.workspaceNumber}`);
  if (location.tabNumber != null) parts.push(`tab ${location.tabNumber}`);
  const paneId = firstValue(location.paneId, alert.paneId);
  if (paneId) parts.push(paneId);
  return parts.join(" · ");
}

/** PURE: render one alert into the plain-text Telegram message. */
export function renderAlert(alert = {}) {
  const kind = String(alert.kind ?? "");
  const emoji = EMOJIS[kind] ?? "🔔";
  const headline = HEADLINES[kind] ?? "changed state";
  const agent = firstValue(alert.displayAgent, alert.agent);

  const header = [emoji, agent, headline].filter(Boolean).join(" ");

  const location =
    alert.location && typeof alert.location === "object" ? alert.location : null;
  const addressed =
    location !== null &&
    (firstValue(location.repoName) !== null ||
      firstValue(location.workspaceLabel) !== null ||
      location.workspaceNumber != null ||
      location.tabNumber != null);

  const parts = [header];
  if (addressed) {
    const place = placeLine(location, alert);
    if (place) parts.push(place);
    const address = addressLine(location, alert);
    if (address) parts.push(address);
  } else {
    // No resolved location (missing snapshot, dead pane, legacy caller): keep
    // the single agent · title · pane line the alert had before topology.
    const legacy = [
      firstValue(alert.displayAgent, alert.agent),
      firstValue(alert.title, alert.workspaceId, alert.tabId),
      firstValue(alert.paneId),
    ]
      .filter(Boolean)
      .join(" · ");
    if (legacy) parts.push(legacy);
  }

  const digest = String(alert.digest ?? "").trim();
  if (digest) {
    parts.push(SEPARATOR);
    parts.push(digest);
  }

  let text = parts.join("\n");
  if (text.length > MAX_MESSAGE_CHARS) {
    text = text.slice(0, MAX_MESSAGE_CHARS - 1) + "…";
  }
  return text;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait before the next attempt: retry_after when Telegram sent one, capped. */
function retryDelayMs(attempt, payload) {
  const retryAfter = Number(payload?.parameters?.retry_after);
  if (Number.isFinite(retryAfter)) {
    return Math.min(Math.max(retryAfter, 0) * 1000, MAX_RETRY_AFTER_MS);
  }
  return RETRY_BACKOFF_MS[attempt - 1];
}

/**
 * POST one plain-text message to Telegram. A transport failure rejects after
 * at most three attempts; an HTTP error is returned, never thrown, and a 429
 * or 5xx is retried with bounded backoff. `sleepImpl` is injectable so tests
 * do not actually wait, and `disableNotification` becomes Telegram's
 * `disable_notification` flag.
 */
export async function sendTelegram({
  token,
  chatId,
  text,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  disableNotification = false,
}) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    disable_notification: Boolean(disableNotification),
  });

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      // A transport rejection is transient; the last one propagates to the
      // caller exactly as before.
      if (attempt >= MAX_SEND_ATTEMPTS) throw err;
      await sleepImpl(RETRY_BACKOFF_MS[attempt - 1]);
      continue;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const result = {
      ok: payload?.ok === true,
      status: response.status,
      description: payload?.description ?? "",
    };

    const retryable = result.status === 429 || result.status >= 500;
    if (result.ok || !retryable || attempt >= MAX_SEND_ATTEMPTS) return result;

    await sleepImpl(retryDelayMs(attempt, payload));
  }

  // Unreachable: every loop iteration either returns or throws by attempt 3.
  throw new Error("sendTelegram ended without a result");
}
