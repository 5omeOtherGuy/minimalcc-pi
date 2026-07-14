# Slash-command reference

The extension registers three slash commands. They are local-only (handlers run in-process with no Anthropic model call), can be run in any Pi session, and do not record prompt text, tool arguments, model output, or credentials in session content.

Note the exact names: Pi commands are single tokens — `/claude-subscription-status`, `/claude-subscription-accounts`, and `/claude-subscription-import`.

| Command | What it reports or changes |
|---|---|
| `/claude-subscription-status` | Provider wiring, active provider, discovered account, token freshness, refresh availability, and actionable credential errors. |
| `/claude-subscription-accounts` | Discovers Claude Code OAuth accounts and saves the selected source in minimalcc-owned state. |
| `/claude-subscription-import` | Copies the selected Claude Code OAuth credential blob into minimalcc-owned state and selects that imported copy. |

## `/claude-subscription-status`

How to use: type the command in any Pi session.

Output is a single notification whose level is `info`, `warning`, or `error` depending on credential health. Example shape:

```
claude-subscription uses native Anthropic Messages with Claude Code OAuth on native API claude-subscription-native.
active_provider=claude-subscription
credentials=<source> account=<email-or-unknown> subscription=<tier> token=<fresh|near-expiry|expired|unknown> refresh=<available|missing> accounts=<count> [action=<next step>]
```

How to interpret it:

- `active_provider` reports the currently selected Pi provider; it is informational and can be different from `claude-subscription`.
- `token` reports local freshness from the credential expiry timestamp. Expired/near-expiry credentials are warning-level; request-time refresh still happens before sending when `refresh=available`.
- `refresh=missing` on an expired token is actionable: re-run Claude Code login (`claude`).
- Missing credentials produce an error telling you to run Claude Code login or `/claude-subscription-import` after credentials exist.
- The status path never reads or falls back to `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or Pi's generic `auth.json`.

## `/claude-subscription-accounts`

How to use: type the command in a Pi session with UI support.

Behavior:

- Discovers usable Claude Code OAuth credentials from macOS `Claude Code-credentials*` Keychain services and the standard Claude Code credentials file.
- If more than one account is found, shows a selector labeled by account metadata, subscription/tier metadata when present, and source.
- Saves only the selected source descriptor under Pi's agent directory at `pi-claude-subscription/credential-state.json`.
- Does not mutate Pi's generic `auth.json` and does not override the built-in `anthropic` provider.

## `/claude-subscription-import`

How to use: type the command in a Pi session with UI support.

Behavior:

- Runs the same discovery/selection flow as `/claude-subscription-accounts`.
- Copies the selected raw Claude Code credential JSON into `pi-claude-subscription/imported-credentials.json` under Pi's agent directory with local-user file permissions.
- Selects that imported copy for future `claude-subscription` requests.

Security note: the imported file is a duplicate OAuth credential secret. Keep it private and delete it when you no longer want the duplicate.

If Pi reports any of these commands as unknown, the extension did not load — fall back to `pi list` and re-run `pi install`.
