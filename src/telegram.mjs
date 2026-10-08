export const MAX_MESSAGE_CHARS = 4000;
const SEPARATOR = "────────────";

// Delivery retry policy: three attempts total (the original plus two retries),
// a bounded backoff between them, and a cap on Telegram's 429 retry_after so a
// hostile value cannot stall a Herdr event hook.
const MAX_SEND_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = Object.freeze([400, 1200]);
const MAX_RETRY_AFTER_MS = 5000;

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

/** Tab name for line 3: strip the [N] prefix; drop empty or purely numeric. */
function tabNameOf(location) {
  const raw = firstValue(location.tabLabel);
  if (raw === null) return null;
  const name = stripIndexPrefix(raw).trim();
  if (name === "" || /^\d+$/.test(name)) return null;
  return name;
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

/** Line 3: tab name · ws n · tab n · pane id. */
function addressLine(location, alert) {
  const parts = [];
  const tabName = tabNameOf(location);
  if (tabName !== null) parts.push(tabName);
  if (location.workspaceNumber != null) parts.push(`ws ${location.workspaceNumber}`);
  if (location.tabNumber != null) parts.push(`tab ${location.tabNumber}`);
  const paneId = firstValue(location.paneId, alert.paneId);
  if (paneId) parts.push(paneId);
  return parts.join(" · ");
}

/** Escape the three characters Telegram's HTML parse mode treats as markup. */
export function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeDialog(value) {
  if (!value || typeof value !== "object") return null;
  const question = String(value.question ?? "").trim();
  if (question === "") return null;
  return {
    question,
    preview: String(value.preview ?? "").replace(/\s+$/, ""),
    options: String(value.options ?? "").replace(/\s+$/, ""),
  };
}

function wrapValue(style, value, html) {
  if (style === "static") return value;
  if (!html) return value;
  if (style === "bold") return `<b>${escapeHtml(value)}</b>`;
  if (style === "code") return `<code>${escapeHtml(value)}</code>`;
  if (style === "pre") return `<pre>${escapeHtml(value)}</pre>`;
  // Dynamic untagged values (dialog options) still need entity escaping.
  return escapeHtml(value);
}

/**
 * PURE: render one alert for Telegram. `format: "html"` (default) puts the
 * headline in <b>, the location and address lines in <code>, and the tail
 * digest or dialog preview in <pre>; every dynamic value is HTML-escaped.
 * `format: "text"` is the same message with no tags, used as the delivery
 * fallback when Telegram rejects the HTML entities.
 */
export function renderAlert(alert = {}, { format = "html" } = {}) {
  const html = format === "html";
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
      firstValue(location.tabLabel) !== null ||
      location.workspaceNumber != null ||
      location.tabNumber != null);

  const entries = [{ style: "bold", value: header }];
  if (addressed) {
    const place = placeLine(location, alert);
    if (place) entries.push({ style: "code", value: place });
    const address = addressLine(location, alert);
    if (address) entries.push({ style: "code", value: address });
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
    if (legacy) entries.push({ style: "code", value: legacy });
  }

  const dialog = normalizeDialog(alert.dialog);
  let block = null;
  if (dialog) {
    entries.push({ style: "static", value: SEPARATOR });
    entries.push({ style: "bold", value: dialog.question });
    if (dialog.preview !== "") {
      entries.push({ style: "pre", value: dialog.preview });
      block = entries[entries.length - 1];
    }
    if (dialog.options !== "") entries.push({ style: "plain", value: dialog.options });
  } else {
    const digest = String(alert.digest ?? "").trim();
    if (digest) {
      entries.push({ style: "static", value: SEPARATOR });
      entries.push({ style: "pre", value: digest });
      block = entries[entries.length - 1];
    }
  }

  const render = () =>
    entries.map((entry) => wrapValue(entry.style, entry.value, html)).join("\n");

  let text = render();
  if (text.length > MAX_MESSAGE_CHARS) {
    if (block !== null) {
      const wrapped = wrapValue(block.style, block.value, html);
      const fixed = text.length - wrapped.length;
      const overhead = wrapped.length - block.value.length;
      const room = MAX_MESSAGE_CHARS - fixed - overhead;
      block.value =
        room >= 1 && block.value.length > room
          ? block.value.slice(0, room - 1) + "…"
          : room >= 1
            ? block.value
            : "";
      text = render();
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      text = text.slice(0, MAX_MESSAGE_CHARS - 1) + "…";
    }
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

/** Telegram 400 descriptions that mean the HTML entities could not be parsed. */
const PARSE_ERROR_RE = /can'?t parse|failed to parse|unsupported (?:start|end) tag|parse_mode|entit(?:y|ies)/i;

/**
 * POST one message to Telegram as HTML. A transport failure rejects after at
 * most three attempts; an HTTP error is returned, never thrown, and a 429 or
 * 5xx is retried with bounded backoff. A parse-related 400 degrades to one
 * plain-text resend (no `parse_mode`) so a malformed entity can never silence
 * an alert; a 400 is never retried more than that. `sleepImpl` is injectable
 * so tests do not actually wait.
 */
export async function sendTelegram({
  token,
  chatId,
  text,
  plainText = text,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  disableNotification = false,
}) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const base = {
    chat_id: chatId,
    disable_web_page_preview: true,
    disable_notification: Boolean(disableNotification),
  };

  const sendWithRetries = async (payloadText, parseMode) => {
    const body = JSON.stringify({
      ...base,
      text: payloadText,
      ...(parseMode ? { parse_mode: parseMode } : {}),
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
  };

  const result = await sendWithRetries(text, "HTML");
  if (result.status === 400 && PARSE_ERROR_RE.test(result.description)) {
    // One degradation only: if the plain form is rejected too, return that.
    return sendWithRetries(plainText, null);
  }
  return result;
}
