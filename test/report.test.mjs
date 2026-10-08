import assert from "node:assert/strict";
import test from "node:test";

import {
  POLLER_STALE_MS,
  pollerStatus,
  renderReport,
  summarizeSnapshot,
} from "../src/report.mjs";

// Synthetic identifiers only: no real repository, branch, path or label.
const REPO_ROOT = "/repos/example-repo";
const LINKED_CHECKOUT = "/worktrees/example-repo/feat-example";

function syntheticSnapshot(agents) {
  return {
    workspaces: [
      {
        workspace_id: "wA",
        label: "[1] example-repo",
        worktree: {
          checkout_path: REPO_ROOT,
          is_linked_worktree: false,
          repo_name: "example-repo",
          repo_root: REPO_ROOT,
        },
      },
      {
        workspace_id: "wB",
        label: "[2] feat-example",
        worktree: {
          checkout_path: LINKED_CHECKOUT,
          is_linked_worktree: true,
          repo_name: "example-repo",
          repo_root: REPO_ROOT,
        },
      },
    ],
    tabs: [
      { tab_id: "wA:t1", workspace_id: "wA", label: "[1] dev servers" },
      { tab_id: "wB:t0", workspace_id: "wB", label: "[1] shell" },
      { tab_id: "wB:t1", workspace_id: "wB", label: "[2] api" },
    ],
    panes: [
      { pane_id: "wA:p1", workspace_id: "wA", tab_id: "wA:t1", cwd: REPO_ROOT },
      { pane_id: "wA:p2", workspace_id: "wA", tab_id: "wA:t1", cwd: REPO_ROOT },
      { pane_id: "wB:p3", workspace_id: "wB", tab_id: "wB:t1", cwd: LINKED_CHECKOUT },
      { pane_id: "wB:p4", workspace_id: "wB", tab_id: "wB:t1", cwd: LINKED_CHECKOUT },
      { pane_id: "wB:p5", workspace_id: "wB", tab_id: "wB:t1", cwd: LINKED_CHECKOUT },
    ],
    agents,
  };
}

// Two blocked, three working, one idle, two done.
const FULL_AGENTS = [
  { agent: "pi", agent_status: "blocked", pane_id: "wA:p1" },
  { agent: "claude", agent_status: "blocked", pane_id: "wB:p3" },
  { agent: "pi", agent_status: "working", pane_id: "wA:p2" },
  { agent: "pi", agent_status: "working", pane_id: "wB:p4" },
  { agent: "claude", agent_status: "working", pane_id: "wB:p5" },
  { agent: "pi", agent_status: "idle", pane_id: "wA:p2" },
  { agent: "pi", agent_status: "done", pane_id: "wA:p2" },
  { agent: "claude", agent_status: "done", pane_id: "wB:p4" },
];

function reportState(overrides = {}) {
  return {
    enabled: true,
    defaulted: false,
    token: "sentinel-token",
    chatId: "sentinel-chat",
    poller: { state: "off", ageMs: null },
    summary: summarizeSnapshot(syntheticSnapshot(FULL_AGENTS)),
    ...overrides,
  };
}

// --- summarizeSnapshot ------------------------------------------------------

test("summarizes blocked, working, idle and done agents with their locations", () => {
  const summary = summarizeSnapshot(syntheticSnapshot(FULL_AGENTS));

  assert.equal(summary.unavailable, false);
  assert.equal(summary.running, 3);
  assert.equal(summary.idle, 1);
  assert.equal(summary.done, 2);
  assert.equal(summary.settled, 3);
  assert.equal(summary.unknown, 0);
  assert.equal(summary.waiting.length, 2);

  const [first, second] = summary.waiting;
  assert.equal(first.agent, "pi");
  assert.equal(first.location.paneId, "wA:p1");
  assert.equal(first.location.workspaceNumber, 1);
  assert.equal(first.location.tabNumber, 1);
  assert.equal(first.location.tabLabel, "[1] dev servers");
  assert.equal(second.agent, "claude");
  assert.equal(second.location.paneId, "wB:p3");
  // The linked worktree sorts after its base checkout: ws 2, tab 2.
  assert.equal(second.location.workspaceNumber, 2);
  assert.equal(second.location.tabNumber, 2);
  assert.equal(second.location.tabLabel, "[2] api");
});

test("has no waiting list when nothing is blocked", () => {
  const agents = [
    { agent: "pi", agent_status: "working", pane_id: "wA:p1" },
    { agent: "pi", agent_status: "idle", pane_id: "wA:p1" },
    { agent: "claude", agent_status: "done", pane_id: "wB:p3" },
  ];
  const summary = summarizeSnapshot(syntheticSnapshot(agents));

  assert.deepEqual(summary.waiting, []);
  assert.equal(summary.running, 1);
  assert.equal(summary.idle, 1);
  assert.equal(summary.done, 1);
  assert.equal(summary.unavailable, false);
});

test("marks null or malformed snapshots unavailable without throwing", () => {
  for (const bad of [null, undefined, {}, { agents: "nope" }, { agents: null }]) {
    const summary = summarizeSnapshot(bad);
    assert.equal(summary.unavailable, true);
    assert.deepEqual(summary.waiting, []);
    assert.equal(summary.running, 0);
    assert.equal(summary.settled, 0);
  }
});

