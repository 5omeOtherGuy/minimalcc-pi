# Slash-command reference

The extension registers three local-only slash commands. They run in-process with no Anthropic model call and record no prompt text, tool arguments, model output, or credentials.

| Command | What it reports or changes |
|---|---|
| `/claude-subscription-status` | Provider wiring, active provider, discovered account, token freshness, refresh availability, and actionable credential errors. |
| `/claude-subscription-accounts` | Discovers Claude Code OAuth accounts and saves the selected source in minimalcc-owned state. |
| `/claude-subscription-import` | Copies the selected Claude Code OAuth credential blob into minimalcc-owned state and selects that imported copy. |

If Pi reports any of these as unknown, the extension did not load — check `pi list` and re-run `pi install`.

## `/claude-subscription-status`

Output is a single notification at level `info`, `warning`, or `error` depending on credential health. Example shape:

```
claude-subscription uses native Anthropic Messages with Claude Code OAuth on native API claude-subscription-native.
active_provider=claude-subscription
credentials=<source> account=<email-or-unknown> subscription=<tier> token=<fresh|near-expiry|expired|unknown> refresh=<available|missing> accounts=<count> [action=<next step>]
```

Interpretation:

- `active_provider` is informational and can differ from `claude-subscription`.
- `token` reports local freshness from the expiry timestamp; expired/near-expiry credentials are warnings, and request-time refresh still happens when `refresh=available`.
- `refresh=missing` on an expired token is actionable: re-run Claude Code login.
- Missing credentials produce an error telling you to run Claude Code login or `/claude-subscription-import` once credentials exist.
- The status path never reads or falls back to `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or Pi's generic `auth.json`.

## `/claude-subscription-accounts`

- Discovers usable Claude Code OAuth credentials from macOS `Claude Code-credentials*` Keychain services and the standard credentials file.
- If more than one account is found, shows a selector labeled by account metadata, subscription/tier metadata when present, and source.
- Saves only the selected source descriptor under Pi's agent directory at `pi-claude-subscription/credential-state.json`.
- Does not mutate Pi's generic `auth.json` or override the built-in `anthropic` provider.

## `/claude-subscription-import`

- Runs the same discovery/selection flow as `/claude-subscription-accounts`.
- Copies the selected raw credential JSON into `pi-claude-subscription/imported-credentials.json` under Pi's agent directory with local-user file permissions.
- Selects that imported copy for future `claude-subscription` requests.

The imported file is a duplicate OAuth credential secret. Keep it private and delete it when you no longer want the duplicate.
