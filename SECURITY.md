# Security Policy

## Supported versions

This project is in early development. Only the latest commit on `main` is supported.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.** This package handles Claude Code OAuth credentials; a bug that leaks tokens, disables redaction, or removes the OAuth-only request guard should be reported privately.

Preferred channel: open a private report via GitHub Security Advisories at <https://github.com/5omeOtherGuy/minimalcc-pi/security/advisories/new>. If that is unavailable, contact the maintainer through the email on the maintainer's GitHub profile.

Include: description and impact, steps to reproduce or a minimal proof of concept, the commit SHA tested, and whether the issue is already disclosed elsewhere. Expect an acknowledgement within a few days; disclosure timelines are agreed case by case.

## Scope

In scope: repository code (`extensions/`, `src/`, `tests/`, workflows); credential loading, request construction, and SSE handling; any path that could log, transmit unexpectedly, or write OAuth tokens, API keys, or request payloads to disk.

Out of scope: upstream dependencies (`@earendil-works/pi-coding-agent`, Anthropic services, Claude Code, Node.js) and issues requiring an attacker who already has local code execution as the user running Pi.

## Threat model

This section documents the abuse cases the provider resists and the defenses that hold each one. Deterministic regression tests cover the boundaries that can be simulated without live calls or real credentials.

1. **Credential exfiltration.** Prompt injection or a tool may try to make the model reveal `.credentials.json`, environment variables, or request headers. Defense: credentials are loaded at request time and never placed in prompts, tool outputs, or diagnostics; surfaced errors run through redaction. The status/account commands report metadata only; `/claude-subscription-import` deliberately copies the credential blob to a local file the user can delete.
2. **Billing-route confusion.** Selecting the built-in `anthropic`, `custom-anthropic`, or another Claude provider could bill an API key or metered extra usage. Defense: the input guard, the `before_provider_request` fallback, and the native-stream provider assertion all run before credentials are loaded; non-`claude-subscription` routing is rejected.
3. **Outbound URL/token exfiltration.** A misconfigured base URL could receive the OAuth token. Defense: the Anthropic Messages URL is hardcoded and validated before fetch; there is no user-configurable request URL.
4. **Tool-output secret leakage.** Tool results and errors can contain paths, command output, or secrets. Defense: stream/transport diagnostics never store raw tool arguments or results; redaction covers known secrets and header/token patterns; slash-command summaries stay metadata-only.
5. **Malformed or malicious SSE.** Duplicate lifecycle frames, `tool_use` blocks missing id/name, non-object tool input, or unsupported stop reasons could corrupt state. Defense: the SSE parser and stream applier fail closed with redacted errors and drop executable-looking partial tool calls on failure.
6. **User-denied or policy-denied tool calls.** Recoverable tool errors must be relayed as tool results, not turned into provider crashes. Defense: the provider passes model-emitted arguments through unchanged and lets Pi-core own validation and permissions; it never mutates arguments to bypass validation.
7. **Destructive automation.** Defense: tests and diagnostics never run live tools, delete files, alter credentials, or commit/push; the deterministic suite uses fake credentials and mocked network boundaries.

## Handling secrets

Never include real OAuth tokens, API keys, `.credentials.json` contents, or log fragments containing `Authorization`, `Bearer`, `sk-…`, or `anthropic-…` headers in reports, issues, pull requests, or commits. If a report needs sample data, redact it first.

Security-sensitive invariants:

- Tests must use fake credentials/tokens and mocked network boundaries.
- The provider must not fall back to `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or `anthropic-api-key`.
- Errors must redact known secrets and header/token patterns before surfacing.
