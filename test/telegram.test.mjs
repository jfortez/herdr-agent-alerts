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
