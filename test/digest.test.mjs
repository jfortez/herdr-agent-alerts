import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractDialog, extractDigest, readPaneDigest } from "../src/digest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(HERE, "fixtures", name), "utf8");

test("strip ANSI and OSC escapes, carriage returns and trailing whitespace", () => {
  const raw = fixture("ansi-pane.txt");
  assert.equal(
    extractDigest(raw, { maxLines: 40, maxChars: 1200 }),
    [
      "ok · build · 40ms",
      "Text with title",
      "progress 100%",
      "bold and end",
    ].join("\n"),
  );
});

test("removes the ▎ gutter and its single following space", () => {
  const raw = " ▎ first\n▎second\n ▎  third";
  assert.equal(extractDigest(raw, {}), "first\nsecond\n third");
});

test("drops telemetry, agent panel, spinner and prompt hint chrome", () => {
  assert.equal(extractDigest(fixture("pure-chrome.txt"), {}), "");
});

test("collapses runs of blank lines and trims leading/trailing blanks", () => {
  const raw = "\n\nalpha\n\n\n\nbeta\n\n";
  assert.equal(extractDigest(raw, {}), "alpha\n\nbeta");
});

test("keeps only the last maxLines meaningful lines, preserving inner blanks", () => {
  assert.equal(extractDigest("one\n\ntwo\n\nthree", { maxLines: 2 }), "two\n\nthree");
  assert.equal(extractDigest("one\ntwo\nthree\nfour\nfive", { maxLines: 2 }), "four\nfive");
});

test("caps at maxChars on a word boundary with a leading ellipsis", () => {
  assert.equal(extractDigest("alpha beta gamma delta", { maxChars: 12 }), "…gamma delta");
  assert.equal(extractDigest("alpha beta gamma delta", { maxChars: 100 }), "alpha beta gamma delta");
  // A single unbreakable token still gets cut to the cap.
  const longToken = "x".repeat(50);
  const capped = extractDigest(longToken, { maxChars: 10 });
  assert.equal(capped.length, 10);
  assert.equal(capped, "…" + "x".repeat(9));
});

test("returns empty string for empty or chrome-only input", () => {
  assert.equal(extractDigest("", {}), "");
  assert.equal(extractDigest(null, {}), "");
  assert.equal(extractDigest(undefined, {}), "");
  assert.equal(extractDigest("   \n\n  \n", {}), "");
});

test("extracts a realistic pi pane end to end", () => {
  const raw = fixture("pi-pane.txt");
  assert.equal(
    extractDigest(raw, { maxLines: 40, maxChars: 1200 }),
    [
      "ok · tool_alpha · 120ms",
      "ok · tool_beta · 80ms",
      "Successfully wrote to src/example.mjs",
      "#2 second task updated",
      "",
      "An assistant sentence wrapped normally without a gutter.",
    ].join("\n"),
  );
});

test("keeps only the main column when the sidebar gutter is mid-line", () => {
  assert.equal(extractDigest("AG Grid #282,       ▎ Project", {}), "AG Grid #282,");
  assert.equal(extractDigest("                    ▎ Project", {}), "");
  assert.equal(extractDigest("                    ▎ Branch feat/x", {}), "");
  // A leading gutter (first two columns) still keeps its following content.
  assert.equal(extractDigest(" ▎ ok · tool · 216ms", {}), "ok · tool · 216ms");
});

test("keeps the main column when a leading gutter and a sidebar gutter share a line", () => {
  // The real live pattern: leading gutter at index 1, sidebar border far right.
  assert.equal(
    extractDigest(" ▎   type, or / for commands          ▎   payload checks", {}),
    "",
  );
  assert.equal(
    extractDigest(" ▎ I need your approval          ▎ ✓ sidebar note", {}),
    "I need your approval",
  );
});

test("drops box-only lines and unboxes bordered content", () => {
  assert.equal(
    extractDigest("╭──────╮\n│\n█\n│ Allow this? │\n╰──────╯", {}),
    "Allow this?",
  );
});

test("drops the extra status glyphs seen in live panes", () => {
  assert.equal(extractDigest("✾ checking…\n❁ checking…\nreal content", {}), "real content");
});

test("extracts a synthetic boxed approval dialog without sidebar or borders", () => {
  const raw = fixture("approval-dialog.txt");
  const digest = extractDigest(raw, { maxLines: 40, maxChars: 1200 });
  assert.equal(
    digest,
    [
      "Allow the agent to edit src/app.mjs?",
      "",
      "❯ Yes, allow",
      "  No, deny",
    ].join("\n"),
  );
  assert.ok(!digest.includes("Project"));
  assert.ok(!digest.includes("Branch"));
  assert.ok(!/[│╭╮╯╰█▎]/.test(digest));
  assert.ok(!/[ ]{3,}/.test(digest));
});

