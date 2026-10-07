import { spawnSync } from "node:child_process";

// ANSI/OSC escape removal. Order matters: OSC first, then CSI, then the
// two-character escapes. Everything else in the stream is plain text.
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const TWO_CHAR_ESCAPE_RE = /\u001b[@-Z\\-_]/g;

// The agent sidebar gutter drawn by the TUI, plus one optional following space.
const GUTTER_CHAR = "\u258e";
const GUTTER_RE = /^\s*\u258e ?/;

// Box-drawing (U+2500-U+257F) and block elements (U+2580-U+259F) the TUI uses
// for borders, separators and badges. A line made only of these is chrome.
const BOX_ONLY_RE = /^[\u2500-\u257F\u2580-\u259F]+$/;

// One border character (plus its padding space) on either side wraps boxed
// dialogs: "│ Allow this? │" reads as "Allow this?".
const BOX_BORDER_CHARS = "│║┃▏▕╭╮╯╰├┤┬┴┼┌┐└┘█";
const LEADING_BORDER_RE = new RegExp(`^\\s*[${BOX_BORDER_CHARS}] ?`);
const TRAILING_BORDER_RE = new RegExp(` ?[${BOX_BORDER_CHARS}]$`);

// Spinner / activity glyphs used by the agent panel and status rows. The
// check/status marks below are how the panel prefixes an agent row.
const GLYPH = "◐◑◒◓◜◝◞◟⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏❀✿✾❁✻✽✶✷✸✹✺✳✢⋆✓✔✗✘●○◉◆◇▪▫⊘";
const GLYPH_LINE_RE = new RegExp(`^\\s*[${GLYPH}](?:\\s|$)`);
const SPINNER_RE = new RegExp(`^\\s*[${GLYPH}]+\\s*$`);

// Telemetry footer: "TPS 41.6 tok/s. out 5.914, in 131.493, ...".
const TELEMETRY_RE = /(?:^|\s)(?:TPS\s*[\d.]+|\d+(?:\.\d+)?\s*tok\/s)/i;

// Bare status phrases the agent panel prints around the input prompt.
const STATUS_PHRASE_RE = /^(?:✿\s*)?waiting for input$|^type, or \/ for commands$|^esc to interrupt$/i;

// Dialog footer hints: "↑↓ navigate  enter select  escape/ctrl+c cancel".
// Case-sensitive on purpose: "Navigate the tree" in prose is not a footer.
const FOOTER_RE = /(?:↑↓|↑\/↓)|\bnavigate\b|\benter select\b|\besc(?:ape)?(?:\/ctrl\+c)?(?: to)? cancel\b|\btab to switch\b/;

// Agent-panel model/cost row: "model-x · max · 123k · $0.012 · 2m00s".
// Only a middle-dot separated line with a reasoning-effort word, a currency
// field or a token count is chrome; ordinary prose is left alone.
const EFFORT_FIELD_RE = /^(?:max|min|low|medium|high)$/;
const CURRENCY_FIELD_RE = /^[$€£]\s?\d/;
const TOKEN_COUNT_FIELD_RE = /^\d+(?:\.\d+)?[kKmM]$/;
function isModelRow(line) {
  const fields = line
    .split("·")
    .map((field) => field.trim())
    .filter(Boolean);
  if (fields.length < 2) return false;
  return fields.some(
    (field) =>
      EFFORT_FIELD_RE.test(field) ||
      CURRENCY_FIELD_RE.test(field) ||
      TOKEN_COUNT_FIELD_RE.test(field),
  );
}

// Box-drawing rules and similar full-width separators.
const RULE_RE = /^[─━═╌┄┈]{3,}$/;

function stripEscapes(line) {
  return line
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(TWO_CHAR_ESCAPE_RE, "");
}

