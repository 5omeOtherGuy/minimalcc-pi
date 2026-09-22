# minimalcc-pi index

Public Pi package that registers a native `claude-subscription` provider for Claude Code subscription/OAuth credentials. The provider uses the isolated native API id `claude-subscription-native`, builds Anthropic Messages requests directly, and reads or refreshes Claude Code credentials at request time. It does not require a local proxy, Python virtual environment, or background service.

## Start here

- [`README.md`](README.md) — install, usage, model reference, safety, development.
- [`docs/current-status.md`](docs/current-status.md) — implementation status, verification scope, known follow-ups.
- [`REPO_MAP.md`](REPO_MAP.md) — architecture, request flow, invariants, component relationships.
- [`docs/INDEX.md`](docs/INDEX.md) — documentation index.

## Top-level files

- `.editorconfig`, `.gitattributes` — editor/line-ending normalization.
- `.gitignore` — excludes runtime state, credentials, dependency caches, logs, and local config.
- `.nvmrc` — default Node.js version for contributors/CI.
- `AGENTS.md` — agent operating guidelines (worktree-per-task workflow, test policy).
- `CHANGELOG.md` — release history.
- `CONTRIBUTING.md` — contributor workflow and test expectations.
- `LICENSE` — MIT license.
- `package.json`, `package-lock.json` — npm metadata, Pi package manifest, scripts, and lockfile.
- `README.md` — primary public documentation.
- `REPO_MAP.md`, `INDEX.md` — repository and index maps.
- `SECURITY.md` — threat model and credential-handling expectations.
- `tsconfig.json` — TypeScript compiler settings.

## Directories

- `.github/` — CI workflows, Dependabot config, and community templates.
- `docs/` — public documentation. See [`docs/INDEX.md`](docs/INDEX.md).
- `extensions/` — Pi extension entry point. See [`extensions/INDEX.md`](extensions/INDEX.md).
- `src/` — provider modules. See [`src/INDEX.md`](src/INDEX.md).
- `tests/` — deterministic Node test suite. See [`tests/INDEX.md`](tests/INDEX.md).

## Common commands

```bash
npm ci
npm test
npm run typecheck
npm run check
```

## Local/generated state

Ignored local state includes `.runtime/`, `.local/`, `docs/internal/`, `scripts/local/`, `node_modules/`, `*.log`, `*.pid`, `.env*`, `.credentials.json`, and `.claude/`. Never commit credentials or OAuth tokens. Public docs describe the package as installed by a third-party user; live runbooks, one-off logs, and machine-specific notes belong outside tracked files.
