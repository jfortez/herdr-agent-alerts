import assert from "node:assert/strict";
import test from "node:test";

import { MAX_MESSAGE_CHARS, renderAlert, sendTelegram } from "../src/telegram.mjs";

test("renders a blocked alert with location and digest", () => {
  const text = renderAlert({
    kind: "blocked",
    agent: "pi",
    displayAgent: "pi",
    title: "pi - demo",
    workspaceId: "w1J",
    paneId: "w1J:p1",
    digest: "Apply the patch?\nline two",
  });
  assert.equal(
    text,
    [
      "🙋 pi needs your answer",
      "pi · pi - demo · w1J:p1",
      "────────────",
      "Apply the patch?",
      "line two",
    ].join("\n"),
  );
});

test("renders each kind with its headline and emoji", () => {
  const base = { agent: "claude", displayAgent: "Claude", paneId: "p1" };
  assert.match(renderAlert({ ...base, kind: "blocked" }), /^🙋 Claude needs your answer/);
  assert.match(renderAlert({ ...base, kind: "done" }), /^✅ Claude finished/);
  assert.match(renderAlert({ ...base, kind: "released" }), /^👋 Claude left the pane/);
  assert.match(renderAlert({ ...base, kind: "exited" }), /^🏁 Claude process exited/);
});

test("omits the digest block entirely when empty", () => {
  const text = renderAlert({ kind: "done", agent: "pi", paneId: "p1", digest: "" });
  assert.equal(text, "✅ pi finished\npi · p1");
  assert.ok(!text.includes("────"));
});

test("drops null location parts and falls back from title to workspace", () => {
  const text = renderAlert({
    kind: "done",
    agent: "pi",
    displayAgent: null,
    title: null,
    workspaceId: "w1J",
    paneId: null,
    digest: null,
  });
  assert.equal(text, "✅ pi finished\npi · w1J");
});

test("renders a header alone when no location is available", () => {
  assert.equal(renderAlert({ kind: "exited" }), "🏁 process exited");
});

test("caps the total message at 4000 characters", () => {
  const text = renderAlert({ kind: "blocked", agent: "pi", paneId: "p1", digest: "a".repeat(5000) });
  assert.equal(text.length, MAX_MESSAGE_CHARS);
  assert.ok(text.endsWith("…"));
});

test("renders the three-line anatomy with repo, branch, worktree index and jump address", () => {
  const text = renderAlert({
    kind: "blocked",
    agent: "pi",
    displayAgent: "pi",
    paneId: "wB:p1",
    digest: "Approve the edit?",
    location: {
      workspaceLabel: "feat-example",
      workspaceNumber: 5,
      repoName: "example-repo",
      branch: "feat/example",
      worktreeIndex: 5,
      worktreeTotal: 5,
      tabLabel: "[1] pi",
      tabNumber: 1,
      paneId: "wB:p1",
    },
  });
  assert.equal(
    text,
    [
      "🙋 pi needs your answer",
      "example-repo · feat/example · worktree 5/5",
      "ws 5 · tab 1 · wB:p1",
      "────────────",
      "Approve the edit?",
    ].join("\n"),
  );
});

test("omits the worktree suffix when the repository has a single checkout", () => {
  const text = renderAlert({
    kind: "done",
    agent: "pi",
    paneId: "wA:p1",
    digest: "",
    location: {
      workspaceNumber: 1,
      repoName: "example-repo",
      branch: "main",
      worktreeIndex: 1,
      worktreeTotal: 1,
      tabNumber: 2,
      paneId: "wA:p1",
    },
  });
  assert.equal(text, ["✅ pi finished", "example-repo · main", "ws 1 · tab 2 · wA:p1"].join("\n"));
  assert.ok(!text.includes("worktree"));
});

test("strips the [N] prefix from a workspace label when there is no repository", () => {
  const text = renderAlert({
    kind: "done",
    agent: "pi",
    paneId: "wC:p1",
    location: {
      workspaceLabel: "[6] example-lab",
      workspaceNumber: 6,
      repoName: null,
      tabNumber: 1,
      paneId: "wC:p1",
    },
  });
  assert.equal(text, ["✅ pi finished", "example-lab", "ws 6 · tab 1 · wC:p1"].join("\n"));
});

