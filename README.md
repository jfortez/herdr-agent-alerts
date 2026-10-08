# alherdr.agent-alerts

A Herdr plugin that sends a Telegram message when a coding agent needs attention,
including a real extract of what that agent is asking. It exists for when you are
away from the machine: the alert tells you who is waiting, what it wants, and
where to go.

```text
🙋 pi needs your answer
example-repo · feat/example · worktree 2/2
dev servers · ws 2 · tab 1 · wA:p1
────────────
Allow the agent to edit src/app.mjs?
```

Above the separator, three lines: what happened, where it is, and how to get
there. Line 2 is `repo · branch`, plus `worktree k/n` when that repository has
more than one checkout open. Line 3 is the tab name, the `ws` and `tab` jump
numbers, and the pane id. Below the separator comes the content: for `blocked`,
the approval dialog read from the pane; for `done`, the agent's last screen lines.

## Install

```bash
herdr plugin install jfortez/herdr-agent-alerts
```

Working on the plugin itself instead: `cd /path/to/herdr-agent-alerts && herdr plugin link .`

Requires Herdr with plugin support (0.9.1+) and Node 22+ (LTS).

## Setup

Run the wizard from the Herdr CLI. It opens as a popup with a real terminal:

```bash
herdr plugin pane open --plugin alherdr.agent-alerts --entrypoint setup
```

It walks five steps: it opens BotFather, checks the token, finds your chat id,
writes the credentials to the plugin config directory with `chmod 600`, and sends
a live test message. Re-run it whenever you change credentials. It needs `curl`
and `jq`.

To configure by hand instead, create `.env` in
`$(herdr plugin config-dir alherdr.agent-alerts)` with `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` set. `env.example`, in the plugin root, lists the rest.

## Configure

All keys live in the `.env` from Setup. `env.example` mirrors these defaults and
documents the rest.

| Key | Default | Effect |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — required | Bot token from BotFather. |
| `TELEGRAM_CHAT_ID` | — required | Chat that receives the alerts. |
| `ALHERDR_STATUSES` | `blocked,done` | Statuses that alert: `idle`, `working`, `blocked`, `done`, `unknown`. |
| `ALHERDR_SILENT_KINDS` | `released,exited` | Kinds delivered without a sound. Empty makes everything audible. |
| `ALHERDR_ALERT_RELEASED` | `1` | Alert when an agent leaves its pane. |
| `ALHERDR_ALERT_EXITED` | `1` | Alert when the pane's process ends. |
| `ALHERDR_DIGEST_LINES` | `24` | Lines read from the pane. |
| `ALHERDR_DEDUPE_SECONDS` | `30` | Suppress a repeat of the same pane and kind. |
| `ALHERDR_TELEGRAM_COMMANDS` | `0` | Run the detached poller that answers `/status`, `/help` and `/start` from your phone. |
| `ALHERDR_DRY_RUN` | `0` | Print the alert instead of sending it. |

Also available: `ALHERDR_DIGEST_MAX_CHARS`, `ALHERDR_ENABLED`, and
`ALHERDR_DEBUG_DUMP`, which appends raw event payloads to a file. Booleans accept
`1/0`, `true/false`, `yes/no`, `on/off`.

`blocked` and `done` make the phone buzz. `released` and `exited` arrive silently,
so the sound keeps meaning that you are needed: move a kind between the two by
editing `ALHERDR_SILENT_KINDS`. The branch line needs `git` on `PATH`; without it
the alert still arrives, minus the branch.

## When it alerts

| Alert | Comes from | Fires when |
| --- | --- | --- |
| `blocked`, `done` | `pane.agent_status_changed` | the status is in `ALHERDR_STATUSES` |
| `released` | `pane.agent_detected` | `released` is true and an agent is named |
| `exited` | `pane.exited` | the pane's foreground process ends |

An agent that aborts a turn but stays alive (Ctrl-C, Esc) emits no exit event. It
settles back to `idle` or `done`, which is why `idle` is off by default.

## Actions

```bash
herdr plugin action invoke alherdr.agent-alerts.toggle
herdr plugin action invoke alherdr.agent-alerts.send-test
herdr plugin action invoke alherdr.agent-alerts.status
```

Also `enable`, `disable`. `status` prints a compact report of the plugin's own
state plus what the agents are doing: whether alerts are on — and whether
`ALHERDR_ENABLED` decided that because no state file exists yet — whether the
token and chat id are set (never their values), the detached Telegram poller's
heartbeat when one exists, and the waiting list. The waiting list is the "who
needs me" view: one aligned line per blocked agent with the tab name, `ws`,
`tab` and pane id to jump to, or `nothing waiting for you`. It sends nothing, so
checking the switch can never trigger an alert, and it still prints the local
state when the Herdr snapshot is unavailable. `send-test` sends the fixed test
body with a real location, so you can check credentials and the message format
without risking a false alarm. Actions run in the background and their output
lands in the plugin log. To bind the toggle:

