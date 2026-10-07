import assert from "node:assert/strict";
import test from "node:test";

import { MAX_MESSAGE_CHARS, renderAlert, sendTelegram } from "../src/telegram.mjs";

test("renders a blocked alert with location and digest in text format", () => {
  const text = renderAlert(
    {
      kind: "blocked",
      agent: "pi",
      displayAgent: "pi",
      title: "pi - demo",
      workspaceId: "wA",
      paneId: "wA:p1",
      digest: "Apply the patch?\nline two",
    },
    { format: "text" },
  );
  assert.equal(
    text,
    [
      "🙋 pi needs your answer",
      "pi · pi - demo · wA:p1",
      "────────────",
      "Apply the patch?",
      "line two",
    ].join("\n"),
  );
});

test("renders each kind with its headline and emoji", () => {
  const base = { agent: "claude", displayAgent: "Claude", paneId: "p1" };
  assert.match(renderAlert({ ...base, kind: "blocked" }, { format: "text" }), /^🙋 Claude needs your answer/);
  assert.match(renderAlert({ ...base, kind: "done" }, { format: "text" }), /^✅ Claude finished/);
  assert.match(renderAlert({ ...base, kind: "released" }, { format: "text" }), /^👋 Claude left the pane/);
  assert.match(renderAlert({ ...base, kind: "exited" }, { format: "text" }), /^🏁 Claude process exited/);
});

test("omits the digest block entirely when empty", () => {
  const text = renderAlert({ kind: "done", agent: "pi", paneId: "p1", digest: "" }, { format: "text" });
  assert.equal(text, "✅ pi finished\npi · p1");
  assert.ok(!text.includes("────"));
});

test("drops null location parts and falls back from title to workspace", () => {
  const text = renderAlert(
    {
      kind: "done",
      agent: "pi",
      displayAgent: null,
      title: null,
      workspaceId: "wA",
      paneId: null,
      digest: null,
    },
    { format: "text" },
  );
  assert.equal(text, "✅ pi finished\npi · wA");
});

test("renders a header alone when no location is available", () => {
  assert.equal(renderAlert({ kind: "exited" }, { format: "text" }), "🏁 process exited");
});

test("caps the total message at 4000 characters", () => {
  const text = renderAlert(
    { kind: "blocked", agent: "pi", paneId: "p1", digest: "a".repeat(5000) },
    { format: "text" },
  );
  assert.equal(text.length, MAX_MESSAGE_CHARS);
  assert.ok(text.endsWith("…"));
});

test("renders the three-line anatomy with tab name, repo, branch and worktree index", () => {
  const text = renderAlert(
    {
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
    },
    { format: "text" },
  );
  assert.equal(
    text,
    [
      "🙋 pi needs your answer",
      "example-repo · feat/example · worktree 5/5",
      "pi · ws 5 · tab 1 · wB:p1",
      "────────────",
      "Approve the edit?",
    ].join("\n"),
  );
});

test("omits the worktree suffix when the repository has a single checkout", () => {
  const text = renderAlert(
    {
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
    },
    { format: "text" },
  );
  assert.equal(text, ["✅ pi finished", "example-repo · main", "ws 1 · tab 2 · wA:p1"].join("\n"));
  assert.ok(!text.includes("worktree"));
});

test("strips the [N] prefix from a workspace label when there is no repository", () => {
  const text = renderAlert(
    {
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
    },
    { format: "text" },
  );
  assert.equal(text, ["✅ pi finished", "example-lab", "ws 6 · tab 1 · wC:p1"].join("\n"));
});

test("keeps the repo and omits the branch when branch resolution failed", () => {
  const text = renderAlert(
    {
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
    },
    { format: "text" },
  );
  assert.equal(
    text,
    ["🙋 pi needs your answer", "example-repo", "ws 1 · tab 1 · wA:p1", "────────────", "hello"].join(
      "\n",
    ),
  );
});

