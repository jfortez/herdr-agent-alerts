export const MAX_MESSAGE_CHARS = 4000;
export const SEPARATOR = "────────────";

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

/** PURE: render one alert into the plain-text Telegram message. */
export function renderAlert(alert = {}) {
  const kind = String(alert.kind ?? "");
  const emoji = EMOJIS[kind] ?? "🔔";
  const headline = HEADLINES[kind] ?? "changed state";
  const agent = firstValue(alert.displayAgent, alert.agent);

  const header = [emoji, agent, headline].filter(Boolean).join(" ");
  const location = [
    firstValue(alert.displayAgent, alert.agent),
    firstValue(alert.title, alert.workspaceId, alert.tabId),
    firstValue(alert.paneId),
  ]
    .filter(Boolean)
    .join(" · ");

  const digest = String(alert.digest ?? "").trim();
  const parts = [header];
  if (location) parts.push(location);
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

/**
 * POST one plain-text message to Telegram. Never throws on an HTTP error;
 * only a transport failure rejects, and the caller contains it.
 */
export async function sendTelegram({ token, chatId, text, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(15000),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return {
    ok: body?.ok === true,
    status: response.status,
    description: body?.description ?? "",
  };
}
