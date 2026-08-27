import { skillEffectivePrompt, useSkillsStore, type Skill } from "@/stores/skills-store";
import { useAgentSkillsStore } from "@/stores/agent-skills-store";
import { matchSkillsForQuery } from "@/skills/match-skills";

/**
 * Turning attached / auto-matched skills into agent context (redesign B3 + B5,
 * docs/plans/active/skills-redesign.md).
 *
 * The daemon has no "update system prompt" for a live agent and no per-message
 * system channel (see create_agent_request vs. update_agent_request in the
 * protocol). So skills reach an existing agent by prepending their effective
 * prompts to the outgoing message as a clearly delimited context block. Each
 * skill is delivered to a given agent only ONCE — after the first message it is
 * part of that agent's conversation history, so we don't repeat the preamble on
 * every turn.
 */

const PREAMBLE_HEADER =
  "The user has activated the following skills for you. Treat each block as " +
  "system guidance and apply it for the rest of this conversation.";

/** The message separator between the injected skills block and the user's text. */
export const SKILL_PREAMBLE_SEPARATOR = "\n\n---\n\n";

/** A single combined context block for the given skills, or "" when none. */
export function buildSkillsPreamble(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map((skill) => `## ${skill.name}\n${skillEffectivePrompt(skill)}`);
  return `${PREAMBLE_HEADER}\n\n${blocks.join("\n\n")}`;
}

export interface SkillInjectionInput {
  skills: Skill[];
  /** Skill ids the user manually attached to this agent. */
  attachedIds: readonly string[];
  /** Skill ids auto-matched for this message (empty when auto-load is off). */
  matchedIds: readonly string[];
  /** Skill ids already delivered to this agent on an earlier message. */
  alreadyInjectedIds: readonly string[];
}

export interface SkillInjection {
  /** The preamble to prepend (without separator); "" when nothing new to inject. */
  preamble: string;
  /** Skill ids delivered by this injection; caller records them as injected. */
  injectedIds: string[];
}

function dedupe(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

/**
 * Resolve which skills still need to be delivered to the agent and build their
 * preamble. Attached and auto-matched ids are unioned, then anything already
 * injected is dropped so each skill is sent at most once per agent.
 */
export function computeSkillInjection(input: SkillInjectionInput): SkillInjection {
  const wanted = dedupe([...input.attachedIds, ...input.matchedIds]);
  const already = new Set(input.alreadyInjectedIds);
  const newSkills = wanted
    .filter((id) => !already.has(id))
    .map((id) => input.skills.find((skill) => skill.id === id))
    .filter((skill): skill is Skill => Boolean(skill));
  return {
    preamble: buildSkillsPreamble(newSkills),
    injectedIds: newSkills.map((skill) => skill.id),
  };
}

/**
 * Apply an injection to outgoing text: prepend the preamble (if any). Kept pure
 * so the send path stays a one-liner.
 */
export function applySkillPreamble(text: string, preamble: string): string {
  return preamble ? `${preamble}${SKILL_PREAMBLE_SEPARATOR}${text}` : text;
}

/**
 * Prepend the effective prompts of the skills active on this agent (redesign
 * B3 + B5). Attached skills always count; auto-load also matches the message
 * text. Each skill is delivered once per agent (see computeSkillInjection).
 * Reads store snapshots at send time — no React deps needed, so it works from
 * both the composer and the cluster send paths.
 */
export function resolveSkillInjectedText(agentId: string, text: string): string {
  const skills = useSkillsStore.getState().skills;
  const agentSkills = useAgentSkillsStore.getState();
  const attachedIds = agentSkills.attached[agentId] ?? [];
  const matchedIds = agentSkills.autoLoad
    ? matchSkillsForQuery(skills, text).map((skill) => skill.id)
    : [];
  const injection = computeSkillInjection({
    skills,
    attachedIds,
    matchedIds,
    alreadyInjectedIds: agentSkills.injected[agentId] ?? [],
  });
  if (!injection.preamble) return text;
  agentSkills.markInjected(agentId, injection.injectedIds);
  return applySkillPreamble(text, injection.preamble);
}
