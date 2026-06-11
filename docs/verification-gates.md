# Verification gates and drift checks

No live Anthropic calls: this package's deterministic suite must stay free of live Anthropic requests. Use fake credentials, static fixtures, and mocked network/transport boundaries unless a user explicitly requests an opt-in live check.

## Change-type gates

| Change type | Focused checks | Broader gate |
|---|---|---|
| Tool JSON parsing / SSE | `node --test --import tsx tests/tool-json-arguments.test.ts tests/anthropic-sse.test.ts tests/native-stream-simple.test.ts` | `npm run check` |
| Request headers/body/cache | `node --test --import tsx tests/native-request.test.ts tests/native-stream-simple.test.ts` | `npm run check` |
| Credentials/refresh/redaction | `node --test --import tsx tests/native-credentials.test.ts tests/redaction.test.ts tests/native-stream-simple.test.ts` | `npm run check` |
| Extension registration/provider guard | `node --test --import tsx tests/current-provider-system-shape.test.ts tests/package-manifest.test.ts` | `npm run check` |
| Dependency/model metadata | `node --test --import tsx tests/dependency-drift.test.ts tests/current-provider-system-shape.test.ts tests/native-request.test.ts` plus `npm run typecheck` | `npm run check` |
| Docs only | Link/path and wording checks relevant to the touched docs | `npm run typecheck` optional if code is untouched |

`npm run check` is the pre-PR gate for behavior, dependency, model, request, credential, stream, and package changes.

## Supply-chain drift policy

- Bump `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` together. They share private TypeScript members and provider contracts; drifting one without the other can compile against the wrong API surface.
- After changing either Pi package, rerun the dependency/model metadata gate above and re-check native request/tool-call assumptions: Pi-core `edit` schema, validation, `prepareArguments`, built-in Anthropic tool conversion, OAuth headers, and provider registration behavior.
- Keep `@types/node` on the declared Node floor (`~22.19.0`) so TypeScript cannot accidentally allow APIs outside `engines.node`.
- Treat lockfile updates as behavior changes unless they are clearly type-only/dev-only. Record why the upgrade is safe in `CHANGELOG.md`, `docs/current-status.md`, or the roadmap when provider/tool behavior may be affected.
- `tests/dependency-drift.test.ts` enforces an installed-vs-lockfile preflight: for every declared dependency it compares the version recorded in `package-lock.json` against the version actually present in `node_modules`. A stale install — for example a freshly added `dependencies` entry that was never `npm ci`-ed — fails this gate before `npm test` would otherwise die at import with `ERR_MODULE_NOT_FOUND`. When this gate fails, run `npm ci`.

## Runtime/API drift policy

- Treat Claude Code local binary/package findings as time-bound. If Claude Code changes materially, rerun bounded static extraction for headers, betas, tool schema, tool choice, identity, prompt caching, and Edit schema.
- Do not assume Claude Code's native `Edit` schema matches Pi-core's lowercase `edit` tool schema.
- Track Anthropic API changes to betas, thinking, `tool_choice`, cache-control breakpoints, stop reasons, and SSE event types through deterministic docs/source updates first.
- Live Anthropic checks are opt-in only. Do not commit live logs, raw provider payloads, credentials, Authorization/Bearer values, `.credentials.json` contents, prompts, or machine-specific outputs.

## Extraction artifact hygiene

When new static extraction is needed, keep artifacts outside the public package under ignored local paths such as `~/pi/tmp/drafts/<name>-<date>/`. Include enough metadata to make the claim reproducible without secrets: package/CLI versions, hashes, commands, target strings, claim ledger, and safety notes.
