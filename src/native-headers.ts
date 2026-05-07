const ANTHROPIC_VERSION = "2023-06-01";
const BASE_ANTHROPIC_BETAS = [
  "oauth-2025-04-20",
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
] as const;
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";

export type NativeHeaderOptions = {
  fineGrainedToolStreaming?: boolean;
};

function anthropicBeta(options: NativeHeaderOptions = {}): string {
  return [
    ...BASE_ANTHROPIC_BETAS,
    ...(options.fineGrainedToolStreaming ? [FINE_GRAINED_TOOL_STREAMING_BETA] : []),
  ].join(",");
}

/**
 * Builds the HTTP request headers required for native Anthropic Messages API
 * calls authenticated with a Claude Code OAuth access token.
 *
 * - Sets `Authorization: Bearer <token>`.
 * - Sets JSON content type.
 * - Sets `anthropic-version` and `anthropic-beta`.
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