```toml
[[keys.command]]
key = "prefix+alt+a"
type = "plugin_action"
command = "alherdr.agent-alerts.toggle"
description = "Agent Alerts: toggle"
```

## Telegram commands (opt-in)

`/status` from your phone returns the same report the `status` action prints,
without walking back to the machine. It is **off by default**: a plugin should
not keep a permanent background process listening unless you ask it to. Set
`ALHERDR_TELEGRAM_COMMANDS=1` in the `.env` from Setup and restart the Herdr
server (the startup hook is what launches the poller). While it is off, nothing
is spawned and no process runs.

When it is on, a detached process long-polls `getUpdates` and answers only
commands from the configured `TELEGRAM_CHAT_ID`:

| Command | Reply |
| --- | --- |
| `/status` | The status report: the alerts switch, credentials as set/missing, the poller heartbeat, the waiting list, and the counts. |
| `/start`, `/help` | One line of usage. |
| anything else | `Unknown command. Try /status or /help.` |

Messages from any other chat are ignored completely: no reply, not even an
error, so a stranger who finds the bot cannot query the machine. The poller is
read-only — it reads one Herdr snapshot and replies; it never sends keys,
prompts an agent, or changes anything. `status` reports its liveness from the
heartbeat file: `poller running (Ns ago)` when it is alive, and `poller stale`
or `poller off` while it is down.

The poller runs under a small detached supervisor. If the poller exits with an
unexpected error, the supervisor waits a few seconds and starts it again, so a
crash recovers without touching Herdr. What still needs a Herdr server start is
the first launch: `ALHERDR_TELEGRAM_COMMANDS=1` only takes effect when the
server start runs the startup hook, and turning it off stops the next launch
rather than an already-running poller. `TERM` or `INT` to the supervisor, or to
the poller, stops both and nothing restarts them until the next server start. A
poller killed outright (`SIGKILL`) is treated as a crash and restarted, and
every start re-reads the `.env`, so that restart also picks up an edited token
or chat id. If a reply cannot be delivered, the poller holds the offset at that
update so Telegram redelivers it on the next poll, and after three failed
attempts it logs that the update is abandoned and moves on rather than looping
forever.

## Troubleshooting

```bash
herdr plugin log list --plugin alherdr.agent-alerts --limit 20
```

The event hook never disturbs Herdr: delivery failures are logged and swallowed.

**Nothing arrives.** An event that matches no alert kind logs nothing. Make sure
the plugin is `enabled`, then run `send-test`, which reports the HTTP result.

**`401` or `chat not found`.** Stale token or wrong chat id: re-run the wizard. If
`getUpdates` keeps returning nothing, the bot has a webhook. Delete it.

**Empty or noisy digest.** Empty means both pane read sources failed for that
pane. Noisy means the chrome filter does not know that pattern yet: add it in
`src/digest.mjs` with a fixture in `test/fixtures/`.

**Duplicate alerts.** The same pane and kind is suppressed for
`ALHERDR_DEDUPE_SECONDS`. Set it to `0` to turn suppression off.

**Try it without waiting for a real event:**

```bash
HERDR_PLUGIN_STATE_DIR="$(mktemp -d)" ALHERDR_DRY_RUN=1 \
HERDR_PLUGIN_EVENT_JSON='{"event":"pane.agent_status_changed","data":{"pane_id":"pane-1","agent_status":"blocked","agent":"pi","display_agent":"pi","title":"demo"}}' \
node src/notify.mjs
```

## Privacy

Alerts carry real terminal content, and that content leaves your machine for your
Telegram chat. Credentials live only in the plugin config `.env`, at mode 600, and
`send-test` prints a masked summary at most.

## Development

`node --test` runs the suite. Tests need Node 22+ (LTS); the runtime avoids
anything newer than Node 18, but only 22+ is tested. Pane fixtures live in
`test/fixtures/`. One thing worth knowing before editing the digest: structured
`herdr` commands return JSON, but `herdr agent read` writes raw terminal text to
stdout.

A GitHub install runs from a managed copy, so local edits do nothing until you
`herdr plugin uninstall alherdr.agent-alerts` and `herdr plugin link .` instead.

## License

MIT — see [LICENSE](LICENSE).
