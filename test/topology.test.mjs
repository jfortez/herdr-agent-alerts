import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkspaceOrder,
  defaultCheckoutProbe,
  readSnapshot,
  resolveLocation,
} from "../src/topology.mjs";

// Synthetic identifiers only: no real repository, branch, path or label.
const REPO_ROOT = "/repos/example-repo";
const LINKED_CHECKOUT = "/worktrees/example-repo/feat-example";

function noRepo(id, label = null) {
  return { workspace_id: id, label, worktree: null };
}

function repoCheckout(
  id,
  { linked = false, label = null, checkoutPath = REPO_ROOT, root = REPO_ROOT } = {},
) {
  return {
    workspace_id: id,
    label,
    worktree: {
      checkout_path: checkoutPath,
      is_linked_worktree: linked,
      repo_key: `${root}/.git`,
      repo_name: "example-repo",
      repo_root: root,
    },
  };
}

function syntheticSnapshot() {
  return {
    workspaces: [
      repoCheckout("wA", { label: "[1] example-repo" }),
      repoCheckout("wB", { linked: true, label: "[2] feat-example", checkoutPath: LINKED_CHECKOUT }),
      noRepo("wC", "[6] example-lab"),
    ],
    tabs: [
      { tab_id: "wA:t1", workspace_id: "wA", label: "[1] pi", number: 1 },
      { tab_id: "wB:t1", workspace_id: "wB", label: "[1] pi", number: 19 },
      { tab_id: "wB:t2", workspace_id: "wB", label: "[2] fish", number: 2 },
      { tab_id: "wC:t1", workspace_id: "wC", label: "[1] pi", number: 4 },
    ],
    panes: [
      { pane_id: "wA:p1", workspace_id: "wA", tab_id: "wA:t1", cwd: REPO_ROOT, foreground_cwd: REPO_ROOT },
      {
        pane_id: "wB:p1",
        workspace_id: "wB",
        tab_id: "wB:t1",
        cwd: LINKED_CHECKOUT,
        foreground_cwd: LINKED_CHECKOUT,
      },
      {
        pane_id: "wC:p1",
        workspace_id: "wC",
        tab_id: "wC:t1",
        cwd: "/synthetic/example-lab",
        foreground_cwd: "/synthetic/example-lab",
      },
    ],
  };
}

// --- buildWorkspaceOrder ----------------------------------------------------

test("puts the base checkout before a linked worktree that appears first", () => {
  const workspaces = [
    repoCheckout("ws-linked", { linked: true }),
    repoCheckout("ws-base"),
  ];
  assert.deepEqual(buildWorkspaceOrder(workspaces), ["ws-base", "ws-linked"]);
});

test("keeps a repository with a single checkout at its array position", () => {
  const workspaces = [noRepo("ws-a"), repoCheckout("ws-solo"), noRepo("ws-b")];
  assert.deepEqual(buildWorkspaceOrder(workspaces), ["ws-a", "ws-solo", "ws-b"]);
});

test("emits workspaces with no repository, or no repo_root, in array order", () => {
  const workspaces = [
    noRepo("ws-a"),
    noRepo("ws-b"),
    { workspace_id: "ws-c", worktree: { is_linked_worktree: true, repo_root: null } },
  ];
  assert.deepEqual(buildWorkspaceOrder(workspaces), ["ws-a", "ws-b", "ws-c"]);
});

test("groups each repository at its first sighting across several repositories", () => {
  const workspaces = [
    repoCheckout("one-base"),
    repoCheckout("two-base", { label: "[3] two", root: "/repos/two" }),
    repoCheckout("one-linked", { linked: true }),
    noRepo("plain"),
    repoCheckout("two-linked", { linked: true, root: "/repos/two" }),
  ];

  assert.deepEqual(buildWorkspaceOrder(workspaces), [
    "one-base",
    "one-linked",
    "two-base",
    "two-linked",
    "plain",
  ]);
});

test("returns a stable order for equal inputs", () => {
  const workspaces = [
    noRepo("u1"),
    repoCheckout("l2", { linked: true }),
    repoCheckout("b1"),
    noRepo("u3"),
  ];
  assert.deepEqual(buildWorkspaceOrder(workspaces), buildWorkspaceOrder(workspaces));
  assert.deepEqual(buildWorkspaceOrder(workspaces), ["u1", "b1", "l2", "u3"]);
});