function cleanLine(line) {
  // A carriage return means the terminal overwrote the line prefix; the
  // visible content is the last non-empty segment.
  const visible = String(line)
    .split("\r")
    .filter((part) => part !== "")
    .pop() ?? "";

  let text = stripEscapes(visible);

  // Split layouts draw a sidebar gutter at a column past the leading padding.
  // Keep only the main column: handle the regular leading gutter first, then
  // truncate at any later gutter (the sidebar border). A line whose left side
  // is only whitespace becomes empty and is dropped by the blank collapse.
  const firstGutter = text.indexOf(GUTTER_CHAR);
  if (firstGutter === 0 || firstGutter === 1) {
    text = text.replace(GUTTER_RE, "");
    const sidebarGutter = text.indexOf(GUTTER_CHAR);
    if (sidebarGutter !== -1) text = text.slice(0, sidebarGutter);
  } else if (firstGutter > 1) {
    text = text.slice(0, firstGutter);
  }

  text = text.replace(GUTTER_RE, "");

  // Boxed dialogs: strip one border character (and one padding space) on each
  // side so a bordered question reads as plain text.
  text = text.replace(LEADING_BORDER_RE, "");
  text = text.replace(/[ \t]+$/, "");
  text = text.replace(TRAILING_BORDER_RE, "");

  return text.replace(/[ \t]+$/, "");
}

function isChrome(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (BOX_ONLY_RE.test(trimmed)) return true;
  if (TELEMETRY_RE.test(trimmed)) return true;
  if (GLYPH_LINE_RE.test(trimmed)) return true;
  if (SPINNER_RE.test(trimmed)) return true;
  if (STATUS_PHRASE_RE.test(trimmed)) return true;
  if (FOOTER_RE.test(trimmed)) return true;
  if (isModelRow(trimmed)) return true;
  if (RULE_RE.test(trimmed)) return true;
  return false;
}

/** Clean every pane line and drop TUI chrome; blank lines are preserved. */
function cleanLines(rawOutput) {
  const raw = rawOutput == null ? "" : String(rawOutput);
  const cleaned = [];
  for (const line of raw.split("\n")) {
    const clean = cleanLine(line);
    if (isChrome(clean)) continue;
    cleaned.push(clean);
  }
  return cleaned;
}

/** Collapse runs of blank lines into one and trim leading/trailing blanks. */
function collapseBlanks(lines) {
  const collapsed = [];
  for (const line of lines) {
    const blank = line.trim() === "";
    if (blank && collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === "") continue;
    collapsed.push(blank ? "" : line);
  }
  while (collapsed.length > 0 && collapsed[0].trim() === "") collapsed.shift();
  while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === "") collapsed.pop();
  return collapsed;
}

/**
 * Turn raw terminal output from an agent pane into a short, human-readable
 * digest: no escapes, no TUI chrome, no runs of blank lines, the last
 * `maxLines` meaningful lines, capped at `maxChars` on a word boundary
 * (truncation is marked with a leading ellipsis).
 */
export function extractDigest(rawOutput, { maxLines = 40, maxChars = 1200 } = {}) {
  const raw = rawOutput == null ? "" : String(rawOutput);
  if (!raw) return "";

  const limit = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : Infinity;
  if (limit === 0) return "";

  const collapsed = collapseBlanks(cleanLines(raw));
  if (collapsed.length === 0) return "";

  // Keep the last `maxLines` meaningful (non-blank) lines. Blanks inside the
  // kept window are preserved, they just do not count toward the limit.
  let lines = collapsed;
  const meaningful = collapsed.reduce((acc, line, index) => {
    if (line.trim() !== "") acc.push(index);
    return acc;
  }, []);
  if (meaningful.length > limit) {
    lines = collapsed.slice(meaningful[meaningful.length - limit]);
    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  }

  let text = lines.join("\n");

  const cap = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (cap === 0) return "";
  if (text.length > cap) {
    if (cap === 1) return "…";
    const cut = text.length - (cap - 1);
    let tail = text.slice(cut);
    // Drop the partial word the cut landed in, unless the whole tail is one
    // unbreakable token.
    if (cut > 0 && !/\s/.test(text[cut - 1])) {
      const firstSpace = tail.search(/\s/);
      if (firstSpace !== -1) tail = tail.slice(firstSpace + 1);
    }
    text = "…" + tail.trimStart();
    if (text.length > cap) text = text.slice(0, cap);
  }
  return text;
}

