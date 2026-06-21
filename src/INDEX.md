# src index

- `constants.ts` — shared Claude Code identity and prompt-sanitizer constants.
- `type-guards.ts` — shared tiny runtime type guards for unknown JSON/object inputs.
- `models.ts` — current `claude-subscription` model definitions and isolated native API id.
- `system-shape.ts` — pure helpers that preserve the required Anthropic `system` block shape.
- `credentials.ts` — Claude Code OAuth credential path resolution, fake-testable token loading, expired/forced token refresh and persistence, in-process refresh coalescing, stale-write avoidance, and macOS Keychain fallback.
- `native-headers.ts` — OAuth-only Anthropic Messages headers; intentionally no `x-api-key`.
- `native-request.ts` — pure native Messages API request construction, system-shape application, and prompt-cache anchor insertion with `cacheRetention` / `PI_CACHE_RETENTION` handling.
- `native-message-conversion.ts` — pure Pi message to Anthropic message-block conversion, including surrogate sanitization/memoization, same-model signed-thinking replay, and tool-result sequencing.
- `native-payload.ts` — pure-ish Pi context/model/options to Anthropic payload shaping, including tool schema conversion, thinking budgets, native model id mapping, and the server-side fallback support latch.
- `native-stream-transport.ts` — raw Anthropic Messages fetch/SSE transport, including URL guard, response callbacks, response-start/no-progress watchdogs, and full-text/incremental SSE response helpers.
- `native-stream-events.ts` — Anthropic SSE event-state application into Pi assistant event streams, including stream contract state, cumulative usage/cache mapping, fallback boundary handling, tool JSON parse throttling, final tool-argument normalization, and active-tool diagnostics.
- `redaction.ts` — shared credential redaction helpers for surfaced errors.
- `extension-changelog.ts` — versioned changelog parsing and per-user startup/reload changelog notification state.
- `tool-json-arguments.ts` — pure repair/parse of partial Anthropic `tool_use` input JSON fragments into arguments records (escapes raw control chars, preserves/rewrites string escapes, closes truncated strings/containers); incremental parsing remains best-effort, while final parsing fails closed when non-empty input is unparseable or not an object.
- `edit-tool-arguments.ts` — pure, conservative `edit`-only argument normalizer: parses a stringified `edits` array and reduces each `{oldText, newText, ...}` item to exactly `{oldText, newText}` so Anthropic-only malformed-but-recoverable `edit` calls pass Pi's `additionalProperties: false` edit schema; non-`edit` tools, malformed items, and other top-level keys are left untouched.
- `anthropic-sse.ts` — exports full-text and incremental SSE parsers (`parseAnthropicSse`, `parseAnthropicSseStream`), the first fail-closed safeguard layer; fixture-driven Anthropic SSE parser with enumerated lifecycle/contract guards (see `docs/current-status.md` § "Stream and tool-call behavior") and preserved fine-grained tool-input deltas.
- `native-stream-simple.ts` — exports `createNativeStreamSimple` and `streamNativeClaudeSubscription`, the Pi `streamSimple` integration that verifies provider identity before OAuth loading, delegates payload shaping to `native-payload.ts`, builds native requests, delegates raw fetch/SSE transport to `native-stream-transport.ts`, delegates parsed event application to `native-stream-events.ts`, surfaces safe redacted request/tool diagnostics in stream errors, and fails closed on contract violations.
