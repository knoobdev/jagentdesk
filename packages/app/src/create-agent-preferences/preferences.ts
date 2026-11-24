import { z } from "zod";
import { type AgentProvider } from "@jagentdesk/protocol/agent-types";

const optionsSchema = z.record(z.string(), z.json());

export interface ProviderPreferences {
  model?: string;
  mode?: string;
  thinkingByModel?: Record<string, string>;
  /** Last-used values of the provider's option controls, by option key. */
  options?: Record<string, unknown>;
}

// COMPAT(providerOptionControls): added in v0.15.0, remove after 2027-05-01. Preferences written
// before the rename stored the same record as `featureValues`.
function renameLegacyFeatureValues(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("featureValues" in value)) return value;
  const { featureValues, ...rest } = value as { featureValues: unknown } & Record<string, unknown>;
  return "options" in rest ? rest : { ...rest, options: featureValues };
}

export interface FavoriteModelPreference {
  provider: string;
  modelId: string;
}

export interface FavoriteModelRow {
  favoriteKey: string;
  provider: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  description?: string;
}

const providerPreferencesSchema: z.ZodType<ProviderPreferences> = z.preprocess(
  renameLegacyFeatureValues,
  z.strictObject({
    model: z.string().optional(),
    mode: z.string().optional(),
    thinkingByModel: z.record(z.string(), z.string()).optional(),
    options: optionsSchema.optional(),
  }),
);

// COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Codex took `fast_mode`
// before `service_tier`; the daemon converts the option on every agent and profile it touches,
// and this is the one place the app reads a remembered value without the daemon in between. Keyed
// on the built-in provider id: a custom provider extending Codex keeps the old key and the daemon
// still converts it on create.
function convertLegacyCodexOptions(
  preferences: Record<string, ProviderPreferences>,
): Record<string, ProviderPreferences> {
  const codex = preferences.codex;
  if (!codex?.options || !("fast_mode" in codex.options)) return preferences;
  const { fast_mode: legacy, ...rest } = codex.options;
  const options =
    "service_tier" in rest || typeof legacy !== "boolean"
      ? rest
      : { ...rest, service_tier: legacy ? "fast" : "default" };
  return { ...preferences, codex: { ...codex, options } };
}

export const FormPreferencesSchema = z.strictObject({
  provider: z.string().optional(),
  providerPreferences: z
    .record(z.string(), providerPreferencesSchema)
    .transform(convertLegacyCodexOptions)
    .optional(),
  // COMPAT(agentProfileFavoriteMigration): favourites were removed in v0.3.2.
  // Keep the legacy payload alive until every capable host has had a chance to
  // import it; ordinary preference writes must not erase it first.
  favoriteModels: z
    .array(
      z.strictObject({
        provider: z.string(),
        modelId: z.string(),
      }),
    )
    .optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
  // What the New workspace composer submits to: the chat agent (default) or a
  // terminal profile. See `@/new-workspace-launch` for resolution/fallback.
  launchTarget: launchTargetSchema.optional(),
}) satisfies z.ZodType<FormPreferences>;

const formPreferencesSchema = z.object({
  provider: z.string().optional(),
  providerPreferences: z.record(z.string(), providerPreferencesSchema).optional(),
  favoriteModels: z
    .array(
      z.object({
        provider: z.string(),
        modelId: z.string(),
      }),
    )
    .optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
});

export type FormPreferences = z.infer<typeof formPreferencesSchema>;

export const DEFAULT_FORM_PREFERENCES: FormPreferences = {};

export function parseFormPreferences(value: unknown): FormPreferences {
  const result = formPreferencesSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_FORM_PREFERENCES;
}

function mergeDefinedRecord<T>(
  existing: Record<string, T> | undefined,
  updates: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (updates === undefined) {
    return existing;
  }
  return {
    ...existing,
    ...updates,
  };
}

