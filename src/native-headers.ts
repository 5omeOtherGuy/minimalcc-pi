import { MESSAGE_BATCHES_300K_OUTPUT_BETA, SERVER_SIDE_FALLBACK_BETA } from "./constants.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const BASE_ANTHROPIC_BETAS = [
  "oauth-2025-04-20",
  "claude-code-20250219",
] as const;
// Manual-budget thinking (thinking.type === "enabled": Haiku 4.5, Sonnet 4.6,
// Opus 4.6) needs this beta to interleave thinking with tool use. Adaptive
// thinking models (Opus 4.7+/Fable 5) imply interleaved thinking server-side,
// so they omit it. Headers do not participate in the prompt-cache prefix, so
// driving this per request keeps the surface re-verified at each model launch
// as small as the models that actually depend on it.
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
export type NativeHeaderOptions = {
  /** Message Batches API only; streaming Messages requests keep synchronous output caps. */
  messageBatchesOutput300k?: boolean;
  /** Set when the payload carries a `fallbacks` array (Fable 5 refusal fallback). */
  serverSideFallback?: boolean;
  /** Set for manual-budget thinking models (`thinking.type === "enabled"`). */
  interleavedThinking?: boolean;
};

function anthropicBeta(options: NativeHeaderOptions = {}): string {
  return [
    ...BASE_ANTHROPIC_BETAS,
    ...(options.interleavedThinking ? [INTERLEAVED_THINKING_BETA] : []),
    ...(options.messageBatchesOutput300k ? [MESSAGE_BATCHES_300K_OUTPUT_BETA] : []),
    ...(options.serverSideFallback ? [SERVER_SIDE_FALLBACK_BETA] : []),
  ].join(",");
}

/**
 * Builds the HTTP request headers required for native Anthropic API calls
 * authenticated with a Claude Code OAuth access token.
 *
 * - Sets `Authorization: Bearer <token>`.
 * - Sets JSON content type.
 * - Sets `anthropic-version` and `anthropic-beta`.
 * - Can opt into the Message Batches-only 300k output beta.
 * - Never includes `x-api-key` (OAuth lane, not API-key billing lane).
 */
export function buildNativeHeaders(
  accessToken: string,
  options: NativeHeaderOptions = {},
): Record<string, string> {
  if (accessToken.trim().length === 0) {
    throw new Error("Claude Code OAuth access token is missing. Run Claude Code login.");
  }

  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": anthropicBeta(options),
  };
}
