# Slash-command reference

The extension registers one slash command. It is local-only (the handler runs in-process with no network call), can be run in any Pi session, and reports only static provider wiring. It records no prompt text, tool arguments, file paths, model output, or credentials.

Note the exact name: Pi commands are single tokens — `/claude-subscription-status` (not `/claude-subscription status`).

| Command | What it reports |
|---|---|
| `/claude-subscription-status` | That the extension's provider is registered and which transport it uses. |

## `/claude-subscription-status`

How to use: type the command in any Pi session.

Output (single info notification, fixed text):

```
claude-subscription uses native Anthropic Messages with Claude Code OAuth.
```

How to interpret it:

- The notification confirms the command is registered and the extension loaded.
- The text describes the extension's provider wiring; it does not mean the current active model is `claude-subscription`.
- If Pi reports the command as unknown, the extension did not load — fall back to `pi list` and re-run `pi install`.
