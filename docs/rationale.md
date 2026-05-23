# Why this package exists

This document expands on the one-paragraph rationale in the README. It is reference material for anyone evaluating whether this package is the right tool for them; the README itself stays focused on installation and use.

## Harness vs. model: the variable this package isolates

Over the last several months there have been recurring public reports of Claude model regressions: Opus following instructions less reliably on long tasks, Sonnet looping on tool errors, ignored repository conventions, and degraded coding behavior compared to earlier snapshots. Anthropic has itself published postmortems acknowledging serving-side bugs that intermittently degraded responses. The community discussion that follows these reports usually conflates three distinct variables:

1. The **model weights and routing** Anthropic is currently serving.
2. The **Claude Code harness** around them: a large product-specific system prompt, tool descriptions, compaction strategy, and CLI behavior that cannot be disabled from outside.
3. The **user's own prompts, tools, and workflow**.

Without isolating (2), it is very hard to tell whether a bad Claude session is a model regression, a harness interaction, or a local prompt problem. This package exists to make (2) controllable for individual users with an existing Claude Code subscription, so they can run the same tasks under a leaner, fully auditable harness (Pi) and compare.

It is not a benchmark suite and it does not claim to prove that any specific Anthropic change caused any specific regression. It is a switch: same account, same model id, different agent loop. What you do with the comparison — anecdotal A/B, structured evals, or just "does this finally stop looping" — is up to you.

In local use, the maintainers have observed Claude following instructions more reliably when the same work runs through Pi's prompt and tool loop. That observation is subjective and workload-dependent, and this document should not be read as a benchmark or as a claim that Anthropic has misconfigured any specific model. It sits alongside public Claude Code issue reports about Opus regressions, ignored instructions, repeated basic errors, and looping behavior — useful context, not a root-cause claim.

The package therefore avoids Claude Code's full system prompt and runtime harness as far as the OAuth route permits. Because that route validates request shape, the provider still sends the Claude Code identity as the first `system` block for compatibility, followed by Pi's system prompt as the next block. See [`why-system-blocks.md`](why-system-blocks.md).

## What this lets you compare

With Claude Code installed and logged in, the same Claude Code subscription account can be exercised through two different harnesses on the same machine:

| Variable | Claude Code CLI | This package (via Pi) |
|---|---|---|
| Model weights / routing | Anthropic-controlled, same account | Anthropic-controlled, same account |
| Auth path | Claude Code OAuth | Claude Code OAuth (reused) |
| System prompt | Full Claude Code product prompt | Pi's system prompt with Claude Code compatibility context |
| Tool descriptions and ordering | Claude Code defaults | Pi's tool surface, user-controllable |
| Compaction / context management | Claude Code internal | Pi's compaction, user-controllable |
| Thinking / reasoning controls | Claude Code defaults | Explicit per-model `thinkingLevelMap`, see README § Model reference |
| Cache behavior | Opaque | Visible: cache anchors, retention, telemetry, diagnostics |
| Source visibility | Closed | Fully readable TypeScript with deterministic tests |

## Intended use and fair-use boundary

Use this package if you want to investigate harness effects on Claude behavior on your own tasks, prefer Pi's minimal, customizable agent loop for day-to-day work, have Claude Code logged in locally, and want subscription-backed Claude access without running a proxy or configuring API-key billing.

Do **not** use this package with OpenClaw or similar API-capacity or arbitrage harnesses. It is not intended to convert a consumer subscription into a general replacement for paid Anthropic API usage. If your workload belongs on the API, use the API and pay for it.

The implementation aims to keep subscription quota and upstream cost in check. Native requests include prompt-cache anchors, optional long-cache retention where supported, local token and cache telemetry, and cache-break diagnostics, so repeated Pi sessions reuse stable prefixes instead of wasting tokens through poor cache hygiene. These optimizations live in the Pi provider, are covered by deterministic tests, and are not a guarantee of identical behavior to Claude Code internals.

## Why a native Pi provider (and not a local proxy)

A native Pi integration is deliberately simpler and safer than a proxy-based bridge:

- No background daemon, local proxy, Python service, or port binding to install, monitor, or trust.
- Pi owns the provider registration, model metadata, thinking-level mapping, request conversion, and stream conversion.
- OAuth credentials are loaded only at request time from Claude Code's local credential store, and the native stream rejects non-`claude-subscription` routing before credential loading.
- Requests use OAuth-only Anthropic headers and intentionally omit `x-api-key`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` fallback behavior.
- Prompt/cache behavior is visible in source: system-block shaping, cache-control anchors, cache retention, telemetry, and diagnostics are all implemented in TypeScript with mocked tests.
- Streaming is parsed incrementally from the Anthropic response body and fails closed on malformed or out-of-order SSE lifecycle events before emitting final Pi assistant events.
- The package composes with Pi's normal customization surface: cache-retention options, user prompts, tools, and local extension configuration. Pi's `models.json` `modelOverrides` do not apply to this extension-registered provider; change `src/models.ts` (or fork the package) to alter its model metadata.

## Project principles

The project should continue to prefer:

- Measured, redacted evidence over anecdotes when discussing Claude Code, Opus, Sonnet, or Anthropic configuration changes.
- Minimal model-visible intervention: avoid prompt rewrites, hidden compaction, or tool filtering unless the behavior and token impact are measurable.
- Transparent quota hygiene: keep improving cache diagnostics, usage telemetry, and repeatable live verification runbooks without committing prompts, logs, or credentials.
- Compatibility through narrow shims: preserve only the Claude Code system-block shape and OAuth headers required by the route, while keeping Pi's own prompt and tool loop authoritative.
- Clear ethical boundaries: this package is for individual local subscription use — not for resale, pooled access, or avoiding API billing for workloads that belong on the API.
