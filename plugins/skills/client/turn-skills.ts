import type { BuiltinTurnPreparation } from "../../../packages/app/src/plugins/builtin/host-api";
import { allKnownSkills } from "./skills-store";
import { useAgentSkillsStore } from "./agent-skills-store";
import { buildLegacyIdMap, normalizeSkillIds, selectTurnSkillIds } from "./native-skill-logic";

/**
 * Skills on a send (spec 22.7, ADR-0022 decision 6). The app no longer injects
 * skill text: it passes `skillIds` with the message and the daemon prefixes the
 * provider's native invocation (`/name`, `$name`, `/skill:name`, …). Only the
 * skills the user attached are sent — there is no keyword auto-load (spec 22.7:
 * providers already pick native skills by description). Each skill is passed on
 * its first turn for an agent only.
 */

/**
 * Reads skill snapshots at send time, including queued sends. The host contributes this only
 * while Skills is on, so disabling Skills does not consume the attached ids.
 */
export function prepareTurnSkills(input: {
  serverId: string;
  agentId: string;
  text: string;
}): BuiltinTurnPreparation {
  const known = allKnownSkills();
  const agentSkills = useAgentSkillsStore.getState();
  const legacyMap = buildLegacyIdMap(known);
  const attachedIds = normalizeSkillIds(agentSkills.attached[input.agentId] ?? [], legacyMap);
  const skillIds = selectTurnSkillIds({
    attachedIds,
    alreadySentIds: agentSkills.injected[input.agentId] ?? [],
  });
  return {
    skillIds: skillIds.length > 0 ? skillIds : undefined,
    commit: () => {
      if (skillIds.length > 0) {
        useAgentSkillsStore.getState().markInjected(input.agentId, skillIds);
      }
    },
  };
}
