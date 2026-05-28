import { MESSAGE_BATCHES_300K_OUTPUT_BETA } from "./constants.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const BASE_ANTHROPIC_BETAS = [
  "oauth-2025-04-20",
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
] as const;
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";

export type NativeHeaderOptions = {
  fineGrainedToolStreaming?: boolean;
  /** Message Batches API only; streaming Messages requests keep synchronous output caps. */
  messageBatchesOutput300k?: boolean;
};

function anthropicBeta(options: NativeHeaderOptions = {}): string {
  return [
    ...BASE_ANTHROPIC_BETAS,
    ...(options.fineGrainedToolStreaming ? [FINE_GRAINED_TOOL_STREAMING_BETA] : []),
    ...(options.messageBatchesOutput300k ? [MESSAGE_BATCHES_300K_OUTPUT_BETA] : []),
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