const DIALOG_MARKER = "❯";
const DIALOG_QUESTION_WINDOW = 8;
const DIALOG_MAX_OPTIONS = 6;
const ELISION = "…";

// A question line: its final `?` is followed only by optional whitespace and an
// optional trailing parenthetical. An embedded `?` (a URL or a shell command)
// must never match.
const DIALOG_QUESTION_RE = /\?(\s*\([^)]*\))?\s*$/;

/** Keep the head and tail of a line block, replacing the middle with an ellipsis. */
function elideLines(lines, budget) {
  if (lines.length === 0) return [];
  if (lines.length <= budget) return lines;
  if (budget <= 1) return [ELISION];
  const keep = budget - 1;
  const headCount = Math.ceil(keep / 2);
  const tailCount = keep - headCount;
  return [...lines.slice(0, headCount), ELISION, ...lines.slice(lines.length - tailCount)];
}

/** Keep the head and tail of a text run, cutting on word boundaries. */
function elideMiddleChars(text, budget) {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;
  if (budget === 1) return ELISION;
  const keep = budget - 1;
  const headChars = Math.ceil(keep / 2);
  const tailChars = keep - headChars;
  let head = text.slice(0, headChars);
  let tail = text.slice(text.length - tailChars);
  const headCut = head.search(/\s\S*$/);
  if (headCut !== -1) head = head.slice(0, headCut);
  const tailCut = tail.match(/^\S*\s/);
  if (tailCut !== null) tail = tail.slice(tailCut[0].length);
  const out = `${head.trimEnd()}${ELISION}${tail.trimStart()}`;
  return out.length <= budget ? out : out.slice(0, budget);
}

/**
 * PURE: pull the approval dialog out of a blocked pane. Returns
 * `{ question, preview, options }` or null when no dialog is detectable.
 * Reuses the same line cleaning and chrome filtering as extractDigest.
 */
export function extractDialog(rawOutput, { maxLines = 40, maxChars = 1200 } = {}) {
  const lines = cleanLines(rawOutput);
  if (lines.length === 0) return null;

  const trimmed = lines.map((line) => line.trim());

  // Question: the LAST question line that has an option marker within the
  // next 8 lines. The marker is the first one after that question.
  let questionIndex = -1;
  let optionsStart = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!DIALOG_QUESTION_RE.test(trimmed[index])) continue;
    const windowEnd = Math.min(index + DIALOG_QUESTION_WINDOW, lines.length - 1);
    for (let after = index + 1; after <= windowEnd; after += 1) {
      if (trimmed[after].startsWith(DIALOG_MARKER)) {
        questionIndex = index;
        optionsStart = after;
        break;
      }
    }
    if (questionIndex !== -1) break;
  }
  if (questionIndex === -1) return null;

  // Options: the marker line plus consecutive non-blank lines, capped. Chrome
  // and footer lines are already filtered out, so a blank line ends the block.
  const options = [];
  for (
    let index = optionsStart;
    index < lines.length && options.length < DIALOG_MAX_OPTIONS;
    index += 1
  ) {
    if (trimmed[index] === "") break;
    options.push(lines[index].trimEnd());
  }
  if (options.length === 0) return null;

  const question = lines[questionIndex].trimEnd();
  const previewLines = collapseBlanks(lines.slice(questionIndex + 1, optionsStart));

  // Assemble under maxLines; question and options always survive, the preview
  // middle is elided and marked.
  const limit = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : Infinity;
  const available = limit - 1 - options.length;
  const selectedPreview =
    previewLines.length <= available ? previewLines : elideLines(previewLines, available);

  let preview = selectedPreview.join("\n");
  const optionsText = options.join("\n");

  const cap = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (cap > 0) {
    const separators = preview === "" ? 1 : 2;
    const total = question.length + preview.length + optionsText.length + separators;
    if (total > cap) {
      const budget = cap - question.length - optionsText.length - separators;
      preview = budget > 0 ? elideMiddleChars(preview, budget) : "";
    }
  }

  return { question, preview, options: optionsText };
}

