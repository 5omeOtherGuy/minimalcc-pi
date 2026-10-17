import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import { loadActiveClaudeCodeCredentials } from "./credential-accounts.ts";
import { buildNativeHeaders } from "./native-headers.ts";
import {
  CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
  MODELS,
} from "./models.ts";
import { isRecord } from "./type-guards.ts";

export const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models";
const TIMEOUT_MS = 5_000;
const MAX_PAGES = 10;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type LoadToken = () => Promise<string>;

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function supported(value: unknown): boolean {
  return isRecord(value) && value.supported === true;
}

function mapModel(raw: unknown): ProviderModelConfig | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.startsWith("claude-") ||
    typeof raw.display_name !== "string" || !raw.display_name.trim() || raw.lifecycle === "retired") return;
  const known = MODELS.find((model) => model.id === raw.id);
  const contextWindow = positiveInteger(raw.max_input_tokens) ?? known?.contextWindow;
  const maxTokens = positiveInteger(raw.max_tokens) ?? known?.maxTokens;
  if (!contextWindow || !maxTokens) return;
  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : undefined;
  if (!known && !capabilities) return;
  const thinking = capabilities && isRecord(capabilities.thinking) ? capabilities.thinking : undefined;
  const types = thinking && isRecord(thinking.types) ? thinking.types : undefined;
  const adaptive = supported(types?.adaptive);
  // Native request handling for new models is known only for adaptive thinking.
  if (!known && !adaptive) return;
  const effort = capabilities && isRecord(capabilities.effort) ? capabilities.effort : undefined;
  if (!known && !effort) return;
  const supportedEffort = (level: string) => supported(effort?.[level]);
  const adaptiveMap = adaptive ? {
    ...(!supported(types?.disabled) ? { off: null } : {}),
    minimal: supportedEffort("low") ? "low" : null,
    low: supportedEffort("low") ? "low" : null,
    medium: supportedEffort("medium") ? "medium" : null,
    high: supportedEffort("high") ? "high" : null,
    xhigh: supportedEffort("xhigh") ? "xhigh" : null,
    max: supportedEffort("max") ? "max" : null,
  } as const : undefined;
  if (!known && adaptiveMap?.high !== "high") return;
  const reasoning = known?.reasoning ?? true;
  const thinkingLevelMap = known?.thinkingLevelMap ?? adaptiveMap;
  return {
    id: raw.id,
    api: CLAUDE_SUBSCRIPTION_NATIVE_API_ID,
    name: `${raw.display_name} (Claude Code subscription)`,
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(known && "compat" in known ? { compat: known.compat } : adaptive ? { compat: { forceAdaptiveThinking: true } } : {}),
    input: capabilities && capabilities.image_input !== undefined
      ? (supported(capabilities.image_input) ? ["text", "image"] : ["text"])
      : known ? [...known.input] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(maxTokens, contextWindow),
  };
}

export function createClaudeModelCatalog(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  loadToken: LoadToken = loadActiveClaudeCodeCredentials,
) {
  return async (context: RefreshModelsContext): Promise<ProviderModelConfig[]> => {
    if (!context.allowNetwork || context.signal.aborted) return [...MODELS];
    try {
      const token = await loadToken();
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
      const models: ProviderModelConfig[] = [];
      const ids = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(CLAUDE_MODELS_URL);
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("after_id", cursor);
        const response = await fetchImpl(url.href, { headers: buildNativeHeaders(token), signal });
        if (!response.ok) return [...MODELS];
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.data) || typeof payload.has_more !== "boolean") return [...MODELS];
        for (const entry of payload.data) {
          const mapped = mapModel(entry);
          if (mapped && !ids.has(mapped.id)) { models.push(mapped); ids.add(mapped.id); }
        }
        if (!payload.has_more) {
          // Preserve local selection aliases when their wire model is advertised.
          for (const local of MODELS) {
            if (ids.has(local.id)) continue;
            const nativeId = isRecord(local.compat) ? local.compat.nativeModelId : undefined;
            if (typeof nativeId === "string" && ids.has(nativeId)) models.push(local);
          }
          return models.length ? models : [...MODELS];
        }
        if (typeof payload.last_id !== "string" || !payload.last_id || payload.last_id === cursor) return [...MODELS];
        cursor = payload.last_id;
      }
    } catch {
      // Missing Claude Code login, OAuth denial, timeout, malformed JSON, or network failure.
    }
    return [...MODELS];
  };
}

export const refreshClaudeModels = createClaudeModelCatalog();