test("counts a malformed agent entry or unknown status as unknown, not a throw", () => {
  const agents = [
    null,
    "junk",
    { agent: "pi", agent_status: "reticulating", pane_id: "wA:p1" },
    { agent: "pi", pane_id: "wA:p1" },
  ];
  const summary = summarizeSnapshot(syntheticSnapshot(agents));
  assert.equal(summary.unavailable, false);
  assert.equal(summary.unknown, 4);
  assert.equal(summary.settled, 4);
  assert.deepEqual(summary.waiting, []);
});

// --- renderReport -----------------------------------------------------------

test("renders the exact full report with the waiting list aligned", () => {
  assert.equal(
    renderReport(reportState()),
    [
      "alherdr: alerts enabled · token set · chat set · poller off",
      "2 waiting for you:",
      "  pi     · wA:p1 · dev servers · ws 1 · tab 1",
      "  claude · wB:p3 · api         · ws 2 · tab 2",
      "3 running · 1 idle · 2 done",
    ].join("\n"),
  );
});

test("renders one clear line when nothing is waiting", () => {
  const agents = [
    { agent: "pi", agent_status: "working", pane_id: "wA:p1" },
    { agent: "pi", agent_status: "idle", pane_id: "wA:p1" },
    { agent: "claude", agent_status: "done", pane_id: "wB:p3" },
  ];
  assert.equal(
    renderReport(
      reportState({ summary: summarizeSnapshot(syntheticSnapshot(agents)) }),
    ),
    [
      "alherdr: alerts enabled · token set · chat set · poller off",
      "nothing waiting for you",
      "1 running · 1 idle · 1 done",
    ].join("\n"),
  );
});

test("renders the poller as off when no heartbeat exists", () => {
  const agents = [
    { agent: "pi", agent_status: "working", pane_id: "wA:p1" },
    { agent: "pi", agent_status: "idle", pane_id: "wA:p1" },
    { agent: "claude", agent_status: "done", pane_id: "wB:p3" },
  ];
  assert.equal(
    renderReport(
      reportState({
        poller: { state: "off", ageMs: null },
        summary: summarizeSnapshot(syntheticSnapshot(agents)),
      }),
    ),
    [
      "alherdr: alerts enabled · token set · chat set · poller off",
      "nothing waiting for you",
      "1 running · 1 idle · 1 done",
    ].join("\n"),
  );
});

test("renders a fresh heartbeat as running and an old one as stale", () => {
  const running = renderReport(
    reportState({ poller: { state: "running", ageMs: 5_400 } }),
  );
  assert.match(running, / · poller running \(5s ago\)$/m);

  const stale = renderReport(
    reportState({ poller: { state: "stale", ageMs: 120_000 } }),
  );
  assert.match(stale, / · poller stale \(120s ago\)$/m);
});

test("renders the local state and unavailable counts on a failed snapshot", () => {
  assert.equal(
    renderReport({
      enabled: false,
      defaulted: true,
      token: null,
      chatId: null,
      poller: { state: "off", ageMs: null },
      summary: summarizeSnapshot(null),
    }),
    [
      "alherdr: alerts disabled (default) · token missing · chat missing · poller off",
      "agent counts unavailable",
    ].join("\n"),
  );
});

test("never renders token or chat values, only set or missing", () => {
  const state = reportState({
    token: "SENTINEL-TOKEN-abc123",
    chatId: "SENTINEL-CHAT-xyz789",
  });
  const text = renderReport(state);
  assert.match(text, /token set/);
  assert.match(text, /chat set/);
  assert.ok(!text.includes("SENTINEL-TOKEN-abc123"));
  assert.ok(!text.includes("SENTINEL-CHAT-xyz789"));

  const missing = renderReport(reportState({ token: "", chatId: null }));
  assert.match(missing, /token missing · chat missing/);
});

test("reports unknown settled agents only when some exist", () => {
  const agents = [{ agent: "pi", agent_status: "unknown", pane_id: "wA:p1" }];
  const withUnknown = renderReport(
    reportState({ summary: summarizeSnapshot(syntheticSnapshot(agents)) }),
  );
  assert.match(withUnknown, /0 running · 0 idle · 0 done · 1 unknown/);

  const withoutUnknown = renderReport(reportState());
  assert.ok(!withoutUnknown.includes("unknown"));
});

// --- pollerStatus -----------------------------------------------------------

test("classifies heartbeats against the stale threshold", () => {
  assert.deepEqual(pollerStatus({ atMs: 1_000, nowMs: 1_000 }), {
    state: "running",
    ageMs: 0,
  });
  assert.deepEqual(pollerStatus({ atMs: 1_000, nowMs: 1_000 + POLLER_STALE_MS - 1 }), {
    state: "running",
    ageMs: POLLER_STALE_MS - 1,
  });
  assert.deepEqual(pollerStatus({ atMs: 1_000, nowMs: 1_000 + POLLER_STALE_MS }), {
    state: "stale",
    ageMs: POLLER_STALE_MS,
  });
  assert.deepEqual(pollerStatus({}), { state: "off", ageMs: null });
  assert.deepEqual(pollerStatus({ atMs: "banana", nowMs: 1_000 }), {
    state: "off",
    ageMs: null,
  });
});
