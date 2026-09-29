import type { SkillEntry } from "@jagentdesk/protocol/native-skills";
import type { ComboboxOption } from "@/components/ui/combobox";
import {
  buildLegacyIdMap,
  normalizeSkillIds,
  partitionSkillsForProvider,
  type SkillProviderId,
} from "@/skills/native-skill-logic";

/** Option ids of skills the agent's provider cannot see ("Install for <provider>"). */
export const INSTALL_OPTION_PREFIX = "install:";

export interface SkillPickerModel {
  provider: SkillProviderId | null;
  options: ComboboxOption[];
  entriesById: Map<string, SkillEntry>;
  attachedIds: string[];
  /** Attached skills that still exist in the catalog (badge count). */
  attachedCount: number;
}

/**
 * Pure model of the composer Skills picker (spec 22.7): every enabled, valid
 * skill the provider reads is attachable; the rest get an install option.
 * Attached ids stored by older builds are mapped through `legacyId`.
 */
export function buildSkillPickerModel(input: {
  skills: readonly SkillEntry[];
  provider: SkillProviderId | null;
  rawAttachedIds: readonly string[];
  catalogReady: boolean;
}): SkillPickerModel {
  const { available, needsInstall } = partitionSkillsForProvider(input.skills, input.provider);
  const entriesById = new Map(input.skills.map((entry) => [entry.skillId, entry]));
  const attachedIds = normalizeSkillIds(input.rawAttachedIds, buildLegacyIdMap(input.skills));
  const options: ComboboxOption[] = [
    ...available.map((entry) => ({
      id: entry.skillId,
      label: entry.name,
      description: entry.description || undefined,
    })),
    ...needsInstall.map((entry) => ({
      id: `${INSTALL_OPTION_PREFIX}${entry.skillId}`,
      label: entry.name,
      description: entry.description || undefined,
    })),
  ];
  const attachedCount = input.catalogReady
    ? attachedIds.filter((id) => entriesById.has(id)).length
    : attachedIds.length;
  return { provider: input.provider, options, entriesById, attachedIds, attachedCount };
}
