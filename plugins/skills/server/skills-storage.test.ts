import { describe, expect, it } from "vitest";
import { applySkillMutation, type Skill } from "@jagentdesk/protocol/skills";

function baseSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skl_test",
    name: "Test",
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
    ...overrides,
  };
}

describe("applySkillMutation", () => {
  it("bills a 👍 learn: +60 XP, +1 run/approval/consecutive, captures approved knowledge", () => {
    const [skill] = applySkillMutation(
      [baseSkill({ xp: 120, runs: 2, approvals: 2, consecutiveApprovals: 2 })],
      {
        op: "learn",
        id: "skl_test",
        entryId: "lrn_1",
        rating: "up",
        content: "prefer kubectl logs",
      },
    );
    expect(skill.xp).toBe(180);
    expect(skill.runs).toBe(3);
    expect(skill.approvals).toBe(3);
    expect(skill.consecutiveApprovals).toBe(3);
    expect(skill.learned).toHaveLength(1);
    expect(skill.learned[0]).toMatchObject({
      id: "lrn_1",
      source: "approved-answer",
      content: "prefer kubectl logs",
      approved: true,
    });
  });

  it("bills a 👎 learn: +15 XP, resets consecutive, captures no knowledge", () => {
    const [skill] = applySkillMutation(
      [baseSkill({ xp: 120, runs: 2, approvals: 2, consecutiveApprovals: 2 })],
      { op: "learn", id: "skl_test", entryId: "lrn_x", rating: "down", content: "nope" },
    );
    expect(skill.xp).toBe(135);
    expect(skill.runs).toBe(3);
    expect(skill.approvals).toBe(2);
    expect(skill.consecutiveApprovals).toBe(0);
    expect(skill.learned).toHaveLength(0);
  });

  it("forces progress to baseline on add (no client-injected XP)", () => {
    const [skill] = applySkillMutation([], {
      op: "add",
      skill: { ...baseSkill({ id: "skl_new", name: "  New  ", xp: 9999, runs: 50 }) },
    });
    expect(skill.id).toBe("skl_new");
    expect(skill.name).toBe("New");
    expect(skill.xp).toBe(0);
    expect(skill.runs).toBe(0);
    expect(skill.status).toBe("training");
  });

  it("resolve rejects (drops) a proposed entry and approves keeps it", () => {
    const withProposed = baseSkill({
      learned: [
        { id: "lrn_a", source: "proposed", content: "a", approved: false, at: 1 },
        { id: "lrn_b", source: "proposed", content: "b", approved: false, at: 2 },
      ],
    });
    const [rejected] = applySkillMutation([withProposed], {
      op: "resolve",
      id: "skl_test",
      entryId: "lrn_a",
      approve: false,
    });
    expect(rejected.learned.map((l) => l.id)).toEqual(["lrn_b"]);
    const [approved] = applySkillMutation([withProposed], {
      op: "resolve",
      id: "skl_test",
      entryId: "lrn_b",
      approve: true,
    });
    expect(approved.learned.find((l) => l.id === "lrn_b")?.approved).toBe(true);
  });

  it("graduate flips status", () => {
    const [skill] = applySkillMutation([baseSkill()], { op: "graduate", id: "skl_test" });
    expect(skill.status).toBe("graduated");
  });
});
