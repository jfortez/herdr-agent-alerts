# alherdr.agent-alerts

Herdr plugin that turns coding-agent lifecycle changes into Telegram alerts enriched with a real extract of the agent's own pane output. Herdr detects agents (pi, claude, codex, ...) in terminal panes and classifies their state; this plugin forwards the states you care about, so a human away from the terminal learns *what* an agent is asking for, not merely that something changed.

The code, the setup wizard, the Telegram notifications, and this README are all in English.

## What it does

Four alert kinds. `blocked` and `done` carry a digest of the agent's own last screen lines; stop alerts skip the digest because the pane may already be gone. Headlines: `needs your answer`, `finished`, `left the pane`, `process exited`.

```text
🙋 pi needs your answer
example-repo · feat/example · worktree 2/2
ws 2 · tab 1 · wA:p1
────────────
Allow the agent to edit src/app.mjs?

✅ claude finished
example-repo · feat/example
ws 1 · tab 1 · wA:p2
────────────
All 68 tests pass. Committed on feat/agent-alerts.

👋 codex left the pane
example-lab
ws 5 · tab 2 · wA:p3

🏁 pi process exited
example-lab
ws 1 · tab 1 · wA:p1
```

Line 1 is what happened. Line 2 is the place: `repo · branch`, plus `worktree k/n` only when that repository has more than one checkout open in the session; a workspace with no repository shows its label. Line 3 is the addressing: `ws` is the sidebar jump number you press (Herdr groups a repository's worktrees together in the sidebar, which is why it is computed, not read from the workspace's own `number`), `tab` is the tab's index inside its workspace, and the pane id is last. When Herdr gives nothing — no snapshot, a pane that is already gone, a detached or missing git — the alert falls back to the agent, title and pane on a single line and still exits 0. The separator and digest follow only when a digest exists.

## Requirements

- Herdr with plugin support: `min_herdr_version = "0.9.0"` in `herdr-plugin.toml`.
- Node 18+ (the hook commands run `node`; the transport uses `fetch`), plus `curl` and `jq` for `scripts/wizard.sh` only.
- A Telegram bot token and chat id; the wizard creates both.

## Install

```bash
cd /path/to/alherdr
herdr plugin link .
```

GitHub-managed, when the manifest lives at the repo root (this checkout has no git remote, so `OWNER/REPO` is a placeholder; append `/SUBDIR` when the manifest is in a subdirectory):

```bash
herdr plugin install OWNER/REPO
```

Manage the plugin with:

```bash
herdr plugin list --plugin alherdr.agent-alerts
herdr plugin enable alherdr.agent-alerts
herdr plugin disable alherdr.agent-alerts
herdr plugin unlink alherdr.agent-alerts
```

## Setup

```bash
bash scripts/wizard.sh
```

The wizard walks you through BotFather, validates the token with Telegram's `getMe`, discovers the chat id from `getUpdates`, writes `.env` into the plugin config directory with `chmod 600`, and sends a live test message. Re-run it to change the token or chat id. Manual alternative:

```bash
cp env.example "$(herdr plugin config-dir alherdr.agent-alerts)/.env"
$EDITOR "$(herdr plugin config-dir alherdr.agent-alerts)/.env"
```

Fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. A `.env` in the repository root also works for development runs; real environment variables win over both.

## Configuration

All keys live in the `.env` from Setup. Defaults are from `src/config.mjs`; `env.example` mirrors them.

| Key | Default | Effect |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — (required) | Bot token from BotFather. |
| `TELEGRAM_CHAT_ID` | — (required) | Numeric chat id that receives the alerts. |
| `ALHERDR_STATUSES` | `blocked,done` | Statuses that alert. Valid: `idle`, `working`, `blocked`, `done`, `unknown`; unrecognized names are ignored. |
| `ALHERDR_ALERT_RELEASED` | `1` | Alert when an agent leaves its pane (`released = true`). |
| `ALHERDR_ALERT_EXITED` | `1` | Alert when the pane's foreground process ends. |
| `ALHERDR_DIGEST_LINES` | `40` | Lines read from the pane, and upper bound of digest lines. |
| `ALHERDR_DIGEST_MAX_CHARS` | `1200` | Digest length cap, marked with a leading `…` when truncated; a full message is capped at 4000 characters. |
| `ALHERDR_DEDUPE_SECONDS` | `30` | Suppress a repeat of the same pane and kind inside this window. |
| `ALHERDR_ENABLED` | `1` | Default enable state until a toggle action writes the state file. |
| `ALHERDR_DRY_RUN` | `0` | Print the rendered alert to stdout instead of sending it. |
| `ALHERDR_DEBUG_DUMP` | empty (off) | Path to append one JSON line per event (raw payload, parsed payload, resolved kind), even for filtered events. |

Booleans accept `1/0`, `true/false`, `yes/no`, `on/off`. The plugin also reads Herdr-provided `HERDR_BIN_PATH`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, and `HERDR_PLUGIN_STATE_DIR`; the last one is what the dry-run recipe overrides.

## What triggers an alert

| Alert | Herdr event | Fires when |
| --- | --- | --- |
| `blocked` | `pane.agent_status_changed` | `agent_status` is in `ALHERDR_STATUSES`. |
| `done` | `pane.agent_status_changed` | same. |
| `idle` / `working` / `unknown` | `pane.agent_status_changed` | only if added to `ALHERDR_STATUSES`. |
| `released` | `pane.agent_detected` | `released` is `true`, the payload names an agent, and `ALHERDR_ALERT_RELEASED` is on. |
| `exited` | `pane.exited` | `ALHERDR_ALERT_EXITED` is on. |

