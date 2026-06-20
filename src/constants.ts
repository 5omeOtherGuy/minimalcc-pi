export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
// Server-side refusal fallback (Fable 5 safety classifiers): on a policy
// decline the API retries the same request on the configured fallback model in
// one round trip, so the cached prompt prefix is never re-read client-side
// after the model switch. The header date is the earliest of the beta series
// and is authoritative as written; do not "correct" it to a newer date.
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-06-01";

export const DOC_ROUTING_PREFIXES = [
  "- When asked about:",
  "- When working on pi topics",
  "- Always read pi .md files",
];