test("extracts the approval dialog end to end and drops the transcript", () => {
  const raw = fixture("blocked-dialog.txt");
  const dialog = extractDialog(raw, { maxLines: 24, maxChars: 1200 });
  assert.deepEqual(dialog, {
    question: "Allow the recursive delete command?",
    preview:
      'setup() { local dir="$1"; rm -rf "$dir"; mkdir -p "$dir"; cd "$dir"; }\n' +
      'printf \'{"name":"sandbox","private":true,"type":"module"}\' > package.json',
    options: "❯ Yes\n  No",
  });
  assert.ok(!dialog.preview.includes("build.mjs"));
  assert.ok(!dialog.preview.includes("sample-explore-agent"));
  assert.ok(!dialog.preview.includes("model-x"));
  assert.ok(!dialog.question.includes("navigate"));
});

test("detects a question whose ? is followed by a trailing parenthetical", () => {
  const raw = [
    "¿Qué problema real tiene que resolver la migración? (define si TSR es la herramienta correcta)",
    "❯ Estado en la URL",
    "  Guardas y carga por ruta",
  ].join("\n");
  assert.deepEqual(extractDialog(raw, {}), {
    question:
      "¿Qué problema real tiene que resolver la migración? (define si TSR es la herramienta correcta)",
    preview: "",
    options: "❯ Estado en la URL\n  Guardas y carga por ruta",
  });
});

test("never mistakes an embedded ? in a command for a question", () => {
  const raw = [
    "curl 'https://example.test/data?a=1' --output result.json",
    "❯ Yes",
    "  No",
  ].join("\n");
  assert.equal(extractDialog(raw, {}), null);
});

test("elides the middle of a long preview and keeps question and options", () => {
  // Six preview lines are within the 8-line question window, but do not fit
  // the six-line budget, so the middle is elided.
  const preview = Array.from({ length: 6 }, (_, index) => `preview line ${index + 1}`);
  const raw = ["Allow the recursive delete?", ...preview, "❯ Yes", "  No"].join("\n");
  const dialog = extractDialog(raw, { maxLines: 6, maxChars: 2000 });
  assert.equal(dialog.question, "Allow the recursive delete?");
  assert.equal(dialog.options, "❯ Yes\n  No");
  const previewLines = dialog.preview.split("\n");
  assert.equal(previewLines.length, 3);
  assert.equal(previewLines[0], "preview line 1");
  assert.equal(previewLines[1], "…");
  assert.equal(previewLines[2], "preview line 6");
});

test("keeps both options when the selected marker is on the second line", () => {
  const raw = ["Proceed with the change?", "  Yes, apply it", "❯ No, keep the file"].join("\n");
  assert.deepEqual(extractDialog(raw, {}), {
    question: "Proceed with the change?",
    preview: "  Yes, apply it",
    options: "❯ No, keep the file",
  });
});

test("returns null when no question/option pair is detectable", () => {
  assert.equal(extractDialog("", {}), null);
  assert.equal(extractDialog("just finished work\nall tests pass", {}), null);
  assert.equal(extractDialog("Was that ok?\nno options below", {}), null);
  assert.equal(extractDialog("❯ Yes\n  No", {}), null);
  const far = [
    "Is this a dialog?",
    ...Array.from({ length: 9 }, (_, index) => `line ${index}`),
    "❯ Yes",
  ].join("\n");
  assert.equal(extractDialog(far, {}), null);
});

test("drops every dialog footer pattern", () => {
  const footers = [
    "↑↓ navigate",
    "↑/↓",
    "navigate",
    "enter select",
    "escape to cancel",
    "esc/ctrl+c cancel",
    "esc cancel",
    "tab to switch",
  ];
  for (const footer of footers) {
    assert.equal(extractDigest(footer, {}), "", `footer not dropped: ${footer}`);
  }
});

test("drops the leaked agent-panel pair but keeps normal prose", () => {
  const raw = [
    "✓ sample-explore-agent  trace routing through the example app",
    "model-x · max · 123k · $0.012 · 2m00s",
    "The report is ready · it cost $0.50 to run.",
    "Final answer: all tests pass.",
  ].join("\n");
  assert.equal(
    extractDigest(raw, {}),
    ["The report is ready · it cost $0.50 to run.", "Final answer: all tests pass."].join("\n"),
  );
});

