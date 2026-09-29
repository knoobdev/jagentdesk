import type { SkillEntry } from "@jagentdesk/protocol/native-skills";
import type { ComboboxOption } from "@/components/ui/combobox";
import {
  buildLegacyIdMap,
  normalizeSkillIds,
  type SkillProviderId,
} from "@/skills/native-skill-logic";
import { pickerFamilyChoices, skillFamilyKey } from "@/skills/skill-families";

/** Option ids of skills the agent's provider cannot see ("Install for <provider>"). */
export const INSTALL_OPTION_PREFIX = "install:";

export interface SkillPickerModel {
  provider: SkillProviderId | null;
  options: ComboboxOption[];
  entriesById: Map<string, SkillEntry>;
  attachedIds: string[];
  /** Option id (a copy's skillId) → every skillId of its family. */
  familyIdsByOptionId: Map<string, string[]>;
  /** Option ids whose family has an attached copy. */
  selectedOptionIds: Set<string>;
  /** Attached families that still exist in the catalog (badge count). */
  attachedCount: number;
}

/**
 * Pure model of the composer Skills picker (spec 22.6.1 + 22.7): one option per
 * skill family. The option sends the copy the agent's provider reads (the
 * primary when visible); a family no copy of which the provider reads gets an
 * install option. Attached ids stored by older builds are mapped through
 * `legacyId`.
 */
export function buildSkillPickerModel(input: {
  skills: readonly SkillEntry[];
  provider: SkillProviderId | null;
  rawAttachedIds: readonly string[];
  catalogReady: boolean;
}): SkillPickerModel {
  const choices = pickerFamilyChoices(input.skills, input.provider);
  const entriesById = new Map(input.skills.map((entry) => [entry.skillId, entry]));
  const attachedIds = normalizeSkillIds(input.rawAttachedIds, buildLegacyIdMap(input.skills));
  const attachedSet = new Set(attachedIds);
  const familyIdsByOptionId = new Map<string, string[]>();
  const selectedOptionIds = new Set<string>();
  const attachable: ComboboxOption[] = [];
  const installable: ComboboxOption[] = [];
  for (const { family, copy, needsInstall } of choices) {
    const ids = family.copies.map((entry) => entry.skillId);
    const option = {
      id: needsInstall ? `${INSTALL_OPTION_PREFIX}${copy.skillId}` : copy.skillId,
      label: family.name,
      description: family.primary.description || undefined,
    };
    familyIdsByOptionId.set(option.id, ids);
    if (needsInstall) {
      installable.push(option);
    } else {
      attachable.push(option);
      if (ids.some((id) => attachedSet.has(id))) selectedOptionIds.add(option.id);
    }
  }
  const attachedFamilies = new Set(
    attachedIds.flatMap((id) => {
      const entry = entriesById.get(id);
      return entry ? [skillFamilyKey(entry)] : [];
    }),
  );
  const attachedCount = input.catalogReady ? attachedFamilies.size : attachedIds.length;
  return {
    provider: input.provider,
    options: [...attachable, ...installable],
    entriesById,
    attachedIds,
    familyIdsByOptionId,
    selectedOptionIds,
    attachedCount,
  };
}
