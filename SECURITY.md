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

## Handling secrets

Never include real OAuth tokens, API keys, `.credentials.json` contents, or
log fragments containing `Authorization`, `Bearer`, `sk-…`, or
`anthropic-…` headers in reports, issues, pull requests, or commits. If a
report requires sample data, redact it first.

Security-sensitive invariants:

- Tests must use fake credentials/tokens and mocked network boundaries.
- The provider must not fall back to `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or `anthropic-api-key`.
- Errors should redact known secrets and bearer/header patterns before surfacing them.
