# Prompt-cache live verification runbook

Opt-in runbook for verifying that native Claude subscription requests get real Anthropic prompt-cache reads after a warmup. It consumes subscription quota. Do not commit live logs; use an ignored local path.

## Deterministic checks first

```bash
npm test
npm run typecheck
git diff --check
```

These prove the payload anchors and no-live-request test boundaries without spending quota.

## Live pattern

Run at least two comparable requests in one session, using the same model, tools, system prompt, and prompt shape each turn. Read Anthropic's `usage` (`cache_creation_input_tokens` / `cache_read_input_tokens`) from the stream's `message_start` / `message_delta` events; the Pi assistant message exposes them as `usage.cacheWrite` and `usage.cacheRead`.

1. Warmup: expect `cache_creation_input_tokens > 0` if Anthropic writes a cache entry.
2. Repeat with the same stable prefix: expect `cache_read_input_tokens > 0`.

Pass signal: turn 1 writes cache (or Anthropic otherwise reports creation), turn 2+ reads it, and answer/tool-call behavior stays plausible.

## Interpreting failures

- `cacheRead` always zero: check that the prompt is above Anthropic's cache thresholds, cache anchors are present, and the same model/session/request shape is used.
- `cacheRead` drops after working: compare the outgoing request shape between turns. Changes to tools/schemas, system blocks, message history, or cache-control/body config can break reuse.
- The API rejects cache fields: keep the failing request local, redact secrets, and treat the feature as unsupported on this route until investigated.
