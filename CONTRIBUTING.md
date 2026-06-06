# Contributing

Thanks for your interest in contributing.

## Ground rules

- Never commit credentials, OAuth tokens, API keys, log fragments containing `Authorization` / `Bearer` headers, or anything from `.credentials.json`.
- Tests must remain deterministic: use fake credentials, fake tokens, and mocked network boundaries.
- Do not add live Anthropic/API calls to the repository test suite or documentation.
- Keep changes focused: one pull request, one concern.

## Development setup

Requirements:

- Node.js 22.19 or newer (`.nvmrc` contains the default version used by CI; matches Pi's `engines.node` floor of `>=22.19.0`).
- npm.

```bash
git clone https://github.com/5omeOtherGuy/minimalcc-pi.git
cd minimalcc-pi
npm ci
```

Useful checks:

```bash
npm test
npm run typecheck
npm run check
```

`npm run check` is the safe public gate: deterministic tests plus TypeScript type-checking. Focused gates by change type and supply-chain/runtime drift policy are documented in [`docs/verification-gates.md`](docs/verification-gates.md).

## Workflow

1. Create a topic branch off `main`.
2. Make the change and update deterministic tests when behavior changes.
3. Run `npm run check`.
4. Open a pull request against `main` and address CI failures.

## What to test

- Request construction, header shape, system-block shaping, credential loading, provider registration, and SSE parsing changes need deterministic coverage.
- Bug fixes should include a regression test that fails before the fix.
- Documentation-only changes can use the lightest useful verification, such as link/path and wording scans.
- Dependency/model metadata changes should run the focused drift gate from [`docs/verification-gates.md`](docs/verification-gates.md) and then `npm run check` before PR.

## Security issues

Do not include secrets in public issues or pull requests. See [`SECURITY.md`](SECURITY.md) for reporting and credential-handling expectations.