- `pane.agent_detected` also fires when an agent is *detected* (a start); the dispatcher alerts only on `released = true` with an identifiable agent.
- An agent that aborts a turn but stays alive (Ctrl-C / Esc) emits no exit event; it settles back to `idle`/`done`. `released` and `exited` cover the agent leaving the pane or its process dying, not a per-turn abort. That is why `idle` is off by default.

## Actions and keybindings

```bash
herdr plugin action invoke alherdr.agent-alerts.toggle
herdr plugin action invoke alherdr.agent-alerts.enable
herdr plugin action invoke alherdr.agent-alerts.disable
herdr plugin action invoke alherdr.agent-alerts.send-test
```

Actions run asynchronously: the CLI returns an invocation envelope, and each action's stdout (including `send-test`'s masked credentials and delivery result) lands in the plugin log. `send-test` resolves the same location lines as a real alert and always sends the fixed test body — never a live pane digest — so it validates credentials and the anatomy without risking a mistaken alarm. Bind the toggle in Herdr's `config.toml`:

```toml
# validate with: herdr config check
[[keys.command]]
key = "prefix+alt+a"
type = "plugin_action"
command = "alherdr.agent-alerts.toggle"
description = "Agent Alerts: toggle"
```

## How it works

```text
herdr event hook
  └─ node src/notify.mjs     senseEvent() → gate → dedupe → location → render → send
       ├─ src/config.mjs     .env + environment → one config object
       ├─ src/digest.mjs     herdr agent read → cleaned digest
       ├─ src/topology.mjs   herdr api snapshot → sidebar order, repo/branch, jump address
       ├─ src/state.mjs      enabled flag and dedupe store in the state dir
       └─ src/telegram.mjs   renderAlert() and sendMessage
```

- **The alert location needs topology, not the workspace's `number`.** One `herdr api snapshot` call per alert feeds `src/topology.mjs`: workspaces are ordered the way Herdr's sidebar groups a repository with its linked worktrees, tabs are indexed inside their workspace, and the git branch is resolved from the checkout path (`rev-parse --abbrev-ref HEAD`, short hash when detached). The snapshot call has a timeout and every step degrades to the minimal alert instead of failing the hook.
- **Structured herdr commands return JSON envelopes; `agent read` returns raw text.** Verified on Herdr 0.9.1: `herdr agent read <pane> --source recent-unwrapped --lines N` writes terminal text to stdout, not JSON. `src/digest.mjs` treats stdout as the payload and unwraps a JSON `{ output }` shape only as a narrow future-proofing case.
- **The digest needs a chrome filter.** Rendered pane text still carries the sidebar gutter (`▎`), box borders, spinners, telemetry rows, and status phrases like "waiting for input"; without the filter the alert is noise.
- **Event hooks always exit 0.** Delivery failures are logged to stderr and swallowed, so a bad token or a network outage never disturbs Herdr. `src/actions.mjs` backs the four actions with the same config and transport.

## Troubleshooting

```bash
herdr plugin log list --plugin alherdr.agent-alerts --limit 20
```

**No alert arrives.** Check the log: an event filtered by `ALHERDR_STATUSES` produces no output. Confirm `herdr plugin list --plugin alherdr.agent-alerts` reports `enabled`, and run the `send-test` action, which reports the HTTP result immediately.

**Credentials look wrong.** A `401` in the log means the token is stale; re-run the wizard. `400 Bad Request: chat not found` means the chat id is wrong. The wizard finds it from `getUpdates`; a webhook on the bot blocks that call, so delete the webhook first.

**Digest empty or noisy.** Empty means every read source failed. On Herdr 0.9.1 a pane refuses `--source recent-unwrapped` with `agent_not_idle` while the agent works in an alternate screen or waits at a prompt; `readPaneDigest` then falls back to `--source visible`, so an empty digest means both sources failed for that pane. Noisy output is chrome the filter does not know yet: capture the raw pane and add the pattern in `src/digest.mjs`; fixtures live in `test/fixtures/`.

**Duplicate alerts.** The same pane and kind inside `ALHERDR_DEDUPE_SECONDS` (default 30 s) is suppressed; set it to `0` to disable suppression. `released` and `exited` share one key, so a single agent exit alerts once.

**Reproduce an alert without waiting for a real transition.** Run from the plugin directory:

```bash
HERDR_PLUGIN_STATE_DIR="$(mktemp -d)" ALHERDR_DRY_RUN=1 \
HERDR_PLUGIN_EVENT_JSON='{"event":"pane.agent_status_changed","data":{"pane_id":"'"${HERDR_PANE_ID:-pane-1}"'","agent_status":"blocked","agent":"pi","display_agent":"pi","title":"demo"}}' \
node src/notify.mjs
```

`ALHERDR_DRY_RUN=1` prints the rendered alert, and the temp state dir keeps the real dedupe store untouched. The pane id is whichever pane you run it in, or a placeholder that yields an empty digest.

## Privacy

- Alerts carry real terminal content from the agent pane; that content leaves your machine and lands in your Telegram chat. `ALHERDR_DEBUG_DUMP` is opt-in and appends event payloads, including digest content, to a file you choose.
- Credentials live only in the plugin config directory `.env` (chmod 600 from the wizard). `send-test` prints at most the token's numeric bot id and the last four digits of the chat id.
