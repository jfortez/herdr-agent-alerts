import { spawnSync } from "node:child_process";

const SNAPSHOT_TIMEOUT_MS = 4000;
const GIT_TIMEOUT_MS = 4000;

function asString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function workspaceIdOf(workspace) {
  return asString(workspace?.workspace_id ?? workspace?.id);
}

function repoRootOf(workspace) {
  return asString(workspace?.worktree?.repo_root);
}

function isLinked(workspace) {
  return workspace?.worktree?.is_linked_worktree === true;
}

function baseName(path) {
  const text = String(path).replace(/[\\/]+$/, "");
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return index >= 0 ? text.slice(index + 1) : text;
}

function stripIndexPrefix(label) {
  return label === null ? null : label.replace(/^\[\d+\]\s*/, "");
}

/**
 * PURE: the workspace ids in Herdr sidebar order. Herdr groups a repository's
 * checkouts together, base checkout first, then its linked worktrees in array
 * order; the 1-based position in this list is the `ws` jump key. The workspace
 * `number` field is NOT this number.
 */
export function buildWorkspaceOrder(workspaces) {
  const list = Array.isArray(workspaces) ? workspaces : [];
  const order = [];
  const emitted = new Set();
  const grouped = new Set();

  const emit = (workspace) => {
    const id = workspaceIdOf(workspace);
    if (id === null || emitted.has(id)) return;
    emitted.add(id);
    order.push(id);
  };

  for (const workspace of list) {
    const root = repoRootOf(workspace);
    if (root === null) {
      emit(workspace);
      continue;
    }
    if (grouped.has(root)) continue;
    grouped.add(root);

    const members = list.filter((candidate) => repoRootOf(candidate) === root);
    for (const member of members) {
      if (!isLinked(member)) emit(member);
    }
    for (const member of members) {
      if (isLinked(member)) emit(member);
    }
  }

  return order;
}

/** Repo name, 1-based position among its checkouts and the total, or null. */
function repoDetails(workspaces, workspace) {
  const root = repoRootOf(workspace);
  if (root === null) return null;

  const members = workspaces.filter((candidate) => repoRootOf(candidate) === root);
  const ordered = [
    ...members.filter((member) => !isLinked(member)),
    ...members.filter((member) => isLinked(member)),
  ];
  const index = ordered.findIndex(
    (member) => workspaceIdOf(member) === workspaceIdOf(workspace),
  );

  return {
    name: asString(workspace?.worktree?.repo_name) ?? baseName(root),
    index: index >= 0 ? index + 1 : null,
    total: members.length,
  };
}

/**
 * PURE apart from the injected `branchResolver`: turn one event's ids into the
 * location shown on the alert. Every field is optional; a missing pane,
 * workspace, snapshot or resolver degrades to nulls instead of throwing.
 */
export function resolveLocation(
  snapshot,
  { workspaceId, tabId, paneId, cwd, branchResolver } = {},
) {
  const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : [];
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];

  const wantedPaneId = asString(paneId);
  const pane =
    wantedPaneId === null
      ? null
      : panes.find((candidate) => asString(candidate?.pane_id) === wantedPaneId) ?? null;

  // Events sometimes carry only a pane id; the snapshot knows the rest.
  const resolvedWorkspaceId = asString(workspaceId) ?? asString(pane?.workspace_id);
  const resolvedTabId = asString(tabId) ?? asString(pane?.tab_id);

  const workspace =
    resolvedWorkspaceId === null
      ? null
      : workspaces.find((candidate) => workspaceIdOf(candidate) === resolvedWorkspaceId) ?? null;

  const order = buildWorkspaceOrder(workspaces);
  const workspaceIndex = workspace === null ? -1 : order.indexOf(workspaceIdOf(workspace));
  const workspaceNumber = workspaceIndex >= 0 ? workspaceIndex + 1 : null;
  const workspaceLabel = stripIndexPrefix(asString(workspace?.label));

  const repo = repoDetails(workspaces, workspace);

  const tab =
    resolvedTabId === null
      ? null
      : tabs.find((candidate) => asString(candidate?.tab_id) === resolvedTabId) ?? null;
  let tabNumber = null;
  if (tab !== null) {
    const siblings = tabs.filter(
      (candidate) => asString(candidate?.workspace_id) === asString(tab.workspace_id),
    );
    const index = siblings.findIndex(
      (candidate) => asString(candidate?.tab_id) === asString(tab.tab_id),
    );
    if (index >= 0) tabNumber = index + 1;
  }

  // Prefer the worktree checkout; fall back to the snapshot pane, then the
  // event's cwd. The resolver is never allowed to break resolution.
  const checkoutPath =
    asString(workspace?.worktree?.checkout_path) ??
    asString(pane?.cwd) ??
    asString(pane?.foreground_cwd) ??
    asString(cwd);

  let branch = null;
  if (checkoutPath !== null && typeof branchResolver === "function") {
    try {
      branch = asString(branchResolver({ checkoutPath })?.branch);
    } catch {
      branch = null;
    }
  }

  return {
    workspaceLabel,
    workspaceNumber,
    repoName: repo?.name ?? null,
    branch,
    worktreeIndex: repo?.index ?? null,
    worktreeTotal: repo?.total ?? null,
    tabLabel: asString(tab?.label),
    tabNumber,
    paneId: wantedPaneId,
    cwd: checkoutPath,
  };
}

/**
 * Impure edge: one `herdr api snapshot` call returns the unwrapped snapshot.
 * Returns null on every failure — absent binary, timeout, bad exit, bad JSON —
 * so the hook can always keep going.
 */
export function readSnapshot({
  herdrBin = "herdr",
  spawnImpl = spawnSync,
  timeoutMs = SNAPSHOT_TIMEOUT_MS,
} = {}) {
  try {
    const result = spawnImpl(herdrBin, ["api", "snapshot"], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!result || result.error || result.status !== 0) return null;

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    if (stdout.trim() === "") return null;

    const parsed = JSON.parse(stdout);
    return parsed?.result?.snapshot ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the git branch of a checkout. Returns `{ branch }` or `{}`; detached
 * HEAD falls back to the short hash, and any git failure yields no branch.
 */
export function defaultBranchResolver({ checkoutPath, spawnImpl = spawnSync } = {}) {
  const path = asString(checkoutPath);
  if (path === null) return {};

  const run = (args) => {
    try {
      const result = spawnImpl("git", ["-C", path, ...args], {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      if (!result || result.error || result.status !== 0) return null;
      const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
      return stdout === "" ? null : stdout;
    } catch {
      return null;
    }
  };

  const name = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (name === null) return {};
  if (name !== "HEAD") return { branch: name };

  const short = run(["rev-parse", "--short", "HEAD"]);
  return short === null ? {} : { branch: short };
}
