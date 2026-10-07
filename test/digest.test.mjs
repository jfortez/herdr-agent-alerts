import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractDigest, readPaneDigest } from "../src/digest.mjs";

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
  const digest = readPaneDigest({
    herdrBin: "/fake/herdr",
    paneId: "p1",
    lines: 10,
    maxChars: 200,
    spawnImpl,
  });
  assert.equal(digest, "I need your approval.");
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
  assert.equal(readPaneDigest({ paneId: "p1", spawnImpl }), "hello world");
});

test("readPaneDigest returns empty string on genuine failures", () => {
  const failureModes = [
    () => ({ status: 1, stdout: "", stderr: "no such pane" }),
    () => ({ error: new Error("ENOENT"), status: null, stdout: "" }),
    () => {
      throw new Error("spawn exploded");
    },
  ];
  for (const spawnImpl of failureModes) {
    assert.equal(readPaneDigest({ herdrBin: "herdr", paneId: "p1", spawnImpl }), "");
  }
  assert.equal(readPaneDigest({ paneId: "" }), "");
});
