# src index

- `constants.ts` — shared Claude Code identity and prompt-sanitizer constants.
- `type-guards.ts` — shared tiny runtime type guards for unknown JSON/object inputs.
- `models.ts` — current `claude-subscription` model definitions and isolated native API id.
- `system-shape.ts` — pure helpers that preserve the required Anthropic `system` block shape.
- `credentials.ts` — Claude Code OAuth credential path resolution, fake-testable token loading, expired/forced token refresh and persistence, in-process refresh coalescing, stale-write avoidance, and macOS Keychain fallback.
- `native-headers.ts` — OAuth-only Anthropic Messages headers; intentionally no `x-api-key`.
- `native-request.ts` — pure native Messages API request construction, system-shape application, and prompt-cache anchor insertion with `cacheRetention` / `PI_CACHE_RETENTION` handling.
- `native-cache-diagnostics.ts` — read-only request-shape fingerprinting and cache-read drop diagnostics; stores salted hashes/section names only, not prompts or secrets; includes redacted summary formatting for the local command.
- `native-usage-telemetry.ts` — in-process local token/cache telemetry snapshots and redacted summary formatting for the local command.
- `native-transport.ts` — mocked-testable non-stream native HTTP POST transport helper.
- `redaction.ts` — shared credential redaction helpers for surfaced errors.
- `anthropic-sse.ts` — exports full-text and incremental SSE parsers (`parseAnthropicSse`, `parseAnthropicSseStream`), the first fail-closed safeguard layer; fixture-driven Anthropic SSE parser with enumerated lifecycle/contract guards (see `docs/current-status.md` § "Stream and tool-call behavior") and preserved fine-grained tool-input deltas.
- `native-stream-simple.ts` — exports `streamNativeClaudeSubscription`, the Pi `streamSimple` integration that verifies provider identity before OAuth loading, builds native requests, force-refreshes and retries once on 401/authentication errors, fingerprints request shape for diagnostics, streams/parses Anthropic SSE response-body chunks, re-applies the parser's lifecycle invariants while emitting Pi assistant events, preserves cumulative usage/cache fields, records local token/cache telemetry, and fails closed on contract violations.
