import type { SkillEntry } from "@jagentdesk/protocol/native-skills";

/** Test fixture: a native `SkillEntry` with neutral defaults (global, agents dir, not owned). */
export function makeSkillEntry(
  partial: Partial<SkillEntry> & Pick<SkillEntry, "name">,
): SkillEntry {
  const scope = partial.scope ?? "global";
  return {
    skillId: `${scope}:agents:${partial.name}`,
    description: `${partial.name} description`,
    scope,
    projectRoot: null,
    dir: "agents",
    realPath: `/home/u/.agents/skills/${partial.name}`,
    links: [],
    visibleTo: ["claude", "codex"],
    owned: false,
    enabled: true,
    status: "ok",
    invalidReason: null,
    source: { kind: "local", ref: null, revision: null },
    hasScripts: false,
    training: null,
    legacyId: null,
    ...partial,
  };
}
