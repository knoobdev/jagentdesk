import { allKnownSkills } from "@/stores/skills-store";
import { useAgentSkillsStore } from "@/stores/agent-skills-store";
import {
  buildLegacyIdMap,
  normalizeSkillIds,
  selectTurnSkillIds,
} from "@/skills/native-skill-logic";

/**
 * Skills on a send (spec 22.7, ADR-0022 decision 6). The app no longer injects
 * skill text: it passes `skillIds` with the message and the daemon prefixes the
 * provider's native invocation (`/name`, `$name`, `/skill:name`, …). Only the
 * skills the user attached are sent — there is no keyword auto-load (spec 22.7:
 * providers already pick native skills by description). Each skill is passed on
 * its first turn for an agent only.
 */

export interface TurnSkills {
  /** Ids to send with this message; undefined when none. */
  skillIds: string[] | undefined;
  /** Record the ids as invoked — call once the daemon accepted the message. */
  commit: () => void;
}

/**
 * Reads store snapshots at send time — no React deps, so every send path can use
 * it. `serverId` and `text` are accepted for call-site stability; the selection
 * no longer depends on them.
 */
export function prepareTurnSkills(input: {
  serverId?: string | null;
  agentId: string;
  text: string;
}): TurnSkills {
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
