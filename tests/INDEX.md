# tests index

Deterministic Node tests use fake credentials, fake tokens, and mocked network/transport boundaries; they do not make live Anthropic requests. The only exception is `live-opus46-routing.test.ts`, which is skipped unless explicitly enabled with `PI_LIVE_CLAUDE_OPUS46_TEST=1`.

- `current-provider-system-shape.test.ts` — provider registration, isolated native API id, anti-billing/request guardrails, visibility caveats, telemetry/cache diagnostic commands, native `streamSimple` registration, and Claude Code system-block shaping.
- `system-shape.test.ts` — prompt sanitizing and Anthropic `system` block shaping helpers.
- `native-credentials.test.ts` — fake-file tests for Claude Code OAuth credential loading, expired/forced-token refresh, concurrent refresh coalescing, stale-write avoidance, macOS Keychain fallback, and OAuth-only native headers.
- `native-request.test.ts` — native Messages request construction tests for system blocks, prompt cache-control anchors, byte-stable repeated payloads, model ids, and no API-key headers.
- `native-cache-diagnostics.test.ts` — deterministic request fingerprint and cache-read drop diagnostic tests that assert diagnostics do not expose prompt/tool text and do not mutate payloads.
- `native-usage-telemetry.test.ts` — in-process usage/cache telemetry and redacted summary formatting tests.
- `native-transport.test.ts` — mocked native HTTP transport tests for endpoint, OAuth headers, non-2xx/plain-text errors, fetch failures, redaction, and no localhost dependency.
- `anthropic-sse.test.ts` — fixture-driven Anthropic SSE parser tests for text, thinking, tool use, fine-grained tool-input tolerance, malformed ordering, contract violations, and redaction.
- `native-stream-simple.test.ts` — mocked Pi `streamSimple` integration tests for provider guard, text/tool/image conversion, system prompt shaping, prompt cache-control anchors, thinking replay, fine-grained tool-input tolerance, fail-closed lifecycle errors, cumulative usage/cache token preservation, local telemetry/diagnostics recording, OAuth credential use, one-shot auth-error refresh/retry, redaction, and abort handling.
- `live-opus46-routing.test.ts` — opt-in live Claude Code OAuth check that selecting `claude-opus-4-6` sends Opus 4.6 and that Anthropic's streamed response model confirms Opus 4.6; skipped by default.
- `package-manifest.test.ts` — static package manifest guard for Pi extension discovery, engine/keyword metadata, and credential-pattern absence.
- `redaction.test.ts` — direct redaction helper tests for OAuth/API-key header patterns, exact known-secret replacement, and bare-token limitations.