test("renders repo · branch with no worktree suffix for a probe-discovered repository", () => {
  const text = renderAlert(
    {
      kind: "blocked",
      agent: "pi",
      paneId: "wN1:p1",
      digest: "",
      location: {
        workspaceLabel: "example-lab",
        workspaceNumber: 4,
        repoName: "example-repo",
        branch: "feat/example",
        worktreeIndex: null,
        worktreeTotal: null,
        tabNumber: 2,
        paneId: "wN1:p1",
      },
    },
    { format: "text" },
  );
  assert.equal(
    text,
    ["🙋 pi needs your answer", "example-repo · feat/example", "ws 4 · tab 2 · wN1:p1"].join("\n"),
  );
  assert.ok(!text.includes("worktree"));
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
  const released = renderAlert(
    { kind: "released", agent: "pi", paneId: "wB:p1", location },
    { format: "text" },
  );
  assert.equal(
    released,
    ["👋 pi left the pane", "example-repo · feat/example · worktree 2/2", "ws 2 · tab 1 · wB:p1"].join(
      "\n",
    ),
  );
  assert.ok(!released.includes("────"));

  const exited = renderAlert(
    {
      kind: "exited",
      agent: "pi",
      paneId: "wA:p1",
      location: { workspaceNumber: 1, repoName: "example-repo", tabNumber: 1, paneId: "wA:p1" },
    },
    { format: "text" },
  );
  assert.equal(
    exited,
    ["🏁 pi process exited", "example-repo", "ws 1 · tab 1 · wA:p1"].join("\n"),
  );
});

test("degrades to the legacy location line when nothing was resolved", () => {
  const text = renderAlert(
    {
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
    },
    { format: "text" },
  );
  assert.equal(text, "🙋 pi needs your answer\npi · pi - demo · wZ:p9");
});

test("caps the total message at 4000 characters with the new anatomy", () => {
  const text = renderAlert(
    {
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
    },
    { format: "text" },
  );
  assert.equal(text.length, MAX_MESSAGE_CHARS);
  assert.ok(text.endsWith("…"));
  assert.ok(
    text.startsWith(
      "🙋 pi needs your answer\nexample-repo · feat/example · worktree 2/2\nws 2 · tab 1 · wB:p1\n────────────\n",
    ),
  );
});

test("shows the tab name with its [N] prefix stripped", () => {
  const location = {
    workspaceNumber: 5,
    repoName: "example-repo",
    branch: "feat/example",
    worktreeIndex: 5,
    worktreeTotal: 5,
    tabLabel: "[2] dev servers",
    tabNumber: 1,
    paneId: "wExample:p1",
  };
  const text = renderAlert({ kind: "done", agent: "pi", paneId: "wExample:p1", location }, { format: "text" });
  assert.ok(text.includes("dev servers · ws 5 · tab 1 · wExample:p1"));
});

test("keeps a tab name that repeats the agent name", () => {
  const location = {
    workspaceNumber: 5,
    repoName: "example-repo",
    branch: "feat/example",
    worktreeIndex: 5,
    worktreeTotal: 5,
    tabLabel: "[1] pi",
    tabNumber: 1,
    paneId: "wExample:p1",
  };
  const text = renderAlert({ kind: "done", agent: "pi", paneId: "wExample:p1", location }, { format: "text" });
  assert.ok(text.includes("pi · ws 5 · tab 1 · wExample:p1"));
});

test("drops a tab name that is purely numeric or empty", () => {
  const base = {
    workspaceNumber: 5,
    repoName: "example-repo",
    branch: "feat/example",
    worktreeIndex: 5,
    worktreeTotal: 5,
    tabNumber: 1,
    paneId: "wExample:p1",
  };
  const numeric = renderAlert(
    { kind: "done", agent: "pi", paneId: "wExample:p1", location: { ...base, tabLabel: "[7] 42" } },
    { format: "text" },
  );
  assert.equal(numeric.split("\n")[2], "ws 5 · tab 1 · wExample:p1");

  const empty = renderAlert(
    { kind: "done", agent: "pi", paneId: "wExample:p1", location: { ...base, tabLabel: "[7] " } },
    { format: "text" },
  );
  assert.equal(empty.split("\n")[2], "ws 5 · tab 1 · wExample:p1");
});

