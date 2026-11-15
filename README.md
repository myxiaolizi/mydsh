# 我的DSH

One control center for DeepSeek Harness. Every feature is independently switchable, and
each surface can be placed where you want it — or turned off entirely.

| Tab | What it does |
| --- | --- |
| **Placement** | Where the entry appears (sidebar, settings only, titlebar, hidden), which modules are enabled, today's token count beside the sidebar entry, and where the usage surface lives. |
| **Interface** | Hide the new-session button, sidebar logo, or product name. Compact sidebar spacing. Move the account menu into the titlebar as an avatar-only chip. |
| **Usage** | Token totals and estimated cost by provider, model, session, and workspace. Stacked trend chart. Context-window pressure. DeepSeek account balance. Per-scope budgets that notify or pause work. |
| **Backup** | Back up workspaces, conversations, configuration, plugins, and model/provider metadata to a local folder, WebDAV, or Aliyun OSS. ZIP or 7z (bundled). Incremental runs, password encryption, splitting, retention. Triggers: manual, cron, after each session, or on startup. |
| **Retry** | Per-error-kind policies with exponential backoff and jitter, plus optional model or provider switching when a request keeps failing. |
| **Prompt** | Standing instructions prepended or appended to the system prompt. |
| **Remote** | Reach this instance from outside your network through a relay you host. The relay server is included. |
| **Toolbox** | Independently switchable optional capabilities, with live MCP server and bundle inventory. |

The UI follows the harness language and theme: Chinese defaults to Chinese, and every
colour is derived from the theme tokens, so light and dark both work without a separate
stylesheet.

## Install

```powershell
dsh plugin install <path-to-this-package>
```

`lib/` is built output and is not published, so build it once after cloning:

```powershell
npm install
node scripts/build-client.mjs
```

Restart DSH afterwards: the Host half loads once at startup, so a replaced package
is not picked up live.

## Where things live

- Settings: `$DSH_HOME/mydsh/settings.json` — atomic, coalesced writes.
- Usage index: `$DSH_HOME/mydsh/usage-index.json` — persisted so a restart re-reads only
  the sessions that changed.
- Secrets: the DSH credential store. Never in `settings.json`, never in a backup.
- Backup working files: `$TMP/mydsh-backup/<runId>/`.
- 7z: `vendor/7z/{x64,x86}/7za.exe`, bundled so the format works without a system
  install. GPL-licensed; see `LICENSE-7ZIP`.

## Defaults

Placement, Interface, Usage, and Toolbox are on. Backup, Retry, Prompt, Remote, and
Budgets are off.

A backup that starts writing archives, or a retry policy that starts re-sending
requests, should be a decision rather than a surprise. Everything that acts on your data
or your traffic waits for you to switch it on.

Turning a module off is not cosmetic: its routes report themselves disabled, and actions
(backup run, remote connect) are refused. A schedule or an external caller cannot keep
working behind a switched-off module.

## Notes on behavior

**Backups record where they stopped.** The engine walks five named stages and keeps
a step log, so a failure names the stage you can act on.

**Incremental means "only what changed", not "a different archive".** Each archive
is self-contained, so restoring needs only the newest one. Timestamps are compared in
whole milliseconds; a finer comparison treated files written moments before a run as
newer than the run itself and archived everything every time.

**Retention runs after a successful upload.** A failed upload never deletes the
last good copy.

**Retry happens at the model stream.** DSH's own retry hook cannot delay or change
a model, so this plugin wraps the stream instead — where both are possible. A
partially delivered response is never replayed.

**Budgets are a ceiling, not a brake on the past.** "Notify" warns; "pause" blocks
new requests. Neither can un-spend what has been used.

**Prompts are advisory.** Standing instructions are added to the prompt; the
harness does not enforce them.

**Stale temp files are swept at startup.** An atomic write cannot clean up after itself
when the process is killed, which is exactly what a restart does. Leftovers are full-size
copies, so they are removed on the next start — only this module's own files, and only
when they are older than ten minutes.

## Requirements

- DSH `>= 0.2.0-rc.2`
- Node.js 22+ for the Host half

## License

MIT for this plugin. The bundled 7-Zip binaries are GPL — see `LICENSE-7ZIP`.
