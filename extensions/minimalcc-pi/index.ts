import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  formatClaudeSubscriptionCredentialDiagnostics,
  importClaudeCodeCredentials,
  switchClaudeCodeCredentialAccount,
  type CredentialCommandResult,
  type CredentialDiagnostics,
} from "../../src/credential-accounts.ts";
import { getExtensionChangelogForDisplay, getExtensionChangelogOptions } from "../../src/extension-changelog.ts";
import {
  CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  MODELS,
} from "../../src/models.ts";
import { streamNativeClaudeSubscription } from "../../src/native-stream-simple.ts";
import { shapeSystemBlocks, shouldShapePayload } from "../../src/system-shape.ts";

const PROVIDER_ID = CLAUDE_SUBSCRIPTION_PROVIDER_ID;
const NATIVE_BASE_URL = "https://api.anthropic.com";
const DUMMY_API_KEY = "claude-code-oauth-loaded-at-runtime";
const BLOCKED_CLAUDE_PROVIDERS = new Set(["anthropic", "custom-anthropic", "meridian"]);

type SelectAccount = (title: string, options: string[]) => Promise<string | undefined>;

type ClaudeSubscriptionExtensionDependencies = {
  formatCredentialDiagnostics?: () => Promise<CredentialDiagnostics>;
  switchCredentialAccount?: (select: SelectAccount) => Promise<CredentialCommandResult>;
  importCredentials?: (select: SelectAccount) => Promise<CredentialCommandResult>;
};

function activeProviderDiagnostic(ctx: { model?: { provider?: string } }): string {
  return ctx.model?.provider ? `active_provider=${ctx.model.provider}` : "active_provider=none";
}

function providerStatusMessage(ctx: { model?: { provider?: string } }, diagnostics: CredentialDiagnostics): string {
  return [
    `${PROVIDER_ID} uses native Anthropic Messages with Claude Code OAuth on native API ${CLAUDE_SUBSCRIPTION_NATIVE_API_ID}.`,
    activeProviderDiagnostic(ctx),
    diagnostics.message,
  ].join("\n");
}

function shouldBlockClaudeProvider(provider: string | undefined): boolean {
  return !!provider && BLOCKED_CLAUDE_PROVIDERS.has(provider);
}

function blockedProviderMessage(provider: string | undefined): string {
  return `Blocked Claude provider '${provider}' to prevent accidental Anthropic API-key billing. `
    + `Use --provider ${PROVIDER_ID} with one of: ${MODELS.map((model) => model.id).join(", ")}.`;
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

export default function claudeSubscriptionExtension(
  pi: ExtensionAPI,
  dependencies: ClaudeSubscriptionExtensionDependencies = {},
) {
  pi.unregisterProvider("anthropic");

  pi.registerProvider(PROVIDER_ID, {
    name: "Claude subscription (Claude Code OAuth)",
    baseUrl: NATIVE_BASE_URL,
    apiKey: DUMMY_API_KEY,
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    models: [...MODELS],
    streamSimple: streamNativeClaudeSubscription,
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    const mode = (ctx as { mode?: string }).mode;
    if (mode !== undefined && mode !== "tui") return;
    if (!ctx.hasUI) return;

    try {
      const changelog = getExtensionChangelogForDisplay(getExtensionChangelogOptions(import.meta.url));
      if (changelog) ctx.ui.notify(changelog, "info");
    } catch {
      // Changelog display is best-effort and must not prevent provider registration.
    }
  });

  pi.on("input", (event, ctx) => {
    // Mid-stream steers and queued follow-ups belong to a turn whose provider already
    // passed this guard at idle prompt time; the provider cannot change mid-stream, so
    // re-checking only risks a duplicate block notification. Pi >= 0.77.0 (#5107) reports
    // this via InputEvent.streamingBehavior; our peerDependency range still includes older
    // Pi where the field is absent (undefined), in which case the guard runs as before.
    const streamingBehavior = (event as { streamingBehavior?: "steer" | "followUp" }).streamingBehavior;
    if (streamingBehavior !== undefined) return { action: "continue" };

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

  const formatCredentialDiagnostics = dependencies.formatCredentialDiagnostics ?? formatClaudeSubscriptionCredentialDiagnostics;
  const switchCredentialAccount = dependencies.switchCredentialAccount ?? switchClaudeCodeCredentialAccount;
  const importCredentials = dependencies.importCredentials ?? importClaudeCodeCredentials;

  pi.registerCommand("claude-subscription-status", {
    description: "Show Claude subscription provider, credential, and active-account diagnostics",
    handler: async (_args, ctx) => {
      const diagnostics = await formatCredentialDiagnostics();
      ctx.ui.notify(providerStatusMessage(ctx, diagnostics), diagnostics.level);
    },
  });

  pi.registerCommand("claude-subscription-accounts", {
    description: "Discover and select among Claude Code OAuth accounts for this provider",
    handler: async (_args, ctx) => {
      const result = await switchCredentialAccount((title, options) => ctx.ui.select(title, options));
      ctx.ui.notify(result.message, result.level);
    },
  });

  pi.registerCommand("claude-subscription-import", {
    description: "Import the selected Claude Code OAuth credentials into minimalcc-owned state",
    handler: async (_args, ctx) => {
      const result = await importCredentials((title, options) => ctx.ui.select(title, options));
      ctx.ui.notify(result.message, result.level);
    },
  });
}
