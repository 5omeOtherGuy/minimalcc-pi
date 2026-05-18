# Slash-command reference

The extension registers three slash commands. They are local-only (handlers run in-process with no network call), can be run in any Pi session, and report only state recorded by this extension in the current Pi process. Prompts sent through OpenAI, Gemini, or other providers are not counted. State resets when Pi restarts. None of them record prompt text, tool arguments, file paths, model output, or credentials.

Note the exact names: Pi commands are single tokens — `/claude-subscription-status` (not `/claude-subscription status`), and the diagnostics command is plural (`-cache-diagnostics`).

| Command | What it reports |
|---|---|
| `/claude-subscription-status` | That the extension's provider is registered and which transport it uses. |
| `/claude-subscription-usage` | Per-process token, cache, and request totals for traffic routed through this extension. |
| `/claude-subscription-cache-diagnostics` | Per-process record of cache-read drops between comparable requests, with a fingerprint of which request-shape section changed. |

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

## `/claude-subscription-usage`

How to use: run after prompts have been sent through `claude-subscription/...` in the current Pi process. If the session only used other providers, the output stays at zero. If you switch away later, the command still reports earlier subscription requests from this process. It does **not** capture prompt text, tool arguments, file paths, model output, or credentials.

Output (single info notification; one line, current process counters):

```
Claude subscription usage: requests=N input=N output=N cacheRead=N cacheWrite=N totalTokens=N cacheHitRatio=XX.XX%
```

Fields:

- `requests` — provider responses completed through `claude-subscription` since this Pi process started. Requests routed to any other provider are not counted.
- `input` — non-cached input tokens reported by the API.
- `output` — output tokens reported by the API.
- `cacheRead` — tokens served from the prompt cache.
- `cacheWrite` — tokens written into the prompt cache.
- `totalTokens` — sum reported by the API per response, accumulated.
- `cacheHitRatio` — `cacheRead / (input + cacheRead + cacheWrite)`, formatted as a percentage; `0.00%` when no cacheable tokens have been seen.

How to interpret it:

- `requests=0` after sending prompts means no successful `claude-subscription` response has completed in this Pi process.
- Switching between subscription models is aggregated in this one-line summary; the command does not show the internal per-model breakdown.
- All counters are per-process: a Pi restart, a fresh `pi` invocation, or running multiple Pi processes will each have their own independent totals. This is a session hygiene tool, not a subscription-quota tracker.

## `/claude-subscription-cache-diagnostics`

How to use: run after at least two `claude-subscription` requests sharing the same key (Pi session id, falling back to model name when no session id is present) have completed in the current Pi process. Other providers do not create diagnostic samples. The handler reports cache-read **drops** and identifies which request-shape section changed. Only the latest event is summarized; prompt content, tool arguments, and credentials are never included.

Output when no drops have been recorded:

```
Claude subscription cache diagnostics: events=0
```

Output when at least one drop has been recorded (latest event summarized):

```
Claude subscription cache diagnostics: events=N latest=cache-read-drop model=<id> previousCacheRead=<n> currentCacheRead=<n> changedSections=<sections>
```

`changedSections` is a comma-separated subset of `model`, `system`, `messages`, `tools`, `cacheControl`, `bodyConfig`, or the literal `none`.

How to interpret it:

- `events=0` is the healthy steady state — every cache lookup either matched the previous request or grew. No action needed.
- A reported drop means the most recent request invalidated the prefix cache against an earlier comparable request. The `changedSections` field points at the most likely cause:
  - `system` — system prompt or the extension's identity-block shaping changed.
  - `messages` — message-history shape changed (commonly: a long tool result was inserted before a previously cached prefix, or compaction rewrote earlier turns).
  - `tools` — tool list or tool schemas changed mid-session.
  - `cacheControl` — explicit `cache_control` markers shifted position.
  - `bodyConfig` — unrelated body fields drifted (`temperature`, `max_tokens`, `metadata`, etc.).
  - `model` — the model id changed; switching subscription models invalidates the cache by design.
  - `none` — fingerprints matched but `cacheRead` still shrank; this usually means upstream cache eviction (the cached prefix expired on Anthropic's side) rather than a client-side change.
- In mixed-provider sessions, non-subscription turns are not sampled; when you switch back, changed replayed history may appear under `messages`.
- Fingerprints are SHA-256 hashes salted with per-process random bytes, so they are comparable only within one Pi run and never leak prompt content.
- Diagnostic state is per-process: a Pi restart clears recorded events and resets the fingerprint salt.
