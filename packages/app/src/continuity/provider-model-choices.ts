import type { ProviderModelRef } from "@jagentdesk/protocol/messages";
import type { ProviderSnapshotEntry } from "@jagentdesk/protocol/agent-types";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { getAgentProviderDefinition } from "@jagentdesk/protocol/provider-manifest";

/** The Model field's value for "Default model": the protocol stores it as `model: null`. */
export const DEFAULT_MODEL_CHOICE = "";

export interface ProviderChoice {
  provider: string;
  label: string;
}

export interface ModelChoice {
  /** `DEFAULT_MODEL_CHOICE` for the provider's default model, otherwise the model id. */
  id: string;
  label: string;
}

function sameEntry(a: ProviderModelRef, b: ProviderModelRef): boolean {
  return a.provider === b.provider && (a.model ?? null) === (b.model ?? null);
}

/** A provider's built-in name, or its id when the manifest does not know it. */
export function providerDisplayLabel(provider: string): string {
  try {
    return getAgentProviderDefinition(provider).label;
  } catch {
    return provider;
  }
}

function providerLabel(entry: ProviderSnapshotEntry): string {
  return entry.label ?? providerDisplayLabel(entry.provider);
}

/**
 * The Provider field of "Add provider" (spec 40 §6): providers that are on and ready on the host,
 * except those already listed with their default model.
 */
export function addableProviders(
  entries: readonly ProviderSnapshotEntry[] | null | undefined,
  listed: readonly ProviderModelRef[],
): ProviderChoice[] {
  return (entries ?? [])
    .filter((entry) => entry.enabled && entry.status === "ready")
    .filter(
      (entry) => !listed.some((ref) => sameEntry(ref, { provider: entry.provider, model: null })),
    )
    .map((entry) => ({ provider: entry.provider, label: providerLabel(entry) }));
}

/** The Model field: "Default model" first, then the provider's selectable models not yet listed. */
export function addableModels(
  entry: ProviderSnapshotEntry | undefined,
  listed: readonly ProviderModelRef[],
  defaultLabel: string,
): ModelChoice[] {
  if (!entry) return [];
  const choices: ModelChoice[] = [{ id: DEFAULT_MODEL_CHOICE, label: defaultLabel }];
  for (const model of filterSelectableModels(entry.models ?? null) ?? []) {
    choices.push({ id: model.id, label: model.label });
  }
  return choices.filter(
    (choice) =>
      !listed.some((ref) =>
        sameEntry(ref, {
          provider: entry.provider,
          model: choice.id === DEFAULT_MODEL_CHOICE ? null : choice.id,
        }),
      ),
  );
}

export function toProviderModelRef(provider: string, modelChoice: string): ProviderModelRef {
  return { provider, model: modelChoice === DEFAULT_MODEL_CHOICE ? null : modelChoice };
}

/** A listed entry as its row reads it: the provider's and model's display names. */
export function describeProviderModel(
  ref: ProviderModelRef,
  entries: readonly ProviderSnapshotEntry[] | null | undefined,
  defaultLabel: string,
): { providerLabel: string; modelLabel: string } {
  const entry = entries?.find((candidate) => candidate.provider === ref.provider);
  const model = ref.model ? entry?.models?.find((candidate) => candidate.id === ref.model) : null;
  return {
    providerLabel: entry ? providerLabel(entry) : providerDisplayLabel(ref.provider),
    modelLabel: ref.model ? (model?.label ?? ref.model) : defaultLabel,
  };
}