test("renders the HTML anatomy with tags on headline, location, address and dialog", () => {
  const text = renderAlert({
    kind: "blocked",
    agent: "pi",
    displayAgent: "pi",
    paneId: "wExample:p1",
    location: {
      workspaceNumber: 5,
      repoName: "example-repo",
      branch: "feat/example",
      worktreeIndex: 5,
      worktreeTotal: 6,
      tabLabel: "[1] dev servers",
      tabNumber: 1,
      paneId: "wExample:p1",
    },
    dialog: {
      question: "Allow the recursive delete command?",
      preview: "rm -rf build && mkdir build",
      options: "❯ Yes\n  No",
    },
  });
  assert.equal(
    text,
    [
      "<b>🙋 pi needs your answer</b>",
      "<code>example-repo · feat/example · worktree 5/6</code>",
      "<code>dev servers · ws 5 · tab 1 · wExample:p1</code>",
      "────────────",
      "<b>Allow the recursive delete command?</b>",
      "<pre>rm -rf build &amp;&amp; mkdir build</pre>",
      "❯ Yes",
      "  No",
    ].join("\n"),
  );
});

test("renders the non-blocked tail digest inside a pre block", () => {
  const text = renderAlert({ kind: "done", agent: "pi", paneId: "p1", digest: "All tests pass. 2>&1" });
  assert.equal(
    text,
    [
      "<b>✅ pi finished</b>",
      "<code>pi · p1</code>",
      "────────────",
      "<pre>All tests pass. 2&gt;&amp;1</pre>",
    ].join("\n"),
  );
});

test("renders the text form of a dialog with no tags at all", () => {
  const alert = {
    kind: "blocked",
    agent: "pi",
    paneId: "p1",
    location: { workspaceNumber: 1, repoName: "example-repo", tabNumber: 1, paneId: "p1" },
    dialog: { question: "Allow it?", preview: "rm -rf x", options: "❯ Yes\n  No" },
  };
  assert.equal(
    renderAlert(alert, { format: "text" }),
    [
      "🙋 pi needs your answer",
      "example-repo",
      "ws 1 · tab 1 · p1",
      "────────────",
      "Allow it?",
      "rm -rf x",
      "❯ Yes",
      "  No",
    ].join("\n"),
  );
});

test("HTML escapes every dynamic value", () => {
  const text = renderAlert({
    kind: "blocked",
    agent: "pi & co <test>",
    displayAgent: "pi & co <test>",
    paneId: "wExample:p1",
    dialog: {
      question: "Run rm -rf > out && echo <done>?",
      preview: 'for f in a b; do echo "$f" > "$f.txt" && cat < in.txt; done 2>&1',
      options: "❯ Yes & continue\n  No <abort>",
    },
  });

  assert.ok(text.includes("pi &amp; co &lt;test&gt;"));
  assert.ok(text.includes("rm -rf &gt; out &amp;&amp; echo &lt;done&gt;?"));
  assert.ok(text.includes('&gt; "$f.txt" &amp;&amp; cat &lt; in.txt; done 2&gt;&amp;1'));
  assert.ok(text.includes("❯ Yes &amp; continue"));

  // No raw metacharacter survives outside the renderer's own tags.
  const withoutTags = text.replace(/<\/?(?:b|code|pre)>/g, "");
  assert.ok(!/[<>]/.test(withoutTags));
  assert.ok(!/&(?!(?:amp|lt|gt);)/.test(withoutTags));
});

test("sendTelegram posts HTML and reports success", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };

  const result = await sendTelegram({
    token: "123:abc",
    chatId: "42",
    text: "<b>hello</b>",
    plainText: "hello",
    fetchImpl,
  });

  assert.deepEqual(result, { ok: true, status: 200, description: "" });
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:abc/sendMessage");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, "42");
  assert.equal(body.text, "<b>hello</b>");
  assert.equal(body.parse_mode, "HTML");
  assert.equal(body.disable_web_page_preview, true);
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
  await assert.rejects(
    sendTelegram({
      token: "1:a",
      chatId: "2",
      text: "x",
      fetchImpl,
      sleepImpl: async () => {},
    }),
    /network down/,
  );
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

