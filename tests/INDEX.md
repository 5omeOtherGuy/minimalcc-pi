# tests index

Deterministic Node tests use fake credentials, fake tokens, and mocked network/transport boundaries; they do not make live Anthropic requests. `live-opus46-routing.test.ts` and `live-opus-5-5.test.ts` are opt-in and skipped unless enabled with `PI_LIVE_CLAUDE_OPUS46_TEST=1` / `PI_LIVE_CLAUDE_OPUS55_TEST=1`.

- `anthropic-sse.test.ts` — fixture-driven SSE parser: text/thinking/tool use, fine-grained tool input, malformed ordering, contract violations, and redaction.
- `credential-accounts.test.ts` — multi-account discovery/selection, import state, missing/expired/no-refresh diagnostics, no API-key fallback.
- `current-provider-system-shape.test.ts` — provider registration, isolated native API id, request/anti-billing guardrails, stale-context behavior, slash-command messaging, model constants, system shaping.
- `dependency-drift.test.ts` — Pi dependency lockstep, Node floor/typings alignment, documented gate categories, and the installed-vs-lockfile checker over the real `node_modules`.
- `edit-tool-arguments.test.ts` — `edit` normalizer: stripping stray item keys, parsing a stringified `edits` array, leaving malformed/non-array input unchanged, no input mutation.
- `extension-changelog.test.ts` — versioned changelog parsing, display state, entry signatures, and package-root resolution.
- `live-opus-5-5.test.ts` — opt-in live check: a request without a Pi level is accepted with explicit `low` effort and no fallback, the response confirms the model, and a `high`-effort tool-use turn's signed thinking replays verbatim.
- `live-opus46-routing.test.ts` — opt-in live check that selecting `claude-opus-4-6` sends Opus 4.6 and the response model confirms it.
- `model-matrix.test.ts` — keeps the documented compatibility matrix in sync with `MODELS` and asserts the threat-model headings/secret-shape absence in `SECURITY.md`.
- `native-convert-messages-memo.test.ts` — memoized message conversion is byte-identical across a multi-turn fixture, reuses cached entries, reuses prior turns on append, and does not reuse model-dependent assistant conversions.
- `native-credentials.test.ts` — credential loading, expired/forced refresh/persistence, refresh coalescing, token caching, stale-write avoidance, Keychain fallback, `ANTHROPIC_*` non-fallback, OAuth-only headers.
- `native-fable-5.test.ts` — Fable 5 registration, adaptive payloads, fallback parameter/beta, fallback/refusal SSE parsing, pre-output and mid-stream fallback handling, terminal refusal, and beta rejection/retry/latch.
- `native-new-models.test.ts` — newer models keep subscription metadata and zero API cost and handle level-less requests.
- `native-opus-5-5.test.ts` — Opus 5.5 always-adaptive registration without a refusal fallback, hidden/clamped `off`, no disabled/budget thinking, no forced `tool_choice`, no fallbacks, terminal refusal categories, and same-model-only signed-thinking replay.
- `native-request-golden.test.ts` — full request-body golden snapshots for every registered model, regenerated with `PI_GOLDEN_UPDATE=1`.
- `native-request.test.ts` — system blocks, prompt cache-control anchors, byte-stable repeated payloads, model ids, tool schemas, and no API-key headers.
- `native-stream-simple.test.ts` — mocked `streamSimple` integration: provider guard, text/tool/image conversion, system shaping, cache anchors, thinking replay, tool-input tolerance, fail-closed lifecycle errors, usage preservation, redacted diagnostics, credential use, auth retry, redaction, abort handling.
- `native-thinking-levels.test.ts` — every model's supported levels/clamping, adaptive effort mapping through `max`, manual budgets through `xhigh`, and thinking omission when reasoning is off.
- `native-tool-sequencing.test.ts` — shared tool-sequencing predicates and the sent-tool-result eligibility set (complete sequences, orphans, non-replayable turns, duplicates).
- `package-manifest.test.ts` — manifest metadata, Pi extension discovery, credential-pattern absence, `npm pack --dry-run` contents, and the versioned-changelog requirement.
- `redaction.test.ts` — redaction helpers for header/token patterns, exact known-secret replacement, and bare-token limitations.
- `system-shape.test.ts` — pure prompt sanitizing and `system` block shaping helpers.
- `tool-json-arguments.test.ts` — partial/final `tool_use` JSON parsing and repair, including fail-closed final behavior and pass-through of model-emitted extra keys.
