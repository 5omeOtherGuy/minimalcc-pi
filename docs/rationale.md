# Why this package exists

This expands on the README's one-paragraph rationale for anyone evaluating whether the package is right for them.

## Harness vs. model

Public reports of Claude model regressions usually conflate three variables: the model weights and routing Anthropic serves; the Claude Code harness around them (a large system prompt, tool descriptions, compaction, CLI behavior that cannot be disabled from outside); and the user's own prompts, tools, and workflow.

Without isolating the harness, it is hard to tell whether a bad session is a model regression, a harness interaction, or a local prompt problem. This package makes the harness controllable for users with an existing Claude Code subscription, so the same tasks can run under a leaner, auditable harness (Pi) and be compared: same account, same model id, different agent loop.

It is not a benchmark suite and does not claim that any Anthropic change caused any specific regression. It avoids Claude Code's full system prompt as far as the OAuth route permits; because that route validates request shape, the provider still sends the Claude Code identity as the first `system` block, followed by Pi's system prompt. See [`why-system-blocks.md`](why-system-blocks.md).

## Intended use and fair use

Use this package to investigate harness effects on your own tasks, prefer Pi's minimal agent loop for day-to-day work, and get subscription-backed Claude access without a proxy or API-key billing.

Do **not** use it with API-capacity or arbitrage harnesses to convert a consumer subscription into a general replacement for paid API usage. If your workload belongs on the API, use the API and pay for it.

Native requests include prompt-cache anchors and optional long-cache retention where supported, so repeated Pi sessions reuse stable prefixes. These are quota-hygiene measures, not a guarantee of identical behavior to Claude Code internals.

## Why a native Pi provider, not a proxy

A native Pi integration is simpler and safer than a proxy bridge:

- No background daemon, local proxy, Python service, or port binding to install, monitor, or trust.
- Pi owns provider registration, model metadata, thinking-level mapping, and request/stream conversion.
- OAuth credentials are loaded only at request time from Claude Code's local store, and the native stream rejects non-`claude-subscription` routing before loading them.
- Requests use OAuth-only headers and intentionally omit `x-api-key`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` fallbacks.
- Cache behavior is visible in source: system-block shaping, cache-control anchors, and retention are implemented in TypeScript with mocked tests.
- Streaming is parsed incrementally and fails closed on malformed or out-of-order SSE lifecycle events.
- Pi's `models.json` `modelOverrides` do not apply to this extension-registered provider; change [`src/models.ts`](../src/models.ts) or fork the package to alter model metadata.

## Project principles

- Measured, redacted evidence over anecdotes.
- Minimal model-visible intervention: no prompt rewrites, hidden compaction, or tool filtering unless impact is measurable.
- Transparent quota hygiene without committing prompts, logs, or credentials.
- Compatibility through narrow shims: only the system-block shape and OAuth headers required by the route, with Pi's prompt and tool loop authoritative.
- Individual local subscription use only — not resale, pooled access, or avoiding API billing for workloads that belong on the API.