test("readPaneDigest passes plain pane stdout through as raw text", () => {
  const calls = [];
  const spawnImpl = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return {
      status: 0,
      // Real herdr `agent read` writes raw terminal text, never JSON.
      stdout: " ▎ I need your approval.\n ▎ ✿ waiting for input\n",
      stderr: "",
    };
  };
  const pane = readPaneDigest({
    herdrBin: "/fake/herdr",
    paneId: "p1",
    lines: 10,
    maxChars: 200,
    spawnImpl,
  });
  assert.equal(pane.digest, "I need your approval.");
  assert.equal(pane.dialog, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "/fake/herdr");
  assert.deepEqual(calls[0].args, [
    "agent",
    "read",
    "p1",
    "--source",
    "recent-unwrapped",
    "--lines",
    "10",
  ]);
});

test("readPaneDigest unwraps a JSON { output } envelope if a wrapper returns one", () => {
  const spawnImpl = () => ({
    status: 0,
    stdout: JSON.stringify({ output: " ▎ hello world\n ▎ ✿ waiting for input\n" }),
    stderr: "",
  });
  assert.equal(readPaneDigest({ paneId: "p1", spawnImpl }).digest, "hello world");
});

test("falls back to the visible source when recent-unwrapped fails on a blocked pane", () => {
  const calls = [];
  const spawnImpl = (bin, args) => {
    calls.push(args);
    const source = args[args.indexOf("--source") + 1];
    if (source === "recent-unwrapped") {
      return {
        status: 1,
        stdout: JSON.stringify({ error: { code: "agent_not_idle", message: "agent is not idle" } }),
        stderr: "",
      };
    }
    return {
      status: 0,
      stdout: " │ Allow this change? │\n │ ❯ Yes                  │\n │   No                  │\n",
      stderr: "",
    };
  };
  const pane = readPaneDigest({
    herdrBin: "herdr",
    paneId: "p1",
    lines: 40,
    spawnImpl,
    preferDialog: true,
  });
  assert.deepEqual(pane.dialog, {
    question: "Allow this change?",
    preview: "",
    options: "❯ Yes\n  No",
  });
  assert.equal(pane.digest, "Allow this change?\n❯ Yes\n  No");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("recent-unwrapped"));
  assert.ok(calls[1].includes("visible"));
});

test("an error envelope never reaches the digest, even with exit 0", () => {
  const envelope = JSON.stringify({
    error: { code: "agent_not_idle", message: "agent is not idle" },
  });

  // Envelope on stdout with exit 0.
  assert.deepEqual(
    readPaneDigest({ paneId: "p1", spawnImpl: () => ({ status: 0, stdout: envelope, stderr: "" }) }),
    { digest: "", dialog: null },
  );
  // Envelope on stderr with exit 0.
  assert.deepEqual(
    readPaneDigest({
      paneId: "p1",
      spawnImpl: () => ({ status: 0, stdout: " │ valid text │\n", stderr: envelope }),
    }),
    { digest: "", dialog: null },
  );
  // Envelope with exit 0 on the first source, real text on the second.
  const spawnImpl = (bin, args) => {
    const source = args[args.indexOf("--source") + 1];
    return source === "recent-unwrapped"
      ? { status: 0, stdout: envelope, stderr: "" }
      : { status: 0, stdout: " │ question │\n", stderr: "" };
  };
  const pane = readPaneDigest({ paneId: "p1", spawnImpl });
  assert.equal(pane.digest, "question");
  assert.equal(pane.dialog, null);
  assert.ok(!pane.digest.includes("agent_not_idle"));
});

test("returns an empty result when every read source fails", () => {
  const calls = [];
  const spawnImpl = (bin, args) => {
    calls.push(args);
    return { status: 1, stdout: "", stderr: "no such pane" };
  };
  assert.deepEqual(readPaneDigest({ herdrBin: "herdr", paneId: "p1", spawnImpl }), {
    digest: "",
    dialog: null,
  });
  assert.equal(calls.length, 2);
});

test("readPaneDigest returns an empty result on genuine failures", () => {
  const failureModes = [
    () => ({ status: 1, stdout: "", stderr: "no such pane" }),
    () => ({ error: new Error("ENOENT"), status: null, stdout: "" }),
    () => {
      throw new Error("spawn exploded");
    },
  ];
  for (const spawnImpl of failureModes) {
    assert.deepEqual(readPaneDigest({ herdrBin: "herdr", paneId: "p1", spawnImpl }), {
      digest: "",
      dialog: null,
    });
  }
  assert.deepEqual(readPaneDigest({ paneId: "" }), { digest: "", dialog: null });
});
