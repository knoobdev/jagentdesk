import { allKnownSkills } from "@/stores/skills-store";
import { useAgentSkillsStore } from "@/stores/agent-skills-store";
import { useSessionStore } from "@/stores/session-store";
import { matchSkillsForAutoLoad } from "@/skills/match-skills";
import {
  buildLegacyIdMap,
  normalizeSkillIds,
  partitionSkillsForProvider,
  resolveSkillProvider,
  selectTurnSkillIds,
} from "@/skills/native-skill-logic";

/**
 * Skills on a send (spec 22.7, ADR-0022 decision 6). The app no longer injects
 * skill text: it passes `skillIds` with the message and the daemon prefixes the
 * provider's native invocation (`/name`, `$name`, `/skill:name`, …). Attached
 * skills always count; auto-load adds keyword matches (no model call). Each
 * skill is passed on its first turn for an agent only.
 */

export interface TurnSkills {
  /** Ids to send with this message; undefined when none. */
  skillIds: string[] | undefined;
  /** Record the ids as invoked — call once the daemon accepted the message. */
  commit: () => void;
}

function agentProvider(serverId: string | null | undefined, agentId: string): string | null {
  if (!serverId) return null;
  return useSessionStore.getState().sessions[serverId]?.agents?.get(agentId)?.provider ?? null;
}

/** Reads store snapshots at send time — no React deps, so every send path can use it. */
export function prepareTurnSkills(input: {
  serverId?: string | null;
  agentId: string;
  text: string;
}): TurnSkills {
  const known = allKnownSkills();
  const agentSkills = useAgentSkillsStore.getState();
  const legacyMap = buildLegacyIdMap(known);
  const attachedIds = normalizeSkillIds(agentSkills.attached[input.agentId] ?? [], legacyMap);
  const provider = resolveSkillProvider(agentProvider(input.serverId, input.agentId));
  const matchedIds = agentSkills.autoLoad
    ? matchSkillsForAutoLoad(partitionSkillsForProvider(known, provider).available, input.text).map(
        (entry) => entry.skillId,
      )
    : [];
  const skillIds = selectTurnSkillIds({
    attachedIds,
    matchedIds,
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