// --- resolveLocation --------------------------------------------------------

test("resolves repo, branch, worktree index and jump address for a linked worktree", () => {
  const calls = [];
  const location = resolveLocation(syntheticSnapshot(), {
    workspaceId: "wB",
    tabId: "wB:t1",
    paneId: "wB:p1",
    checkoutProbe: ({ checkoutPath }) => {
      calls.push(checkoutPath);
      return { branch: "feat/example" };
    },
  });

  assert.deepEqual(location, {
    workspaceLabel: "feat-example",
    workspaceNumber: 2,
    repoName: "example-repo",
    branch: "feat/example",
    worktreeIndex: 2,
    worktreeTotal: 2,
    tabLabel: "[1] pi",
    tabNumber: 1,
    paneId: "wB:p1",
    cwd: LINKED_CHECKOUT,
  });
  assert.deepEqual(calls, [LINKED_CHECKOUT]);
});

test("reports worktree index 1 of 1 for a single checkout", () => {
  const snapshot = {
    workspaces: [repoCheckout("wA", { label: "[1] example-repo" })],
    tabs: [{ tab_id: "wA:t1", workspace_id: "wA", label: "[1] pi", number: 1 }],
    panes: [
      { pane_id: "wA:p1", workspace_id: "wA", tab_id: "wA:t1", cwd: REPO_ROOT, foreground_cwd: REPO_ROOT },
    ],
  };

  const location = resolveLocation(snapshot, {
    workspaceId: "wA",
    tabId: "wA:t1",
    paneId: "wA:p1",
    checkoutProbe: () => ({ branch: "main" }),
  });

  assert.equal(location.repoName, "example-repo");
  assert.equal(location.branch, "main");
  assert.equal(location.worktreeIndex, 1);
  assert.equal(location.worktreeTotal, 1);
  assert.equal(location.workspaceNumber, 1);
  assert.equal(location.tabNumber, 1);
});

test("uses the label, prefix stripped, when the workspace has no repository", () => {
  const location = resolveLocation(syntheticSnapshot(), {
    workspaceId: "wC",
    tabId: "wC:t1",
    paneId: "wC:p1",
  });

  assert.equal(location.workspaceLabel, "example-lab");
  assert.equal(location.workspaceNumber, 3);
  assert.equal(location.repoName, null);
  assert.equal(location.branch, null);
  assert.equal(location.worktreeIndex, null);
  assert.equal(location.worktreeTotal, null);
  assert.equal(location.tabNumber, 1);
});

test("derives the workspace and tab from the pane when the event omits them", () => {
  const location = resolveLocation(syntheticSnapshot(), {
    paneId: "wB:p1",
    checkoutProbe: () => ({ branch: "feat/example" }),
  });

  assert.equal(location.workspaceNumber, 2);
  assert.equal(location.tabNumber, 1);
  assert.equal(location.repoName, "example-repo");
});

test("keeps the repo and omits the branch when the probe fails", () => {
  const thrown = resolveLocation(syntheticSnapshot(), {
    workspaceId: "wA",
    paneId: "wA:p1",
    checkoutProbe: () => {
      throw new Error("git missing");
    },
  });
  assert.equal(thrown.repoName, "example-repo");
  assert.equal(thrown.branch, null);

  const empty = resolveLocation(syntheticSnapshot(), {
    workspaceId: "wA",
    paneId: "wA:p1",
    checkoutProbe: () => ({}),
  });
  assert.equal(empty.repoName, "example-repo");
  assert.equal(empty.branch, null);
});

test("degrades without throwing when the pane, workspace or snapshot are missing", () => {
  const snapshot = syntheticSnapshot();

  const missingPane = resolveLocation(snapshot, { paneId: "wZ:p9" });
  assert.equal(missingPane.paneId, "wZ:p9");
  assert.equal(missingPane.workspaceNumber, null);
  assert.equal(missingPane.repoName, null);
  assert.equal(missingPane.tabNumber, null);
  assert.equal(missingPane.branch, null);

  const missingWorkspace = resolveLocation(snapshot, {
    workspaceId: "wZ",
    tabId: "wZ:t9",
    paneId: "wZ:p9",
  });
  assert.equal(missingWorkspace.workspaceLabel, null);
  assert.equal(missingWorkspace.workspaceNumber, null);
  assert.equal(missingWorkspace.tabNumber, null);

  const noSnapshot = resolveLocation(null, { paneId: "wZ:p9", cwd: "/synthetic/fallback" });
  assert.equal(noSnapshot.paneId, "wZ:p9");
  assert.equal(noSnapshot.cwd, "/synthetic/fallback");
  assert.equal(noSnapshot.workspaceNumber, null);
  assert.equal(noSnapshot.branch, null);
});

