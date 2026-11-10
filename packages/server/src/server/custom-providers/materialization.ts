import type { ApiProviderModel, ApiProtocol } from "./types.js";

export interface OpenCodeProviderInjection {
  /** The provider id used as the key under the OpenCode `provider` config block. */
  id: string;
  config: Record<string, unknown>;
}

export interface MaterializedEndpoint {
  apiKey: string | null;
  baseUrl: string;
}

/**
 * The OpenCode v2 provider definition for one API provider (spec 34.3): an
 * `@ai-sdk/openai-compatible` provider with baseURL + apiKey and the model list;
 * each thinking option becomes a model variant carrying `reasoningEffort` =
 * the option id.
 */
export function buildOpenCodeProviderConfig(
  record: { label: string; protocol: ApiProtocol; models: ApiProviderModel[] },
  endpoint: MaterializedEndpoint,
): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const model of record.models) {
    const variants =
      model.thinkingOptions && model.thinkingOptions.length > 0
        ? Object.fromEntries(
            model.thinkingOptions.map((option) => [option.id, { reasoningEffort: option.id }]),
          )
        : undefined;
    models[model.id] = {
      name: model.label,
      ...(variants ? { variants } : {}),
    };
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: record.label,
    options: {
      baseURL: endpoint.baseUrl,
      ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
    },
    models,
  };
}

/** Claude Code spawn env for an Anthropic-compatible endpoint (spec 34.3). */
export function buildClaudeSpawnEnv(endpoint: MaterializedEndpoint): Record<string, string> | null {
  return {
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    ...(endpoint.apiKey ? { ANTHROPIC_AUTH_TOKEN: endpoint.apiKey } : {}),
  };
}

/**
 * Merges one provider injection into an inherited OPENCODE_CONFIG_CONTENT value,
 * keeping every other key of the user's config (spec 34.3: never overwrite the
 * user's other providers, never write global files).
 */
export function mergeOpenCodeConfigContent(
  inherited: string | undefined,
  injection: OpenCodeProviderInjection,
): string {
  let parsed: Record<string, unknown> = {};
  if (inherited) {
    try {
      const value: unknown = JSON.parse(inherited);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = { ...(value as Record<string, unknown>) };
      }
    } catch {
      // An inherited non-JSON value cannot be merged; start from an empty object.
    }
  }
  const providers = { ...(parsed["provider"] as Record<string, unknown> | undefined) };
  providers[injection.id] = injection.config;
  parsed["provider"] = providers;
  return JSON.stringify(parsed);
}
