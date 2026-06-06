# Security Policy

## Supported versions

This project is in early development. Only the latest commit on `main` is
supported. There are currently no LTS or backport branches.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

This package handles Claude Code OAuth credentials. A bug that leaks tokens,
disables credential redaction, or removes the OAuth-only request guard is a
security issue and should be reported privately.

Preferred channel:

1. Open a private report via **GitHub Security Advisories** at
   <https://github.com/5omeOtherGuy/minimalcc-pi/security/advisories/new>.

If GitHub Security Advisories is unavailable to you, you may instead contact
the maintainer through the email address listed on the maintainer's GitHub
profile.

When reporting, please include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, or a minimal proof of concept.
- The commit SHA you tested against.
- Whether the issue has already been disclosed elsewhere.

You should expect an initial acknowledgement within a few days. Coordinated
disclosure timelines will be agreed on a case-by-case basis depending on
severity and the availability of a fix.

## Scope

In scope:

- Code in this repository (`extensions/`, `src/`, `tests/`, workflows).
- The credential-loading, request-construction, and SSE-handling code paths.
- Any path that could cause OAuth tokens, API keys, or request payloads to
  be logged, transmitted unexpectedly, or written to disk.

Out of scope:

- Vulnerabilities in upstream dependencies (`@earendil-works/pi-coding-agent`,
  Anthropic services, Claude Code itself, Node.js). Please report those to the
  respective projects.
- Issues that require an attacker who already has local code execution as the
  user running Pi.

## Threat model

This section documents the abuse cases the provider is designed to resist and the
defenses that hold each one. Deterministic regression tests cover the boundaries
that can be simulated without live calls or real credentials.

1. **Credential exfiltration.** Prompt injection or a tool may try to make the
   model reveal `.credentials.json`, environment variables, or request headers.
   Defense: credentials are loaded at request time and never placed in prompts,
   tool outputs, or diagnostics; local diagnostics store metadata only and never
   raw payloads. Surfaced errors run through redaction.
2. **Billing-route confusion.** Selecting the built-in `anthropic`,
   `custom-anthropic`, or another Claude provider could bill an API key or
   metered extra usage. Defense: the input guard, the `before_provider_request`
   fallback, and a native-stream provider assertion all run before credentials
   are loaded; non-`claude-subscription` routing is blocked.
3. **Outbound URL/token exfiltration.** A misconfigured base URL could receive
   the OAuth Bearer token. Defense: the Anthropic Messages URL is hardcoded and
   validated before fetch; there is no user-configurable request URL.
4. **Tool-output secret leakage.** Tool results and errors can contain paths,
   command output, or secrets. Defense: provider diagnostics never store tool
   arguments or results; redaction covers known secrets and bearer/header
   patterns; slash-command summaries stay metadata-only.
5. **Malformed or malicious SSE.** Duplicate lifecycle frames, `tool_use`
   missing id/name, non-object tool input, or unsupported stop reasons could
   corrupt state. Defense: the SSE parser and stream applier fail closed with
   redacted errors and drop executable-looking partial tool calls on failure.
6. **User-denied or policy-denied tool calls.** Recoverable tool errors must be
   relayed as tool results, not turned into provider crashes. Defense: the
   provider passes valid model-emitted arguments through unchanged and lets
   Pi-core own tool validation and permissions; it never mutates arguments to
   bypass validation.
7. **Destructive automation.** Defense: tests and diagnostics never run live
   tools, delete files, alter credentials, or commit/push; the deterministic
   suite uses fake credentials and mocked network boundaries.

## Handling secrets

Never include real OAuth tokens, API keys, `.credentials.json` contents, or
log fragments containing `Authorization`, `Bearer`, `sk-…`, or
`anthropic-…` headers in reports, issues, pull requests, or commits. If a
report requires sample data, redact it first.

Security-sensitive invariants:

- Tests must use fake credentials/tokens and mocked network boundaries.
- The provider must not fall back to `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or `anthropic-api-key`.
- Errors should redact known secrets and bearer/header patterns before surfacing them.
