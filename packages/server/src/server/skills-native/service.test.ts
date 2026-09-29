import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { NativeSkillsError } from "./errors.js";
import { LESSONS_MARKER, parseSkillMarkdown } from "./frontmatter.js";
import { NativeSkillsService } from "./service.js";
import {
  fakeFetch,
  githubRepoRoutes,
  makeTempRoots,
  snapshotTree,
  writeSkill,
} from "./test-utils/fixtures.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

let roots: ReturnType<typeof makeTempRoots>;

function makeService(
  overrides: Partial<ConstructorParameters<typeof NativeSkillsService>[0]> = {},
): NativeSkillsService {
  return new NativeSkillsService({
    jagentdeskHome: roots.jdHome,
    homeDir: roots.home,
    logger: createTestLogger(),
    fetch: fakeFetch(
      githubRepoRoutes("anthropics/skills", COMMIT, {
        "skills/frontend-design/SKILL.md":
          "---\nname: frontend-design\ndescription: Build distinctive frontends.\n---\n\nUse bold type.\n",
        "skills/frontend-design/scripts/check.sh": {
          content: "#!/bin/sh\necho ok\n",
          mode: "100755",
        },
        "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDFs.\n---\n\nRead PDFs.\n",
      }).routes,
    ),
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ...overrides,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NativeSkillsError) return error.code;
    throw error;
  }
  return "resolved";
}

const officialItem = (itemId: string) => ({
  source: { kind: "official" as const, repo: "anthropics/skills" },
  itemId,
});

beforeEach(async () => {
  roots = makeTempRoots();
  await fs.mkdir(roots.home, { recursive: true });
  await fs.mkdir(roots.jdHome, { recursive: true });
  // An unrelated file so "home unchanged" is a meaningful comparison.
  await fs.writeFile(path.join(roots.home, ".profile-marker"), "untouched\n");
});

afterEach(async () => {
  await fs.rm(roots.root, { recursive: true, force: true });
});

describe("scanner (spec 22.3, 22.11 #1)", () => {
  it("lists every real skill directory once and maps visibleTo", async () => {
    const agentsFoo = path.join(roots.home, ".agents", "skills", "foo");
    await writeSkill(agentsFoo, "name: foo\ndescription: Shared skill.");
    await fs.mkdir(path.join(roots.home, ".claude", "skills"), { recursive: true });
    await fs.symlink(agentsFoo, path.join(roots.home, ".claude", "skills", "foo"));
    await writeSkill(
      path.join(roots.home, ".claude", "skills", "bar"),
      "name: bar\ndescription: Claude only.",
    );
    await writeSkill(path.join(roots.home, ".kiro", "skills", "broken"), "name: broken");

    const service = makeService();
    await service.initialize();
    const { skills } = await service.listCatalog();

    expect(skills.map((skill) => skill.skillId)).toEqual([
      "global:claude:bar",
      "global:kiro:broken",
      "global:agents:foo",
    ]);
    const foo = skills.find((skill) => skill.name === "foo")!;
    expect(foo.links).toEqual([
      { dir: "claude", path: path.join(roots.home, ".claude", "skills", "foo") },
    ]);
    expect(foo.visibleTo).toEqual([
      "claude",
      "codex",
      "opencode",
      "cursor",
      "copilot",
      "pi",
      "omp",
      "kimi",
    ]);
    expect(foo.owned).toBe(false);
    const bar = skills.find((skill) => skill.name === "bar")!;
    expect(bar.visibleTo).toEqual(["claude", "opencode", "cursor", "omp", "kimi"]);
    const broken = skills.find((skill) => skill.name === "broken")!;
    expect(broken.status).toBe("invalid");
    expect(broken.invalidReason).toBe("Missing description");
    expect(broken.visibleTo).toEqual(["kiro"]);
  });

  it("scans project directories for the given cwd", async () => {
    const project = path.join(roots.root, "project");
    await writeSkill(
      path.join(project, ".github", "skills", "ci"),
      "name: ci\ndescription: Fix CI.",
    );
    const service = makeService();
    await service.initialize();
    const { skills } = await service.listCatalog(project);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      skillId: "project:copilot:ci",
      scope: "project",
      projectRoot: project,
      visibleTo: ["copilot"],
    });
    expect((await service.listCatalog()).skills).toHaveLength(0);
  });
});