test("sendTelegram carries disable_notification: true only when asked", async () => {
  const bodies = [];
  const fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };

  await sendTelegram({
    token: "1:a",
    chatId: "2",
    text: "silent",
    fetchImpl,
    disableNotification: true,
  });
  await sendTelegram({ token: "1:a", chatId: "2", text: "audible", fetchImpl });

  assert.equal(bodies[0].disable_notification, true);
  assert.equal(bodies[1].disable_notification, false);
});

test("sendTelegram retries a transport rejection and delivers exactly once", async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("network down");
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };

  const result = await sendTelegram({
    token: "1:a",
    chatId: "2",
    text: "x",
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [400]);
});

test("sendTelegram gives up after exactly three attempts on persistent 5xx", async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 503,
      json: async () => ({ ok: false, description: "Service Unavailable" }),
    };
  };

  const result = await sendTelegram({
    token: "1:a",
    chatId: "2",
    text: "x",
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.deepEqual(result, { ok: false, status: 503, description: "Service Unavailable" });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [400, 1200]);
});

test("sendTelegram rejects after exactly three transport failures", async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    attempts += 1;
    throw new Error("network down");
  };

  await assert.rejects(
    sendTelegram({
      token: "1:a",
      chatId: "2",
      text: "x",
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    }),
    /network down/,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [400, 1200]);
});

test("sendTelegram never retries a 4xx", async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
    };
  };

  const result = await sendTelegram({
    token: "1:a",
    chatId: "2",
    text: "x",
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    description: "Bad Request: chat not found",
  });
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

test("sendTelegram falls back to plain text when Telegram rejects the HTML entities", async () => {
  const bodies = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (body.parse_mode === "HTML") {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          description: 'Bad Request: can\'t parse entities: Unexpected character "<" at byte offset 0',
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };

  const result = await sendTelegram({
    token: "1:a",
    chatId: "2",
    text: "<b>hello</b>",
    plainText: "hello",
    fetchImpl,
    sleepImpl: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].parse_mode, "HTML");
  assert.equal(bodies[0].text, "<b>hello</b>");
  assert.equal(bodies[1].parse_mode, undefined);
  assert.equal(bodies[1].text, "hello");
});

test("sendTelegram does not resend a non-parse 400", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
    };
  };
  const result = await sendTelegram({
    token: "1:a",
    chatId: "2",
    text: "<b>x</b>",
    plainText: "x",
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.equal(result.status, 400);
  assert.equal(attempts, 1);
});

test("sendTelegram does not retry a parse 400 a second time", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }),
    };
  };
  const result = await sendTelegram({
    token: "1:a",
    chatId: "2",
    text: "<b>x</b>",
    plainText: "x",
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.equal(result.status, 400);
  assert.equal(attempts, 2);
});

test("sendTelegram honors 429 retry_after and caps an excessive wait", async () => {
  const sleeps = [];
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ ok: false, parameters: { retry_after: 2 } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };

  const result = await sendTelegram({
    token: "1:a",
    chatId: "2",
    text: "x",
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, [2000]);

  // An absurd retry_after cannot stall the hook: the wait is capped at 5 s.
  const capped = [];
  let second = false;
  const cappedFetch = async () => {
    if (!second) {
      second = true;
      return {
        ok: false,
        status: 429,
        json: async () => ({ ok: false, parameters: { retry_after: 99 } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await sendTelegram({
    token: "1:a",
    chatId: "2",
    text: "x",
    fetchImpl: cappedFetch,
    sleepImpl: async (ms) => {
      capped.push(ms);
    },
  });
  assert.deepEqual(capped, [5000]);

  // A 429 without retry_after falls back to the normal backoff.
  const plain = [];
  let third = false;
  const plainFetch = async () => {
    if (!third) {
      third = true;
      return { ok: false, status: 429, json: async () => ({ ok: false }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await sendTelegram({
    token: "1:a",
    chatId: "2",
    text: "x",
    fetchImpl: plainFetch,
    sleepImpl: async (ms) => {
      plain.push(ms);
    },
  });
  assert.deepEqual(plain, [400]);
});
