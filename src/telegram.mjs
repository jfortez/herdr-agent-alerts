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
