# 我的DSH (dsh-mydsh)

One control center for DeepSeek Harness. Seven independent modules, each with its
own master switch, all reachable from a single settings page.

## What it does

| Module | What you get |
| --- | --- |
| **Interface** | Hide the new-session button, sidebar logo, or product name; compact sidebar spacing; move the account menu into the titlebar as an avatar-only chip; group sessions by workspace or as one flat list. |
| **Usage** | Token totals and estimated cost across provider, model, session, and workspace; a stacked trend chart; context-window pressure; DeepSeek account balance; per-scope budgets that notify or pause work. |
| **Backup** | Workspaces, conversations, config, plugins, and model/provider metadata; local folder, WebDAV, or Aliyun OSS destinations; ZIP or 7z; incremental runs; password encryption; splitting; retention. Triggers: manual, cron, after each session, or on startup. |
| **Retry** | Per-error-kind policies with backoff, plus optional model or provider switching when a request keeps failing. |
| **Prompt** | Standing instructions prepended or appended to the system prompt. |
| **Remote** | Reach this instance from outside your network through a relay you host. |
| **Toolbox** | Independently switchable optional capabilities, with live MCP server and bundle inventory. |

## Install

```powershell
# From the profile directory that DSH uses.
dsh plugin install <path-to-this-package>
```

Or point the plugin manager at this directory. DSH must be restarted after
installing or replacing the package, because the Host half is loaded once at
startup.

## Design notes

**Nothing is on by default except the interface module.** A backup that starts
writing archives, or a retry policy that starts re-sending requests, should be a
decision the user makes rather than a surprise.

**Secrets never enter `settings.json`.** Passwords and access keys are read from
the DSH credential store. The backup manifest explicitly excludes credentials, so
an archive is safe to store off-machine.

**Settings live in `$DSH_HOME/mydsh/settings.json`.** Writes are atomic and
coalesced, so a burst of toggle clicks leaves one coherent document rather than a
queue of partial writes.

**The UI is built from the shell's own tokens.** Every color is an alias of a
`--dsw-alias-*` custom property, which is why light and dark themes work without
a second palette. The plugin ships its own small component set because the
shell's private UI packages are not importable.

**Charts are inline SVG.** A chart library would cost more bundle than the three
shapes this plugin draws, and the hand-drawn version inherits the theme for free.

## Module behavior in detail

### Interface

The shell publishes named slots, and each outlet renders
`<div data-slot="<key>">`. Hiding a surface is therefore one CSS rule keyed off a
body attribute, which survives the shell's re-renders in a way that removing a DOM
node would not.

The account chip occupies `conversation.header.leading` rather than
`shell.leading`. The latter is a `single` slot already occupied by the sidebar's
reopen and new-session controls, so registering there would shadow them.

### Usage

Records are derived from session logs: every `assistant/message` event carries a
usage block and its model source. The Host aggregates them with a TTL cache and
bounded concurrency, so a large corpus does not stall a request.

Cost comes from a price table keyed by provider and model prefix, so a dated model
name inherits its series price. Overrides are editable, and unknown routes report
"no price" rather than zero.

Only DeepSeek exposes a real balance; other providers are estimated from the price
table, and the UI says so.

### Backup

The engine walks five ordered stages and records a step log, so a failure names
the stage a user can act on instead of returning a generic error.

Incremental mode filters entries by modification time against the previous run.
The archive is still self-contained, so restore needs only the newest one — the
filter changes what goes in, not the archive's shape.

Retention runs after a successful upload, so a failed upload never deletes the
last good copy.

7z is reported honestly: if the format is requested and no binary is found, the
run fails with that reason instead of silently producing a ZIP.

### Retry

DSH's retry hook accepts only the decision to retry — no delay, no model change.
This plugin therefore implements retry at the model-stream layer, where the
request options are still writable: it can wait, and it can redirect a request to
a different provider or model. A partially delivered response is never replayed,
because the client has already seen those tokens.

### Remote

The Host opens a WebSocket to a relay and forwards the local origin. Reconnection
uses capped exponential backoff and re-reads settings each time, so disabling the
feature stops the next attempt. The relay server and its deployment guide are in
`docs/`.

## Requirements

- DSH `>= 0.2.0-rc.2`.
- Node.js 22 or newer for the Host half.
- Optional: a 7z binary for the 7z backup format.

## Limits worth knowing

- **7z is not bundled.** The binary is GPL-licensed and platform-specific; the
  plugin uses one you install rather than shipping it.
- **Remote access needs a relay.** This plugin is the client half; it cannot make
  a machine reachable without a server, and exposing an instance publicly means
  anyone who reaches it acts as you.
- **Budgets are advisory when set to "notify".** The "pause" action blocks new
  requests; neither can un-spend what has already been used.
- **Prompts are advisory.** Standing instructions are added to the prompt, not
  enforced by the harness.