/**
 * `herdr agent read` writes raw terminal text to stdout (verified against
 * Herdr 0.9.1), so stdout is the digest source. Narrow insurance only: if a
 * future wrapper returns a JSON envelope whose `output` property is a string,
 * unwrap that exact shape; otherwise pass stdout through untouched.
 */
function unwrapPaneOutput(stdout) {
  const text = String(stdout);
  if (text.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.output === "string") {
        return parsed.output;
      }
    } catch {
      // Not JSON: the raw terminal text is the payload.
    }
  }
  return text;
}

// A blocked agent rejects `recent-unwrapped`; `visible` still works there.
const READ_SOURCES = ["recent-unwrapped", "visible"];

/**
 * Herdr reports some failures as a JSON envelope on stdout or stderr, e.g.
 * {"error":{"code":"agent_not_idle",...}}. Such a payload is a failed read
 * and must never reach the digest.
 */
function parseErrorEnvelope(text) {
  if (typeof text !== "string") return null;
  if (!text.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.error &&
      typeof parsed.error === "object"
    ) {
      const code = typeof parsed.error.code === "string" ? parsed.error.code : "";
      const message = typeof parsed.error.message === "string" ? parsed.error.message : "";
      return [code, message].filter(Boolean).join(": ") || "error envelope";
    }
  } catch {
    // Not JSON: the raw text is the payload.
  }
  return null;
}

function runPaneRead({ herdrBin, paneId, source, lines, spawnImpl, timeoutMs }) {
  const result = spawnImpl(
    herdrBin,
    ["agent", "read", String(paneId), "--source", source, "--lines", String(lines)],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result?.error) {
    return { ok: false, reason: result.error.message ?? String(result.error) };
  }

  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";

  const envelope = parseErrorEnvelope(stdout) ?? parseErrorEnvelope(stderr);
  if (envelope) return { ok: false, reason: envelope };

  if (!result || result.status !== 0) {
    const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : "";
    return { ok: false, reason: `exit ${result?.status ?? "unknown"}${detail}` };
  }
  return { ok: true, stdout };
}

/**
 * Impure edge: read the pane through the herdr binary and extract the tail
 * digest plus, when `preferDialog`, the structured approval dialog. Tries
 * `recent-unwrapped` first and falls back to `visible` (a blocked pane rejects
 * the former). Returns `{ digest: "", dialog: null }` only after every source
 * fails, so an event hook never fails because a pane is gone.
 */
export function readPaneDigest({
  herdrBin = "herdr",
  paneId,
  lines = 40,
  maxChars = 1200,
  spawnImpl = spawnSync,
  timeoutMs = 8000,
  preferDialog = false,
} = {}) {
  if (!paneId) return { digest: "", dialog: null };

  const failures = [];
  for (const source of READ_SOURCES) {
    let read;
    try {
      read = runPaneRead({ herdrBin, paneId, source, lines, spawnImpl, timeoutMs });
    } catch (err) {
      failures.push(`${source} (${err?.message ?? err})`);
      continue;
    }

    if (!read.ok) {
      failures.push(`${source} (${read.reason})`);
      continue;
    }

    const raw = unwrapPaneOutput(read.stdout);
    const digestOptions = { maxLines: lines, maxChars };
    const digest = extractDigest(raw, digestOptions);
    if (preferDialog) {
      const dialog = extractDialog(raw, digestOptions);
      if (dialog !== null) return { digest, dialog };
    }
    if (digest !== "") return { digest, dialog: null };
    // A successful read that only carried chrome does not stop the fallback.
  }

  if (failures.length > 0) {
    console.error(
      `[alherdr] could not extract a digest from pane ${paneId}; failed sources: ${failures.join(", ")}`,
    );
  }
  return { digest: "", dialog: null };
}