describe("install / uninstall (spec 22.11 #2, #3)", () => {
  it("browses the official repo from the tree API, installs globally, and uninstalls to zero diff", async () => {
    const service = makeService();
    await service.initialize();
    const items = await service.browse({ kind: "official", repo: "anthropics/skills" });
    expect(items.map((item) => item.itemId)).toEqual(["skills/frontend-design", "skills/pdf"]);
    const frontend = items[0]!;
    expect(frontend).toMatchObject({
      name: "frontend-design",
      revision: COMMIT,
      hasScripts: true,
      installed: false,
    });
    expect(frontend.files).toEqual(["SKILL.md", "scripts/check.sh"]);

    const before = await snapshotTree(roots.home);
    const { skill } = await service.install({
      item: officialItem("skills/frontend-design"),
      scope: "global",
    });
    const realPath = path.join(roots.home, ".agents", "skills", "frontend-design");
    expect(skill).toMatchObject({
      skillId: "global:agents:frontend-design",
      owned: true,
      enabled: true,
      source: { kind: "github", ref: "anthropics/skills", revision: COMMIT },
      hasScripts: true,
    });
    for (const dir of [".claude", ".kiro"]) {
      const link = path.join(roots.home, dir, "skills", "frontend-design");
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(link)).toBe(await fs.realpath(realPath));
    }
    const lock = JSON.parse(
      await fs.readFile(path.join(roots.jdHome, "skills", "lock.json"), "utf8"),
    );
    expect(lock.skills[0]).toMatchObject({ name: "frontend-design", realPath });

    const { removed } = await service.uninstall({ skillId: "global:agents:frontend-design" });
    expect(removed).toContain(realPath);
    expect(await snapshotTree(roots.home)).toEqual(before);
  });

  it("refuses a name that collides with a pre-existing skill and writes nothing (#4)", async () => {
    await writeSkill(
      path.join(roots.home, ".claude", "skills", "frontend-design"),
      "name: frontend-design\ndescription: Mine.",
    );
    const service = makeService();
    await service.initialize();
    const before = await snapshotTree(roots.home);
    expect(
      await codeOf(
        service.install({ item: officialItem("skills/frontend-design"), scope: "global" }),
      ),
    ).toBe("skill_name_conflict");
    expect(await snapshotTree(roots.home)).toEqual(before);

    const { skill } = await service.install({
      item: officialItem("skills/frontend-design"),
      scope: "global",
      rename: "frontend-design-alt",
    });
    expect(skill?.name).toBe("frontend-design-alt");
    const written = parseSkillMarkdown(
      await fs.readFile(path.join(skill!.realPath, "SKILL.md"), "utf8"),
    );
    expect(written.frontmatter?.["name"]).toBe("frontend-design-alt");
  });

  it("installs into a project and keeps other project skills intact", async () => {
    const project = path.join(roots.root, "project");
    await fs.mkdir(project, { recursive: true });
    const service = makeService();
    await service.initialize();
    const before = await snapshotTree(project);
    const { skill } = await service.install({
      item: officialItem("skills/pdf"),
      scope: "project",
      cwd: project,
    });
    expect(skill).toMatchObject({ skillId: "project:agents:pdf", projectRoot: project });
    expect(await fs.readlink(path.join(project, ".claude", "skills", "pdf"))).toBe(
      path.join("..", "..", ".agents", "skills", "pdf"),
    );
    await service.uninstall({ skillId: "project:agents:pdf" });
    expect(await snapshotTree(project)).toEqual(before);
  });
});

