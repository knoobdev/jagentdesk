import { describe, expect, it } from "vitest";
import { matchSkillsForQuery } from "./match-skills";
import type { Skill } from "@/stores/skills-store";

function mk(partial: Partial<Skill> & Pick<Skill, "id" | "name">): Skill {
  return {
    icon: "✦",
    description: "",
    instructions: "do the thing",
    tags: [],
    status: "training",
    xp: 0,
    runs: 0,
    approvals: 0,
    consecutiveApprovals: 0,
    examples: [],
    learned: [],
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

const k8s = mk({
  id: "a",
  name: "K8s Doctor",
  description: "Diagnoses pod crashes from logs",
  tags: ["kubernetes", "logs", "triage"],
});
const reviewer = mk({
  id: "b",
  name: "PR Reviewer",
  description: "Reviews a diff for bugs",
  tags: ["review", "quality"],
});
const skills = [k8s, reviewer];

describe("matchSkillsForQuery", () => {
  it("returns nothing for blank or stopword-only text", () => {
    expect(matchSkillsForQuery(skills, "")).toEqual([]);
    expect(matchSkillsForQuery(skills, "how can you help")).toEqual([]);
  });

  it("matches on a tag keyword", () => {
    expect(matchSkillsForQuery(skills, "check the kubernetes pod")).toEqual([k8s]);
  });

  it("matches on a name word", () => {
    expect(matchSkillsForQuery(skills, "please review this")).toEqual([reviewer]);
  });

  it("matches on a description word", () => {
    expect(matchSkillsForQuery(skills, "there are bugs in my code")).toEqual([reviewer]);
  });

  it("ranks a stronger (tag) match ahead of a weaker (description) match", () => {
    const logsSkill = mk({ id: "c", name: "Log Tailer", tags: ["logs"] });
    const mentionsLogs = mk({ id: "d", name: "Misc", description: "also reads logs sometimes" });
    const result = matchSkillsForQuery([mentionsLogs, logsSkill], "show me the logs");
    expect(result.map((s) => s.id)).toEqual(["c", "d"]);
  });

  it("is deterministic and excludes non-matching skills", () => {
    const result = matchSkillsForQuery(skills, "kubernetes review");
    expect(result).toHaveLength(2);
    // Both skills match one tag each (weight 3); tie breaks on name.
    expect(result.map((s) => s.id)).toEqual([k8s.id, reviewer.id]);
  });
});
