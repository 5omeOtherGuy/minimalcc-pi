# minimalcc-pi index

Updated: 2026-05-24

## Purpose

Public Pi package that registers a native `claude-subscription` provider for Claude Code subscription/OAuth credentials.

The provider uses isolated native API id `claude-subscription-native`, builds Anthropic Messages requests directly, and reads or refreshes Claude Code credentials at request time. It does not require a local proxy, Python virtual environment, or background service.

## Start here

- `README.md` — public install, usage, configuration, safety, and development notes.
- `docs/current-status.md` — current implementation status, verification scope, and known limitations.
- `REPO_MAP.md` — architecture map, request flow, invariants, and component relationships.
- `docs/INDEX.md` — documentation index.

## Top-level files

- `.editorconfig` — baseline editor formatting rules.
- `.gitattributes` — line-ending normalization and GitHub diff hints.
- `.gitignore` — excludes runtime state, credentials, dependency caches, logs, and local config.
- `.nvmrc` — default Node.js major version for contributors/CI.
- `AGENTS.md` — agent operating guidelines for contributor workflow (worktree-per-task procedure, test policy).
- `CHANGELOG.md` — Keep a Changelog–format release history.
- `CONTRIBUTING.md` — contributor workflow and deterministic test expectations.
- `LICENSE` — MIT license.
- `package.json` — npm metadata, Pi package manifest, and test/typecheck scripts.
- `package-lock.json` — npm dependency lockfile.
- `README.md` — primary public documentation.
- `REPO_MAP.md` — repository map.
- `SECURITY.md` — security reporting and credential-handling expectations.
- `tsconfig.json` — TypeScript compiler settings for extension, source, and tests.

## Directories

- `.github/` — GitHub Actions workflows, Dependabot config, and community templates.
- `docs/` — current public documentation. See `docs/INDEX.md`.
- `extensions/` — Pi extension/provider entry point. See `extensions/INDEX.md`.
- `src/` — shared TypeScript constants, native provider helpers, SSE parser, and system-prompt shaping helpers. See `src/INDEX.md`.
- `tests/` — deterministic Node test suite using fake credentials and mocked network boundaries. See `tests/INDEX.md`.

## Common commands

```bash
npm ci
npm test
npm run typecheck
npm run check
```

## Documentation policy

Public docs should describe the package as installed by a third-party user. Live verification runbooks, one-off verification logs, and machine-specific setup notes belong outside tracked files in this repository.

## Local/generated state

Ignored local state includes `.runtime/`, `.local/`, `docs/internal/`, `scripts/local/`, `node_modules/`, `*.log`, `*.pid`, `.env*`, `.credentials.json`, and `.claude/`. Do not commit credentials or OAuth tokens.
