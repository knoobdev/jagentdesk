import { describe, expect, it } from "vitest";
import type { SkillCatalogItem } from "@jagentdesk/protocol/native-skills";
import {
  buildLegacyIdMap,
  conciseLessonFrom,
  DEFAULT_INSTALLED_FILTERS,
  dedupeSkillEntries,
  filterCatalogItems,
  filterInstalledSkills,
  formatSkillSource,
  isScriptPath,
  normalizeSkillIds,
  partitionSkillsForProvider,
  presentProviders,
  presentSourceKinds,
  projectOptionsFromWorkspaces,
  resolveSkillProvider,
  selectTurnSkillIds,
  shortRevision,
  skillErrorCode,
  skillErrorMessage,
  trainingChecklist,
} from "./native-skill-logic";
import { makeSkillEntry as makeEntry } from "@/test/skill-entry";

function makeItem(partial: Partial<SkillCatalogItem> & Pick<SkillCatalogItem, "name">) {
  return {
    itemId: partial.name,
    kind: "skill",
    description: "",
    source: { kind: "official" },
    origin: "anthropics/skills",
    revision: null,
    files: [],
    hasScripts: false,
    body: null,
    provider: null,
    category: null,
    installCommand: null,
    installed: false,
    installedSkillId: null,
    invalidReason: null,
    ...partial,
  } as SkillCatalogItem;
}

describe("resolveSkillProvider", () => {
  it("keeps built-in skill providers and maps custom providers through extends", () => {
    expect(resolveSkillProvider("codex")).toBe("codex");
    expect(resolveSkillProvider("my-claude", { "my-claude": { extends: "claude" } })).toBe(
      "claude",
    );
  });

  it("returns null for generic ACP / unknown providers", () => {
    expect(resolveSkillProvider("my-acp", { "my-acp": { extends: "acp" } })).toBeNull();
    expect(resolveSkillProvider("trae")).toBeNull();
    expect(resolveSkillProvider(null)).toBeNull();
  });
});