describe("enable / disable (spec 22.11 #5)", () => {
  it("disables a pre-existing skill only with confirmation and restores it exactly", async () => {
    const agentsFoo = path.join(roots.home, ".agents", "skills", "foo");
    await writeSkill(agentsFoo, "name: foo\ndescription: Shared.", "Body\n", {
      "references/notes.md": "notes\n",
    });
    await fs.mkdir(path.join(roots.home, ".claude", "skills"), { recursive: true });
    await fs.symlink("../../.agents/skills/foo", path.join(roots.home, ".claude", "skills", "foo"));
    const service = makeService();
    await service.initialize();
    const before = await snapshotTree(roots.home);

    expect(await codeOf(service.setEnabled({ skillId: "global:agents:foo", enabled: false }))).toBe(
      "confirmation_required",
    );
    expect(await snapshotTree(roots.home)).toEqual(before);

    const disabled = await service.setEnabled({
      skillId: "global:agents:foo",
      enabled: false,
      confirm: true,
    });
    expect(disabled).toMatchObject({ enabled: false, owned: false, visibleTo: [] });
    expect(disabled.realPath.startsWith(path.join(roots.jdHome, "skills", "disabled"))).toBe(true);
    await expect(fs.lstat(agentsFoo)).rejects.toThrow();

    const enabled = await service.setEnabled({ skillId: "global:agents:foo", enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(await snapshotTree(roots.home)).toEqual(before);
  });

  it("disables and re-enables an owned skill", async () => {
    const service = makeService();
    await service.initialize();
    const created = await service.author({
      name: "reviewer",
      description: "Review PRs.",
      body: "Check tests.",
      scope: "global",
    });
    const before = await snapshotTree(path.join(roots.home, ".agents"));
    const off = await service.setEnabled({ skillId: created.skillId, enabled: false });
    expect(off).toMatchObject({ enabled: false, owned: true });
    await expect(
      fs.lstat(path.join(roots.home, ".claude", "skills", "reviewer")),
    ).rejects.toThrow();
    const on = await service.setEnabled({ skillId: created.skillId, enabled: true });
    expect(on).toMatchObject({ enabled: true, owned: true });
    expect(await snapshotTree(path.join(roots.home, ".agents"))).toEqual(before);
  });
});

describe("invocation (spec 22.7, 22.11 #6)", () => {
  it("builds the provider-specific invocation for visible skills", async () => {
    const service = makeService();
    await service.initialize();
    const skill = await service.author({
      name: "shipper",
      description: "Ship it.",
      body: "Ship carefully.",
      scope: "global",
    });
    await writeSkill(
      path.join(roots.home, ".codex", "skills", "legacy-codex"),
      "name: legacy-codex\ndescription: Codex only.",
    );
    const ids = [skill.skillId];
    expect(await service.buildInvocationPrefix(ids, "codex")).toBe("$shipper");
    expect(await service.buildInvocationPrefix(ids, "claude")).toBe("/shipper");
    expect(await service.buildInvocationPrefix(ids, "kiro")).toBe("/shipper");
    expect(await service.buildInvocationPrefix(ids, "pi")).toBe("/skill:shipper");
    expect(await service.buildInvocationPrefix(ids, "kimi")).toBe("/skill:shipper");
    expect(await service.buildInvocationPrefix(ids, "opencode")).toBe(
      "Before you answer, load this skill: `shipper`.",
    );
    expect(await service.buildInvocationPrefix(ids, "some-acp")).toBe(
      "Before you answer, load this skill: `shipper`.",
    );
    // Not visible to Claude (only in ~/.codex/skills): skipped.
    expect(await service.buildInvocationPrefix(["global:codex:legacy-codex"], "claude")).toBe("");
    expect(
      await service.buildInvocationPrefix([skill.skillId, "global:codex:legacy-codex"], "codex"),
    ).toBe("$shipper $legacy-codex");
    await writeSkill(
      path.join(roots.home, ".claude", "skills", "reviewer"),
      "name: reviewer\ndescription: Review it.",
    );
    const both = [skill.skillId, "global:claude:reviewer"];
    expect(await service.buildInvocationPrefix(both, "claude")).toBe(
      "/shipper\nBefore you answer, load this skill with the Skill tool: `reviewer`.",
    );
    expect(await service.buildInvocationPrefix(both, "kimi")).toBe(
      "/skill:shipper\nBefore you answer, load this skill: `reviewer`.",
    );
    expect(await service.buildInvocationPrefix(both, "opencode")).toBe(
      "Before you answer, load these skills: `shipper`, `reviewer`.",
    );
  });
});

describe("contentHash (spec 22.4, 22.6.1)", () => {
  it("is equal for identical copies and changes with SKILL.md or the file list", async () => {
    const service = makeService();
    const frontmatter = "name: twin\ndescription: Same skill.";
    await writeSkill(path.join(roots.home, ".agents", "skills", "twin"), frontmatter, "Body.\n", {
      "references/a.md": "ref",
    });
    await writeSkill(path.join(roots.home, ".claude", "skills", "twin"), frontmatter, "Body.\n", {
      "references/a.md": "ref",
    });
    const hashes = async () => {
      const list = await service.listCatalog();
      const byId = new Map(list.skills.map((entry) => [entry.skillId, entry.contentHash]));
      return {
        agents: byId.get("global:agents:twin"),
        claude: byId.get("global:claude:twin"),
      };
    };
    const first = await hashes();
    expect(first.agents).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.claude).toBe(first.agents);

    await fs.writeFile(
      path.join(roots.home, ".claude", "skills", "twin", "SKILL.md"),
      `---\n${frontmatter}\n---\n\nDifferent body.\n`,
    );
    const second = await hashes();
    expect(second.agents).toBe(first.agents);
    expect(second.claude).not.toBe(first.agents);

    await fs.writeFile(path.join(roots.home, ".agents", "skills", "twin", "extra.md"), "x");
    const third = await hashes();
    expect(third.agents).not.toBe(first.agents);
  });
});

describe("train (spec 22.9, 22.11 #7)", () => {
  it("appends approved lessons in the marked section, keeps frontmatter standard, tracks XP", async () => {
    const service = makeService();
    await service.initialize();
    const skill = await service.author({
      name: "k8s-doctor",
      description: "Diagnose pods.",
      body: "Start with kubectl describe.",
      scope: "global",
    });
    const file = path.join(skill.realPath, "SKILL.md");
    const original = await fs.readFile(file, "utf8");

    const approved = await service.learn({
      skillId: skill.skillId,
      lesson: "Check events\nbefore logs",
      approved: true,
    });
    expect(approved.training).toMatchObject({ lessons: 1, approvals: 1, runs: 1, xp: 60 });
    const rejected = await service.learn({
      skillId: skill.skillId,
      lesson: "nope",
      approved: false,
    });
    expect(rejected.training).toMatchObject({ lessons: 1, approvals: 1, runs: 2, xp: 75 });

    const content = await fs.readFile(file, "utf8");
    expect(content.startsWith(original.trimEnd())).toBe(true);
    expect(content).toContain(`${LESSONS_MARKER}\n`);
    expect(content).toContain("- Check events before logs\n");
    expect(content).not.toContain("nope");
    const parsed = parseSkillMarkdown(content);
    expect(Object.keys(parsed.frontmatter ?? {})).toEqual(["name", "description"]);
  });

  it("refuses to train a skill it does not own; fork makes an owned copy", async () => {
    const original = path.join(roots.home, ".claude", "skills", "theirs");
    await writeSkill(original, "name: theirs\ndescription: Not ours.");
    const service = makeService();
    await service.initialize();
    const before = await snapshotTree(original);
    expect(
      await codeOf(service.learn({ skillId: "global:claude:theirs", lesson: "x", approved: true })),
    ).toBe("skill_not_owned");

    const fork = await service.fork({ skillId: "global:claude:theirs" });
    expect(fork).toMatchObject({
      name: "theirs-jagentdesk",
      owned: true,
      source: { kind: "fork", ref: "global:claude:theirs" },
    });
    await service.learn({ skillId: fork.skillId, lesson: "Be brief", approved: true });
    expect(await snapshotTree(original)).toEqual(before);
  });
});

describe("migration (spec 22.10)", () => {
  const legacy = [
    {
      id: "skl_reviewer",
      name: "PR Reviewer",
      icon: "🔍",
      description: "Reviews pull requests.",
      instructions: "Read the diff first.",
      tags: ["review"],
      status: "training",
      xp: 180,
      runs: 3,
      approvals: 3,
      consecutiveApprovals: 3,
      examples: [],
      learned: [
        { id: "l2", source: "proposed", content: "Pending idea", approved: false, at: 2 },
        { id: "l1", source: "approved-answer", content: "Mention tests", approved: true, at: 1 },
      ],
      createdAt: 1000,
      updatedAt: 2000,
    },
    {
      id: "skl_frontend",
      name: "Frontend Design",
      icon: "✦",
      description: "",
      instructions: "# Frontend\nUse a grid.",
      tags: [],
      status: "graduated",
      xp: 0,
      runs: 0,
      approvals: 0,
      consecutiveApprovals: 0,
      examples: [],
      learned: [],
      createdAt: 3000,
      updatedAt: 3000,
    },
  ];

  it("migrates JSON skills to owned SKILL.md skills once, with XP in the lock", async () => {
    await writeSkill(
      path.join(roots.home, ".agents", "skills", "frontend-design"),
      "name: frontend-design\ndescription: Existing.",
    );
    const skillsJson = path.join(roots.jdHome, "skills", "skills.json");
    await fs.mkdir(path.dirname(skillsJson), { recursive: true });
    await fs.writeFile(skillsJson, JSON.stringify(legacy));

    const service = makeService();
    await service.initialize();

    await expect(fs.stat(skillsJson)).rejects.toThrow();
    await fs.stat(`${skillsJson}.migrated.bak`);
    const reviewerMd = await fs.readFile(
      path.join(roots.home, ".agents", "skills", "pr-reviewer", "SKILL.md"),
      "utf8",
    );
    expect(reviewerMd).toContain("Read the diff first.");
    expect(reviewerMd).toContain(`${LESSONS_MARKER}`);
    expect(reviewerMd).toContain("- Mention tests");
    expect(reviewerMd).not.toContain("Pending idea");
    // Conflicts with the pre-existing skill → suffix.
    await fs.stat(
      path.join(roots.home, ".agents", "skills", "frontend-design-jagentdesk", "SKILL.md"),
    );
    expect(
      await fs.readlink(path.join(roots.home, ".claude", "skills", "pr-reviewer")),
    ).toBeTruthy();

    const compat = service.get();
    const reviewer = compat.find((skill) => skill.id === "skl_reviewer")!;
    expect(reviewer).toMatchObject({
      name: "PR Reviewer",
      icon: "🔍",
      xp: 180,
      approvals: 3,
      instructions: "Read the diff first.",
    });
    expect(reviewer.learned.map((entry) => [entry.content, entry.approved])).toEqual([
      ["Pending idea", false],
      ["Mention tests", true],
    ]);
    expect(compat.find((skill) => skill.id === "skl_frontend")?.status).toBe("graduated");

    const catalog = await service.listCatalog();
    expect(catalog.skills.find((s) => s.legacyId === "skl_reviewer")?.training).toMatchObject({
      lessons: 1,
      xp: 180,
    });

    // Idempotent: a second start (even with the JSON restored) creates nothing new.
    await fs.copyFile(`${skillsJson}.migrated.bak`, skillsJson);
    const again = makeService();
    await again.initialize();
    expect(again.get()).toHaveLength(2);
  });

  it("serves legacy mutations from the native skills (COMPAT)", async () => {
    const service = makeService();
    await service.initialize();
    await service.mutate({
      op: "add",
      skill: { ...legacy[0]!, id: "skl_new", learned: [], xp: 999 } as never,
    });
    let skill = service.get().find((s) => s.id === "skl_new")!;
    expect(skill.xp).toBe(0);
    await service.mutate({
      op: "learn",
      id: "skl_new",
      entryId: "e1",
      rating: "up",
      content: "Keep it short",
    });
    skill = service.get().find((s) => s.id === "skl_new")!;
    expect(skill.xp).toBe(60);
    expect(skill.learned.map((entry) => entry.content)).toEqual(["Keep it short"]);
    await service.mutate({ op: "update", id: "skl_new", patch: { instructions: "New body" } });
    skill = service.get().find((s) => s.id === "skl_new")!;
    expect(skill.instructions).toBe("New body");
    expect(skill.learned).toHaveLength(1);
    await service.mutate({ op: "remove", id: "skl_new" });
    expect(service.get()).toHaveLength(0);
    await expect(
      fs.stat(path.join(roots.home, ".agents", "skills", "pr-reviewer")),
    ).rejects.toThrow();
  });
});