test("fills repo and branch from the probe when the snapshot has no worktree", () => {
  const snapshot = {
    workspaces: [noRepo("wN1", "[6] example-lab")],
    tabs: [{ tab_id: "wN1:t1", workspace_id: "wN1", label: "[1] pi" }],
    panes: [{ pane_id: "wN1:p1", workspace_id: "wN1", tab_id: "wN1:t1", cwd: REPO_ROOT }],
  };

  const location = resolveLocation(snapshot, {
    workspaceId: "wN1",
    tabId: "wN1:t1",
    paneId: "wN1:p1",
    checkoutProbe: () => ({ branch: "feat/example", repoName: "example-repo" }),
  });

  assert.equal(location.repoName, "example-repo");
  assert.equal(location.branch, "feat/example");
  assert.equal(location.worktreeIndex, null);
  assert.equal(location.worktreeTotal, null);
  assert.equal(location.workspaceLabel, "example-lab");
  assert.equal(location.workspaceNumber, 1);
});

test("resolves the same repo and branch for a nested checkout path", () => {
  const nested = "/repos/example-repo/packages/example-app";
  const seen = [];
  const snapshot = {
    workspaces: [noRepo("wN1", "[3] example-app")],
    tabs: [{ tab_id: "wN1:t1", workspace_id: "wN1", label: "[1] pi" }],
    panes: [{ pane_id: "wN1:p1", workspace_id: "wN1", tab_id: "wN1:t1", cwd: nested }],
  };

  const location = resolveLocation(snapshot, {
    workspaceId: "wN1",
    tabId: "wN1:t1",
    paneId: "wN1:p1",
    checkoutProbe: ({ checkoutPath }) => {
      seen.push(checkoutPath);
      return { branch: "feat/example", repoName: "example-repo" };
    },
  });

  assert.deepEqual(seen, [nested]);
  assert.equal(location.repoName, "example-repo");
  assert.equal(location.branch, "feat/example");
});

test("a probe that is not a repository yields no repo and no branch", () => {
  const snapshot = {
    workspaces: [noRepo("wN1", "[9] example-no-repo")],
    tabs: [{ tab_id: "wN1:t1", workspace_id: "wN1", label: "[1] pi" }],
    panes: [
      { pane_id: "wN1:p1", workspace_id: "wN1", tab_id: "wN1:t1", cwd: "/synthetic/not-a-repo" },
    ],
  };

  // Simulates exit 128: the probe already discarded the junk output.
  const location = resolveLocation(snapshot, {
    workspaceId: "wN1",
    tabId: "wN1:t1",
    paneId: "wN1:p1",
    checkoutProbe: () => ({}),
  });

  assert.equal(location.repoName, null);
  assert.equal(location.branch, null);
  assert.ok(!JSON.stringify(location).includes(".git"));
  assert.ok(!JSON.stringify(location).includes("HEAD"));
});

// --- readSnapshot -----------------------------------------------------------

test("readSnapshot parses the api snapshot envelope", () => {
  const calls = [];
  const snapshot = { workspaces: [], tabs: [], panes: [] };
  const spawnImpl = (bin, args, options) => {
    calls.push({ bin, args, options });
    return {
      status: 0,
      stdout: JSON.stringify({ id: "cli:api:snapshot", result: { snapshot } }),
      stderr: "",
    };
  };

  assert.deepEqual(readSnapshot({ herdrBin: "herdr", spawnImpl }), snapshot);
  assert.equal(calls[0].bin, "herdr");
  assert.deepEqual(calls[0].args, ["api", "snapshot"]);
  // A slow socket must never delay an alert indefinitely.
  assert.equal(typeof calls[0].options.timeout, "number");
  assert.ok(calls[0].options.timeout > 0);
});

