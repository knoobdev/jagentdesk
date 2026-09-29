import { describe, expect, it } from "vitest";
import type { SkillEntry } from "@jagentdesk/protocol/native-skills";
import { makeSkillEntry } from "@/test/skill-entry";
import { DEFAULT_INSTALLED_FILTERS } from "./native-skill-logic";
import {
  copiesDiffer,
  filterSkillFamilies,
  groupSkillFamilies,
  pickerFamilyChoices,
  pickPrimaryCopy,
  toggleFamilyAttachment,
} from "./skill-families";

function copy(
  name: string,
  dir: NonNullable<SkillEntry["dir"]>,
  partial: Partial<SkillEntry> = {},
): SkillEntry {
  return makeSkillEntry({
    name,
    dir,
    skillId: `${partial.scope ?? "global"}:${dir}:${name}`,
    realPath: `/home/u/.${dir}/skills/${name}`,
    ...partial,
  });
}

describe("groupSkillFamilies (spec 22.6.1)", () => {
  it("groups copies by name within a scope, one family per name", () => {
    const families = groupSkillFamilies([
      copy("pdf", "claude", { visibleTo: ["claude", "opencode"] }),
      copy("pdf", "agents", { visibleTo: ["codex", "opencode"] }),
      copy("pdf", "kiro", { visibleTo: ["kiro"] }),
      copy("pdf", "agents", {
        scope: "project",
        projectRoot: "/repo",
        skillId: "project:agents:pdf",
      }),
      copy("docx", "claude"),
    ]);
    expect(families.map((family) => [family.scope, family.name, family.copies.length])).toEqual([
      ["project", "pdf", 1],
      ["global", "docx", 1],
      ["global", "pdf", 3],
    ]);
    const pdf = families[2]!;
    expect(pdf.primary.skillId).toBe("global:agents:pdf");
    expect(pdf.copies.map((entry) => entry.dir)).toEqual(["agents", "claude", "kiro"]);
    expect(pdf.visibleTo).toEqual(["claude", "codex", "opencode", "kiro"]);
  });

  it("primary: owned copy first, else agents, then claude, then the 22.3 table order", () => {
    const agents = copy("x", "agents");
    const claude = copy("x", "claude");
    const cursor = copy("x", "cursor");
    const codex = copy("x", "codex");
    expect(pickPrimaryCopy([claude, cursor, agents]).skillId).toBe(agents.skillId);
    expect(pickPrimaryCopy([cursor, claude]).skillId).toBe(claude.skillId);
    expect(pickPrimaryCopy([cursor, codex]).skillId).toBe(codex.skillId);
    const ownedCursor = { ...cursor, owned: true };
    expect(pickPrimaryCopy([agents, claude, ownedCursor]).skillId).toBe(cursor.skillId);
  });

  it("flags 'Copies differ' only when two known content hashes differ", () => {
    const a = copy("x", "agents", { contentHash: "sha256:aa" });
    const b = copy("x", "claude", { contentHash: "sha256:aa" });
    const c = copy("x", "kiro", { contentHash: "sha256:bb" });
    const unknown = copy("x", "cursor", { contentHash: null });
    expect(copiesDiffer([a, b])).toBe(false);
    expect(copiesDiffer([a, b, c])).toBe(true);
    expect(copiesDiffer([a, unknown])).toBe(false);
    expect(groupSkillFamilies([a, c])[0]!.contentDiffers).toBe(true);
  });

  it("keeps a family with all its copies when any copy matches the filters", () => {
    const families = groupSkillFamilies([
      copy("pdf", "agents", { visibleTo: ["codex"] }),
      copy("pdf", "kiro", { visibleTo: ["kiro"] }),
      copy("docx", "agents", { visibleTo: ["codex"] }),
    ]);
    const kiro = filterSkillFamilies(families, { ...DEFAULT_INSTALLED_FILTERS, provider: "kiro" });
    expect(kiro.map((family) => family.name)).toEqual(["pdf"]);
    expect(kiro[0]!.copies).toHaveLength(2);
  });
});

describe("pickerFamilyChoices (spec 22.6.1 + 22.7)", () => {
  const agentsPdf = copy("pdf", "agents", { visibleTo: ["codex", "cursor"] });
  const claudePdf = copy("pdf", "claude", { visibleTo: ["claude", "cursor"] });
  const kiroOnly = copy("steer", "kiro", { visibleTo: ["kiro"] });

  it("offers one option per family, sending the copy the provider reads", () => {
    const claude = pickerFamilyChoices([agentsPdf, claudePdf, kiroOnly], "claude");
    expect(
      claude.map((choice) => [choice.family.name, choice.copy.skillId, choice.needsInstall]),
    ).toEqual([
      ["pdf", claudePdf.skillId, false],
      ["steer", kiroOnly.skillId, true],
    ]);
    const cursor = pickerFamilyChoices([agentsPdf, claudePdf], "cursor");
    expect(cursor[0]!.copy.skillId).toBe(agentsPdf.skillId);
  });

  it("uses the primary copy without a provider and skips unusable copies", () => {
    const disabled = { ...agentsPdf, enabled: false };
    const choices = pickerFamilyChoices([disabled, claudePdf], null);
    expect(choices).toHaveLength(1);
    expect(choices[0]!.copy.skillId).toBe(claudePdf.skillId);
    expect(pickerFamilyChoices([agentsPdf, claudePdf], null)[0]!.copy.skillId).toBe(
      agentsPdf.skillId,
    );
  });

  it("toggles a family: attaching one copy, detaching every copy", () => {
    const family = [agentsPdf.skillId, claudePdf.skillId];
    expect(toggleFamilyAttachment(["other"], claudePdf.skillId, family)).toEqual([
      "other",
      claudePdf.skillId,
    ]);
    expect(toggleFamilyAttachment(["other", agentsPdf.skillId], claudePdf.skillId, family)).toEqual(
      ["other"],
    );
  });
});
