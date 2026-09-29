import { beforeEach, describe, expect, it } from "vitest";
import { makeSkillEntry } from "@/test/skill-entry";
import { useAgentSkillsStore } from "@/stores/agent-skills-store";
import { useSkillsStore } from "@/stores/skills-store";
import { useSessionStore } from "@/stores/session-store";
import { buildSkillPickerModel, INSTALL_OPTION_PREFIX } from "./skill-picker-model";
import { prepareTurnSkills } from "./turn-skills";

const release = makeSkillEntry({
  name: "release-notes",
  description: "Write release notes from merged changes",
  owned: true,
  legacyId: "skl_release",
});
const kiroOnly = makeSkillEntry({
  name: "deploy-checklist",
  description: "Deployment checklist",
  visibleTo: ["kiro"],
});

function seedCatalog() {
  useSkillsStore.setState({
    serverId: "srv_1",
    catalogs: {
      "": { skills: [release, kiroOnly], written: null, status: "ready", error: null },
    },
  });
}

function seedAgent(provider: string) {
  const agents = new Map([["agent_1", { id: "agent_1", provider, cwd: "/repo" }]]);
  useSessionStore.setState({
    sessions: { srv_1: { agents } },
  } as unknown as Parameters<typeof useSessionStore.setState>[0]);
}

describe("prepareTurnSkills", () => {
  beforeEach(() => {
    seedCatalog();
    seedAgent("claude");
    useAgentSkillsStore.setState({ attached: {}, injected: {}, autoLoad: false });
  });

  it("passes attached skills by native id (legacy ids mapped) and only on the first turn", () => {
    useAgentSkillsStore.setState({ attached: { agent_1: ["skl_release"] } });
    const first = prepareTurnSkills({ serverId: "srv_1", agentId: "agent_1", text: "hi" });
    expect(first.skillIds).toEqual([release.skillId]);
    first.commit();
    const second = prepareTurnSkills({ serverId: "srv_1", agentId: "agent_1", text: "again" });
    expect(second.skillIds).toBeUndefined();
  });

  it("does not record skills as sent until commit", () => {
    useAgentSkillsStore.setState({ attached: { agent_1: [release.skillId] } });
    prepareTurnSkills({ serverId: "srv_1", agentId: "agent_1", text: "hi" });
    expect(useAgentSkillsStore.getState().injected.agent_1).toBeUndefined();
  });

  it("auto-loads keyword matches the provider can see, without a model call", () => {
    useAgentSkillsStore.setState({ autoLoad: true });
    const turn = prepareTurnSkills({
      serverId: "srv_1",
      agentId: "agent_1",
      text: "draft the release notes and the deploy checklist",
    });
    expect(turn.skillIds).toEqual([release.skillId]);
  });

  it("sends nothing when no skill is attached or matched", () => {
    expect(prepareTurnSkills({ serverId: "srv_1", agentId: "agent_1", text: "hi" }).skillIds).toBe(
      undefined,
    );
  });
});

describe("buildSkillPickerModel", () => {
  it("lists visible skills to attach and invisible ones with an install option", () => {
    const model = buildSkillPickerModel({
      skills: [release, kiroOnly],
      provider: "claude",
      rawAttachedIds: ["skl_release", "global:agents:removed"],
      catalogReady: true,
    });
    expect(model.options.map((option) => option.id)).toEqual([
      release.skillId,
      `${INSTALL_OPTION_PREFIX}${kiroOnly.skillId}`,
    ]);
    expect(model.attachedIds).toEqual([release.skillId, "global:agents:removed"]);
    expect(model.attachedCount).toBe(1);
  });

  it("counts every attached id while the catalog is still loading", () => {
    const model = buildSkillPickerModel({
      skills: [],
      provider: null,
      rawAttachedIds: ["a", "b"],
      catalogReady: false,
    });
    expect(model.attachedCount).toBe(2);
  });
});
