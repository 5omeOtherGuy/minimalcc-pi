import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getExtensionChangelogForDisplay, getExtensionChangelogOptions } from "../src/extension-changelog.ts";
import { formatNativeCacheDiagnosticsSummary } from "../src/native-cache-diagnostics.ts";
import {
  CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  MODELS,
} from "../src/models.ts";
import { formatNativeUsageSummary } from "../src/native-usage-telemetry.ts";
import { streamNativeClaudeSubscription } from "../src/native-stream-simple.ts";
import { shapeSystemBlocks, shouldShapePayload } from "../src/system-shape.ts";

const PROVIDER_ID = CLAUDE_SUBSCRIPTION_PROVIDER_ID;
const NATIVE_BASE_URL = "https://api.anthropic.com";
const DUMMY_API_KEY = "claude-code-oauth-loaded-at-runtime";
const BLOCKED_CLAUDE_PROVIDERS = new Set(["anthropic", "custom-anthropic", "meridian"]);

function shouldBlockClaudeProvider(provider: string | undefined): boolean {
  return !!provider && BLOCKED_CLAUDE_PROVIDERS.has(provider);
}

function blockedProviderMessage(provider: string | undefined): string {
  return `Blocked Claude provider '${provider}' to prevent accidental Anthropic API-key billing. `
    + `Use --provider ${PROVIDER_ID} with claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-6, claude-opus-4-7, or claude-opus-4-7-300k.`;
}

function unverifiedClaudeProviderMessage(): string {
  return `Unable to verify Claude provider after session reload; retry with --provider ${PROVIDER_ID}.`;
}

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("This extension ctx is stale after session replacement or reload");
}

function getContextProvider(ctx: { model?: { provider?: string } }): { provider?: string; verified: boolean } {
  try {
    return { provider: ctx.model?.provider, verified: true };
  } catch (error) {
    if (isStaleExtensionContextError(error)) return { verified: false };
    throw error;
  }
}

export default function claudeSubscriptionExtension(pi: ExtensionAPI) {
  pi.unregisterProvider("anthropic");

  pi.registerProvider(PROVIDER_ID, {
    name: "Claude subscription (Claude Code OAuth)",
    baseUrl: NATIVE_BASE_URL,
    apiKey: DUMMY_API_KEY,
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    models: MODELS as any,
    streamSimple: streamNativeClaudeSubscription,
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    if (!ctx.hasUI) return;

    try {
      const changelog = getExtensionChangelogForDisplay(getExtensionChangelogOptions(import.meta.url));
      if (changelog) ctx.ui.notify(changelog, "info");
    } catch {
      // Changelog display is best-effort and must not prevent provider registration.
    }
  });

  pi.on("input", (_event, ctx) => {
    const providerContext = getContextProvider(ctx);
    if (!providerContext.verified) {
      ctx.ui.notify(unverifiedClaudeProviderMessage(), "error");
      return { action: "handled" };
    }

    const provider = providerContext.provider;
    if (!shouldBlockClaudeProvider(provider)) return { action: "continue" };
    ctx.ui.notify(blockedProviderMessage(provider), "error");
    return { action: "handled" };
  });

  pi.on("before_provider_request", (event, ctx) => {
    const providerContext = getContextProvider(ctx);
    if (!providerContext.verified) {
      if (shouldShapePayload(event.payload)) throw new Error(unverifiedClaudeProviderMessage());
      return;
    }

    const provider = providerContext.provider;
    if (shouldBlockClaudeProvider(provider)) {
      throw new Error(blockedProviderMessage(provider));
    }

    if (provider !== PROVIDER_ID) return;
    if (!shouldShapePayload(event.payload)) return;
    return shapeSystemBlocks(event.payload);
  });

  pi.registerCommand("claude-subscription-usage", {
    description: "Show local Claude subscription token/cache telemetry for this process",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatNativeUsageSummary(), "info");
    },
  });

  pi.registerCommand("claude-subscription-cache-diagnostics", {
    description: "Show local Claude subscription prompt-cache diagnostics for this process",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatNativeCacheDiagnosticsSummary(), "info");
    },
  });

  pi.registerCommand("claude-subscription-status", {
    description: "Show local Claude subscription provider settings",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${PROVIDER_ID} uses native Anthropic Messages with Claude Code OAuth.`, "info");
    },
  });
}