test("keeps the repo and omits the branch when branch resolution failed", () => {
  const text = renderAlert({
    kind: "blocked",
    agent: "pi",
    paneId: "wA:p1",
    digest: "hello",
    location: {
      workspaceNumber: 1,
      repoName: "example-repo",
      branch: null,
      worktreeIndex: 1,
      worktreeTotal: 1,
      tabNumber: 1,
      paneId: "wA:p1",
    },
  });
  assert.equal(
    text,
    ["🙋 pi needs your answer", "example-repo", "ws 1 · tab 1 · wA:p1", "────────────", "hello"].join(
      "\n",
    ),
  );
});

test("renders released and exited alerts with a location and no digest", () => {
  const location = {
    workspaceNumber: 2,
    repoName: "example-repo",
    branch: "feat/example",
    worktreeIndex: 2,
    worktreeTotal: 2,
    tabNumber: 1,
    paneId: "wB:p1",
  };
  const released = renderAlert({ kind: "released", agent: "pi", paneId: "wB:p1", location });
  assert.equal(
    released,
    ["👋 pi left the pane", "example-repo · feat/example · worktree 2/2", "ws 2 · tab 1 · wB:p1"].join(
      "\n",
    ),
  );
  assert.ok(!released.includes("────"));

  const exited = renderAlert({
    kind: "exited",
    agent: "pi",
    paneId: "wA:p1",
    location: { workspaceNumber: 1, repoName: "example-repo", tabNumber: 1, paneId: "wA:p1" },
  });
  assert.equal(
    exited,
    ["🏁 pi process exited", "example-repo", "ws 1 · tab 1 · wA:p1"].join("\n"),
  );
});

test("degrades to the legacy location line when nothing was resolved", () => {
  const text = renderAlert({
    kind: "blocked",
    agent: "pi",
    displayAgent: "pi",
    title: "pi - demo",
    paneId: "wZ:p9",
    digest: "",
    location: {
      workspaceLabel: null,
      workspaceNumber: null,
      repoName: null,
      branch: null,
      worktreeIndex: null,
      worktreeTotal: null,
      tabLabel: null,
      tabNumber: null,
      paneId: "wZ:p9",
    },
  });
  assert.equal(text, "🙋 pi needs your answer\npi · pi - demo · wZ:p9");
});

test("caps the total message at 4000 characters with the new anatomy", () => {
  const text = renderAlert({
    kind: "blocked",
    agent: "pi",
    paneId: "wB:p1",
    digest: "a".repeat(5000),
    location: {
      workspaceNumber: 2,
      repoName: "example-repo",
      branch: "feat/example",
      worktreeIndex: 2,
      worktreeTotal: 2,
      tabNumber: 1,
      paneId: "wB:p1",
    },
  });
  assert.equal(text.length, MAX_MESSAGE_CHARS);
  assert.ok(text.endsWith("…"));
  assert.ok(
    text.startsWith(
      "🙋 pi needs your answer\nexample-repo · feat/example · worktree 2/2\nws 2 · tab 1 · wB:p1\n────────────\n",
    ),
  );
});

test("sendTelegram posts plain text and reports success", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };

  const result = await sendTelegram({
    token: "123:abc",
    chatId: "42",
    text: "hello",
    fetchImpl,
  });

  assert.deepEqual(result, { ok: true, status: 200, description: "" });
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:abc/sendMessage");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, "42");
  assert.equal(body.text, "hello");
  assert.equal(body.disable_web_page_preview, true);
  assert.equal(body.parse_mode, undefined);
});

test("sendTelegram never throws on an HTTP error", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
  });
  const result = await sendTelegram({ token: "123:abc", chatId: "42", text: "x", fetchImpl });
  assert.deepEqual(result, {
    ok: false,
    status: 400,
    description: "Bad Request: chat not found",
  });
});

test("sendTelegram rejects on a transport failure so the caller can contain it", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  await assert.rejects(sendTelegram({ token: "1:a", chatId: "2", text: "x", fetchImpl }), /network down/);
});

test("sendTelegram treats an unparseable body as not ok", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("bad json");
    },
  });
  const result = await sendTelegram({ token: "1:a", chatId: "2", text: "x", fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
});