describe("filterInstalledSkills", () => {
  const skills = [
    makeEntry({
      name: "zeta",
      visibleTo: ["kiro"],
      owned: true,
      source: { kind: "authored", ref: null, revision: null },
    }),
    makeEntry({ name: "alpha", scope: "project", projectRoot: "/repo" }),
    makeEntry({ name: "beta", description: "writes release notes" }),
  ];

  it("sorts project skills first, then by name", () => {
    expect(filterInstalledSkills(skills, DEFAULT_INSTALLED_FILTERS).map((s) => s.name)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  it("filters by provider visibility, scope, source, ownership and query", () => {
    const run = (patch: Partial<typeof DEFAULT_INSTALLED_FILTERS>) =>
      filterInstalledSkills(skills, { ...DEFAULT_INSTALLED_FILTERS, ...patch }).map((s) => s.name);
    expect(run({ provider: "kiro" })).toEqual(["zeta"]);
    expect(run({ scope: "project" })).toEqual(["alpha"]);
    expect(run({ source: "authored" })).toEqual(["zeta"]);
    expect(run({ ownership: "owned" })).toEqual(["zeta"]);
    expect(run({ ownership: "external" })).toEqual(["alpha", "beta"]);
    expect(run({ query: "RELEASE" })).toEqual(["beta"]);
  });

  it("derives the filter chips from the list", () => {
    expect(presentProviders(skills)).toEqual(["claude", "codex", "kiro"]);
    expect(presentSourceKinds(skills)).toEqual(["authored", "local"]);
  });
});

describe("partitionSkillsForProvider", () => {
  const skills = [
    makeEntry({ name: "both", visibleTo: ["claude", "codex"] }),
    makeEntry({ name: "kiro-only", visibleTo: ["kiro"] }),
    makeEntry({ name: "off", enabled: false }),
    makeEntry({ name: "broken", status: "invalid", invalidReason: "missing description" }),
  ];

  it("offers visible skills to attach and the rest to install for the provider", () => {
    const result = partitionSkillsForProvider(skills, "claude");
    expect(result.available.map((s) => s.name)).toEqual(["both"]);
    expect(result.needsInstall.map((s) => s.name)).toEqual(["kiro-only"]);
  });

  it("does not filter by visibility for an unknown provider", () => {
    const result = partitionSkillsForProvider(skills, null);
    expect(result.available.map((s) => s.name)).toEqual(["both", "kiro-only"]);
    expect(result.needsInstall).toEqual([]);
  });
});

describe("legacy ids", () => {
  it("maps legacy JSON ids to native skillIds, keeping unknown ids and order", () => {
    const skills = [makeEntry({ name: "release-captain", legacyId: "skl_abc" })];
    const map = buildLegacyIdMap(skills);
    expect(map).toEqual({ skl_abc: "global:agents:release-captain" });
    expect(
      normalizeSkillIds(["skl_abc", "project:agents:x", "global:agents:release-captain"], map),
    ).toEqual(["global:agents:release-captain", "project:agents:x"]);
  });

  it("dedupes merged catalogs by id, first one wins", () => {
    const a = makeEntry({ name: "a", description: "global view" });
    const aAgain = makeEntry({ name: "a", description: "project view" });
    expect(dedupeSkillEntries([[a], [aAgain]]).map((s) => s.description)).toEqual(["global view"]);
  });
});

describe("selectTurnSkillIds", () => {
  it("sends only attached ids (no auto-load) and drops the ones already invoked", () => {
    expect(
      selectTurnSkillIds({
        attachedIds: ["a", "b", "b"],
        alreadySentIds: ["a"],
      }),
    ).toEqual(["b"]);
  });
});

describe("training", () => {
  it("proposes the first sentence of the reply, on one line, capped", () => {
    expect(conciseLessonFrom("Run the tests first.\nThen   ship it.")).toBe("Run the tests first.");
    const long = conciseLessonFrom("x".repeat(400));
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
  });

  it("computes the graduation checklist from lock training state", () => {
    const ready = trainingChecklist({
      lessons: 4,
      approvals: 6,
      runs: 7,
      xp: 400,
      consecutiveApprovals: 3,
      status: "training",
    });
    expect(ready.canGraduate).toBe(true);
    const notYet = trainingChecklist({
      lessons: 0,
      approvals: 1,
      runs: 4,
      xp: 60,
      consecutiveApprovals: 1,
      status: "training",
    });
    expect(notYet.canGraduate).toBe(false);
    expect(notYet.items.map((item) => item.done)).toEqual([false, false, false]);
  });
});

describe("browse", () => {
  it("searches name, description and origin, sorted by name", () => {
    const items = [
      makeItem({ name: "pdf", description: "Read PDFs" }),
      makeItem({ name: "docx", origin: "openai/skills" }),
    ];
    expect(filterCatalogItems(items, "").map((i) => i.name)).toEqual(["docx", "pdf"]);
    expect(filterCatalogItems(items, "openai").map((i) => i.name)).toEqual(["docx"]);
    expect(filterCatalogItems(items, "pdfs").map((i) => i.name)).toEqual(["pdf"]);
  });

  it("flags scripts/ files", () => {
    expect(isScriptPath("scripts/run.sh")).toBe(true);
    expect(isScriptPath("SKILL.md")).toBe(false);
    expect(isScriptPath("references/scripts.md")).toBe(false);
  });
});

describe("errors and display", () => {
  it("reads the rpc error code and strips the client suffix", () => {
    const error = Object.assign(
      new Error(
        'A skill named "pdf" already exists. requestType=skills.install.request code=skill_name_conflict',
      ),
      { code: "skill_name_conflict" },
    );
    expect(skillErrorCode(error)).toBe("skill_name_conflict");
    expect(skillErrorMessage(error)).toBe('A skill named "pdf" already exists.');
    expect(skillErrorCode(new Error("x"))).toBeNull();
  });

  it("formats source and revision", () => {
    expect(shortRevision("0123456789abcdef0123")).toBe("0123456");
    expect(shortRevision("v1.2.0")).toBe("v1.2.0");
    expect(
      formatSkillSource({ kind: "github", ref: "anthropics/skills", revision: "0123456789abcdef" }),
    ).toBe("anthropics/skills @ 0123456");
    expect(formatSkillSource({ kind: "authored", ref: null, revision: null })).toBe("authored");
  });

  it("lists one option per project root", () => {
    const options = projectOptionsFromWorkspaces([
      { projectRootPath: "/p/b", projectDisplayName: "beta" },
      { projectRootPath: "/p/a", projectDisplayName: "alpha", projectCustomName: "Alpha app" },
      { projectRootPath: "/p/b", projectDisplayName: "beta (worktree)" },
    ]);
    expect(options).toEqual([
      { path: "/p/a", label: "Alpha app" },
      { path: "/p/b", label: "beta" },
    ]);
  });
});
