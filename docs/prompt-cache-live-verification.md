# Prompt cache live verification runbook

This runbook verifies that native Claude subscription requests get real Anthropic prompt-cache reads after a warmup request.

> Historical note: the in-process `/claude-subscription-usage` and `/claude-subscription-cache-diagnostics` commands and their backing modules (`src/native-usage-telemetry.ts`, `src/native-cache-diagnostics.ts`) were removed in the ponytail-audit cleanup. The local-command and Node-harness steps below that import or read those modules no longer work as written; read Anthropic's `usage` (`cache_creation_input_tokens` / `cache_read_input_tokens`) directly from the stream's response/`done` events instead. The cache-anchor verification logic itself is unchanged.

Do not commit live logs. They may contain local paths, model IDs, response IDs, or usage patterns. The deterministic test suite remains mocked and must not make live Anthropic requests.

## Preconditions

- Claude Code OAuth credentials are available locally.
- The branch is installed or run from this checkout.
- You accept that this consumes Claude subscription quota.
- Use the same model, tools, system prompt, and user prompt shape for each turn.

## Deterministic checks first

```bash
npm test
npm run typecheck
git diff --check
```

These checks prove payload anchors, usage accounting, local telemetry, cache-break diagnostics, and no-live-request test boundaries.

## Live benchmark shape

Run at least two comparable requests in one session:

1. Warmup request: expect `cache_creation_input_tokens > 0` if Anthropic writes a cache entry.
2. Repeat request with the same stable prefix: expect `cache_read_input_tokens > 0`.
3. If cache reads drop, inspect local cache diagnostics for changed sections such as `system`, `tools`, `messages`, `cacheControl`, or `bodyConfig`.

Inside Pi, the local commands are:

- `/claude-subscription-usage` — shows in-process token/cache totals.
- `/claude-subscription-cache-diagnostics` — shows in-process cache-read drop diagnostics.

Recommended pass signal:

- Turn 1: `cacheWrite` is nonzero, or Anthropic otherwise reports cache creation.
- Turn 2+: `cacheRead` is nonzero for the same request shape.
- Final answer and tool-call behavior remain plausible for the task.

## Minimal local Node harness

This example uses the native provider directly and prints only token/cache usage and request fingerprints. It does not print prompts, tool arguments, OAuth tokens, or response text.

```bash
node --import tsx <<'EOF'
import { CLAUDE_SUBSCRIPTION_PROVIDER_ID, MODELS } from './src/models.ts';
import { streamNativeClaudeSubscription } from './src/native-stream-simple.ts';
import {
  formatNativeUsageSummary,
  getNativeUsageTelemetrySnapshot,
  resetNativeUsageTelemetry,
} from './src/native-usage-telemetry.ts';
import {
  getNativeCacheDiagnosticsSnapshot,
  resetNativeCacheDiagnostics,
} from './src/native-cache-diagnostics.ts';

const baseModel = MODELS.find((candidate) => candidate.id === (process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6')) ?? MODELS[0];
const model = { ...baseModel, provider: CLAUDE_SUBSCRIPTION_PROVIDER_ID, baseUrl: 'https://api.anthropic.com' };
const sessionId = `cache-live-${Date.now()}`;
const repeatedContext = {
  systemPrompt: [
    'Prompt-cache live verification. Answer briefly. Do not include secrets.',
    'Stable filler for cache threshold: ' + 'cache-stable-instruction '.repeat(1400),
  ].join('\n'),
  messages: [{ role: 'user', content: 'Reply with exactly: cache check ok', timestamp: Date.now() }],
  tools: [
    {
      name: 'cache_check_noop',
      description: 'No-op tool for stable schema cache benchmarking. Do not call unless explicitly asked.',
      parameters: { type: 'object', properties: { note: { type: 'string' } } },
    },
  ],
};

async function collect(stream) {
  for await (const event of stream) {
    if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'stream error');
  }
}

resetNativeUsageTelemetry();
resetNativeCacheDiagnostics();
for (let turn = 1; turn <= 2; turn++) {
  await collect(streamNativeClaudeSubscription(model, repeatedContext, { sessionId, maxTokens: 64 }));
  const last = getNativeUsageTelemetrySnapshot().records.at(-1);
  console.log(JSON.stringify({ turn, model: last?.model, usage: last?.usage, requestFingerprint: last?.requestFingerprint }));
}
console.log(formatNativeUsageSummary());
console.log(JSON.stringify({ cacheDiagnostics: getNativeCacheDiagnosticsSnapshot().events }));
EOF
```

## Interpreting failures

- `cacheRead` is always zero: verify prompt length is above Anthropic cache thresholds, cache anchors are present, and the same model/session/request shape is used.
- `cacheRead` drops after working: inspect diagnostic `changedSections`. Tool/schema, system, cache-control, or body-config churn can break cache reuse.
- API rejects cache fields: keep the failing request details local, redact secrets, and treat the feature as unsupported on this route until investigated.