test("readSnapshot returns null instead of throwing on any failure", () => {
  const throwing = () => {
    throw new Error("spawn exploded");
  };
  assert.equal(readSnapshot({ spawnImpl: throwing }), null);
  assert.equal(readSnapshot({ spawnImpl: () => ({ status: 1, stdout: "{oops", stderr: "" }) }), null);
  assert.equal(readSnapshot({ spawnImpl: () => ({ status: 0, stdout: "", stderr: "" }) }), null);
  assert.equal(readSnapshot({ spawnImpl: () => ({ status: 0, stdout: "{oops", stderr: "" }) }), null);
  assert.equal(
    readSnapshot({ spawnImpl: () => ({ status: 0, stdout: '{"result":{}}', stderr: "" }) }),
    null,
  );
});

// --- defaultCheckoutProbe ---------------------------------------------------

const COMMON_DIR = "/repos/example-repo/.git";
const PROBE_ARGS = [
  "-C",
  REPO_ROOT,
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
  "--abbrev-ref",
  "HEAD",
];

test("defaultCheckoutProbe reads the common dir and branch in one invocation", () => {
  const calls = [];
  const spawnImpl = (bin, args) => {
    calls.push({ bin, args });
    return { status: 0, stdout: `${COMMON_DIR}\nfeat/example\n`, stderr: "" };
  };

  assert.deepEqual(defaultCheckoutProbe({ checkoutPath: REPO_ROOT, spawnImpl }), {
    repoName: "example-repo",
    branch: "feat/example",
  });
  assert.deepEqual(calls, [{ bin: "git", args: PROBE_ARGS }]);
});

test("defaultCheckoutProbe names a linked worktree after the base repository", () => {
  const spawnImpl = () => ({
    status: 0,
    stdout: `${COMMON_DIR}\nfeat/example\n`,
    stderr: "",
  });

  assert.deepEqual(defaultCheckoutProbe({ checkoutPath: LINKED_CHECKOUT, spawnImpl }), {
    repoName: "example-repo",
    branch: "feat/example",
  });
});

test("defaultCheckoutProbe falls back to the short hash when detached", () => {
  const calls = [];
  const spawnImpl = (bin, args) => {
    calls.push({ bin, args });
    if (args.includes("--abbrev-ref")) {
      return { status: 0, stdout: `${COMMON_DIR}\nHEAD\n`, stderr: "" };
    }
    return { status: 0, stdout: "abc1234\n", stderr: "" };
  };

  assert.deepEqual(defaultCheckoutProbe({ checkoutPath: REPO_ROOT, spawnImpl }), {
    repoName: "example-repo",
    branch: "abc1234",
  });
  assert.deepEqual(calls, [
    { bin: "git", args: PROBE_ARGS },
    { bin: "git", args: ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"] },
  ]);
});

test("defaultCheckoutProbe discards junk from a non-repository on exit 128", () => {
  const spawnImpl = () => ({
    status: 128,
    // Exactly the plausible-looking junk git prints for a non-repository.
    stdout: "/synthetic/not-a-repo/.git\nHEAD\n",
    stderr: "fatal: not a git repository",
  });

  assert.deepEqual(defaultCheckoutProbe({ checkoutPath: "/synthetic/not-a-repo", spawnImpl }), {});
});

test("defaultCheckoutProbe returns nothing on timeout, spawn error, junk or no path", () => {
  const calls = [];
  const erroring = (bin, args) => {
    calls.push({ bin, args });
    return { error: new Error("ETIMEDOUT"), status: null, stdout: "", stderr: "" };
  };
  assert.deepEqual(defaultCheckoutProbe({ checkoutPath: REPO_ROOT, spawnImpl: erroring }), {});
  assert.equal(calls.length, 1);

  const throwing = () => {
    throw new Error("git not found");
  };
  assert.deepEqual(defaultCheckoutProbe({ checkoutPath: REPO_ROOT, spawnImpl: throwing }), {});

  const malformed = () => ({ status: 0, stdout: `${COMMON_DIR}\n`, stderr: "" });
  assert.deepEqual(defaultCheckoutProbe({ checkoutPath: REPO_ROOT, spawnImpl: malformed }), {});

  assert.deepEqual(defaultCheckoutProbe({ checkoutPath: null }), {});
});