function applyProviderPreferenceUpdates(
  existing: ProviderPreferences,
  updates: Partial<ProviderPreferences>,
): ProviderPreferences {
  const next: ProviderPreferences = { ...existing };
  const nextThinkingByModel = mergeDefinedRecord(existing.thinkingByModel, updates.thinkingByModel);
  const nextOptions = mergeDefinedRecord(existing.options, updates.options);

  if (updates.model !== undefined) {
    next.model = updates.model;
  }
  if (updates.mode !== undefined) {
    next.mode = updates.mode;
  }
  if (nextThinkingByModel !== undefined) {
    next.thinkingByModel = nextThinkingByModel;
  }
  if (nextOptions !== undefined) {
    next.options = nextOptions;
  }

  return next;
}

export function mergeProviderPreferences(args: {
  preferences: FormPreferences;
  provider: AgentProvider;
  updates: Partial<ProviderPreferences>;
}): FormPreferences {
  const { preferences, provider, updates } = args;
  const existingProviderPreferences = preferences.providerPreferences ?? {};
  const existing = existingProviderPreferences[provider] ?? {};

  return {
    ...preferences,
    provider,
    providerPreferences: {
      ...existingProviderPreferences,
      [provider]: applyProviderPreferenceUpdates(existing, updates),
    },
  };
}

export function mergeCreateAgentSelectionPreferences(args: {
  preferences: FormPreferences;
  provider: AgentProvider | null;
  modelId?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  options?: Record<string, unknown>;
}): FormPreferences {
  if (!args.provider) {
    return args.preferences;
  }

  const modelId = args.modelId?.trim() ?? "";
  const modeId = args.modeId?.trim() ?? "";
  const thinkingOptionId = args.thinkingOptionId?.trim() ?? "";
  const options = optionsSchema.safeParse(args.options);

  return mergeProviderPreferences({
    preferences: args.preferences,
    provider: args.provider,
    updates: {
      model: modelId || undefined,
      mode: modeId || undefined,
      ...(modelId && thinkingOptionId ? { thinkingByModel: { [modelId]: thinkingOptionId } } : {}),
      ...(options.success ? { options: options.data } : {}),
    },
  });
}

export function applyAgentProfilePreferences(args: {
  preferences: FormPreferences;
  previousProvider: AgentProvider | null;
  previousProviderModeIds: readonly string[];
  provider: AgentProvider;
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  options: Record<string, unknown>;
}): FormPreferences {
  let next = args.preferences;
  if (args.previousProvider) {
    const previousMode = next.providerPreferences?.[args.previousProvider]?.mode;
    if (previousMode && !args.previousProviderModeIds.includes(previousMode)) {
      next = mergeProviderPreferences({
        preferences: next,
        provider: args.previousProvider,
        updates: { mode: null },
      });
    }
  }

  return mergeProviderPreferences({
    preferences: next,
    provider: args.provider,
    updates: {
      model: args.modelId || undefined,
      mode: args.modeId || null,
      ...(args.modelId && args.thinkingOptionId
        ? { thinkingByModel: { [args.modelId]: args.thinkingOptionId } }
        : {}),
      options: args.options,
    },
  });
}

export function buildFavoriteModelKey(input: FavoriteModelPreference): string {
  return `${input.provider}:${input.modelId}`;
}

export function isFavoriteModel(args: {
  preferences: FormPreferences;
  provider: string;
  modelId: string;
}): boolean {
  const favoriteKey = buildFavoriteModelKey({ provider: args.provider, modelId: args.modelId });
  return (args.preferences.favoriteModels ?? []).some(
    (favorite) => buildFavoriteModelKey(favorite) === favoriteKey,
  );
}

export function toggleFavoriteModel(args: {
  preferences: FormPreferences;
  provider: string;
  modelId: string;
}): FormPreferences {
  const favorite = { provider: args.provider, modelId: args.modelId };
  const favoriteKey = buildFavoriteModelKey(favorite);
  const existingFavorites = args.preferences.favoriteModels ?? [];
  const hasFavorite = existingFavorites.some(
    (entry) => buildFavoriteModelKey(entry) === favoriteKey,
  );

  return {
    ...args.preferences,
    favoriteModels: hasFavorite
      ? existingFavorites.filter((entry) => buildFavoriteModelKey(entry) !== favoriteKey)
      : [...existingFavorites, favorite],
  };
}
