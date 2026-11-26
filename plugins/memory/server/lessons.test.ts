import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LESSON_EXPIRY_MS } from "../shared/types.js";
import {
  addLearnedRule,
  checkCitations,
  insertionDiff,
  normalizeCitations,
  pickRulesFile,
} from "./lessons.js";
import { MemoryService } from "./service.js";
import { MemoryInputError, MemoryStore } from "./store.js";

const DAY = 24 * 60 * 60 * 1000;

describe("citations (spec 42 §4)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "lesson-cite-"));
    writeFileSync(path.join(root, "package.json"), '{\n  "packageManager": "pnpm@9.1.0"\n}\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("makes paths inside the root relative and drops empty fields", () => {
    expect(
      normalizeCitations(
        [{ path: path.join(root, "package.json"), excerpt: "  pnpm@9  ", symbol: "" }],
        root,
      ),
    ).toEqual([{ path: "package.json", excerpt: "pnpm@9" }]);
  });

  it("holds while the file exists and the excerpt is still in it (whitespace-insensitive)", () => {
    expect(
      checkCitations([{ path: "package.json", excerpt: '"packageManager":   "pnpm@9.1.0"' }], root),
    ).toBeNull();
  });

  it("breaks when the file is gone or the excerpt changed", () => {
    expect(checkCitations([{ path: "pnpm-lock.yaml" }], root)).toBe(
      "Cited file not found: pnpm-lock.yaml",
    );
    expect(checkCitations([{ path: "package.json", excerpt: "yarn@4" }], root)).toBe(
      "Cited text is no longer in package.json",
    );
    expect(checkCitations([], root)).toBe("The lesson cites no file.");
  });
});

describe("graduation diff (spec 42 §5)", () => {
  it("appends a Learned rules section when the file has none", () => {
    const before = "# Agents\n\nRead the docs.\n";
    const after = addLearnedRule(before, "Use pnpm, never npm.", [{ path: "package.json" }]);
    expect(after).toBe(
      "# Agents\n\nRead the docs.\n\n## Learned rules\n\n- Use pnpm, never npm. (see `package.json`)\n",
    );
    expect(insertionDiff("AGENTS.md", before, after)).toBe(
      [
        "--- a/AGENTS.md",
        "+++ b/AGENTS.md",
        "@@ -1,3 +1,7 @@",
        " # Agents",
        " ",
        " Read the docs.",
        "+",
        "+## Learned rules",
        "+",
        "+- Use pnpm, never npm. (see `package.json`)",
      ].join("\n"),
    );
  });

  it("adds to the end of an existing Learned rules section, before the next heading", () => {
    const before = "# A\n\n## Learned rules\n\n- Old rule\n\n## Other\n\ntext\n";
    expect(addLearnedRule(before, "New rule", [])).toBe(
      "# A\n\n## Learned rules\n\n- Old rule\n- New rule\n\n## Other\n\ntext\n",
    );
  });

  it("creates AGENTS.md from nothing, and picks CLAUDE.md when only that exists", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lesson-rules-"));
    try {
      expect(pickRulesFile(root)).toMatchObject({ relativePath: "AGENTS.md", exists: false });
      expect(addLearnedRule("", "Rule", [])).toBe("## Learned rules\n\n- Rule\n");
      writeFileSync(path.join(root, "CLAUDE.md"), "# Claude\n");
      expect(pickRulesFile(root)).toMatchObject({ relativePath: "CLAUDE.md", exists: true });
      writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n");
      expect(pickRulesFile(root)).toMatchObject({ relativePath: "AGENTS.md", exists: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lesson lifecycle", () => {
  let root: string;
  let clock: number;
  let store: MemoryStore;
  let service: MemoryService;
  let agents: Record<string, { cwd: string; provider: string }>;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "lesson-life-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "package.json"), '{ "packageManager": "pnpm@9.1.0" }\n');
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    clock = Date.parse("2026-11-26T00:00:00Z");
    let ids = 0;
    store = new MemoryStore(new Database(":memory:"), {
      now: () => clock,
      newId: () => `mem_${++ids}`,
    });
    agents = {
      "agent-1": { cwd: root, provider: "claude" },
      "agent-2": { cwd: root, provider: "codex" },
      "agent-3": { cwd: root, provider: "opencode" },
    };
    service = new MemoryService({
      store,
      agentManager: {
        getAgent: (id: string) => agents[id] as never,
        appendTimelineItem: async () => ({}) as never,
      },
      projects: {
        list: async () => [{ projectId: "proj", name: "Proj", rootPath: root }],
        forAgent: async () => ({ projectId: "proj", name: "Proj", rootPath: root }),
      },
      broadcast: () => {},
      logger: pino({ level: "silent" }),
      isEnabled: () => true,
    });
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function rememberPnpmLesson(agentId = "agent-1") {
    return (
      await service.remember({
        agentId,
        scope: "project",
        kind: "lesson",
        text: "This project uses pnpm, not npm: run pnpm install and pnpm test.",
        citations: [
          { path: "package.json", excerpt: "pnpm@9.1.0" },
          { path: path.join(root, "pnpm-lock.yaml") },
        ],
      })
    ).memory;
  }

  async function injectedIds(agentId: string, text = "how do I install dependencies with pnpm") {
    const injection = await service.prepareUserTurn({ agentId, text });
    if (injection) await injection.commit({ messageId: `${agentId}-${clock}` });
    return injection?.memoryIds ?? [];
  }

  it("refuses a lesson without citations or with a citation that does not hold", async () => {
    await expect(
      service.remember({ agentId: "agent-1", scope: "project", kind: "lesson", text: "Use pnpm" }),
    ).rejects.toThrow(MemoryInputError);
    await expect(
      service.remember({
        agentId: "agent-1",
        scope: "project",
        kind: "lesson",
        text: "Use yarn",
        citations: [{ path: "yarn.lock" }],
      }),
    ).rejects.toThrow("Cited file not found: yarn.lock");
  });

  it("A42.4: a new agent gets the lesson; deleting the lockfile makes it stale and it stops", async () => {
    const lesson = await rememberPnpmLesson();
    expect(lesson).toMatchObject({
      kind: "lesson",
      status: "active",
      citations: [{ path: "package.json", excerpt: "pnpm@9.1.0" }, { path: "pnpm-lock.yaml" }],
    });
    expect(await injectedIds("agent-2")).toEqual([lesson.id]);
    unlinkSync(path.join(root, "pnpm-lock.yaml"));
    expect(await injectedIds("agent-3")).toEqual([]);
    expect(store.get(lesson.id)).toMatchObject({
      status: "stale",
      statusReason: "Cited file not found: pnpm-lock.yaml",
    });
  });

  it("A42.5: two thumbs-down deprecate a lesson and it is no longer injected", async () => {
    const lesson = await rememberPnpmLesson();
    service.rate({ id: lesson.id, helpful: false });
    expect(store.get(lesson.id)?.status).toBe("active");
    expect(service.rate({ id: lesson.id, helpful: false })).toMatchObject({
      status: "deprecated",
      harmful: 2,
    });
    expect(await injectedIds("agent-2")).toEqual([]);
  });

  it("more helpful than harmful keeps a lesson active", async () => {
    const lesson = await rememberPnpmLesson();
    for (let i = 0; i < 3; i += 1) service.rate({ id: lesson.id, helpful: true });
    service.rate({ id: lesson.id, helpful: false });
    expect(service.rate({ id: lesson.id, helpful: false })).toMatchObject({
      status: "active",
      helpful: 3,
      harmful: 2,
    });
  });

  it("A42.5: a lesson unused and unrated for 29 days goes stale; a helpful rating restarts the clock", async () => {
    const kept = await rememberPnpmLesson();
    const other = (
      await service.remember({
        agentId: "agent-1",
        scope: "project",
        kind: "lesson",
        text: "Lint with pnpm lint before committing.",
        citations: [{ path: "package.json" }],
      })
    ).memory;
    clock += 20 * DAY;
    service.rate({ id: kept.id, helpful: true });
    clock += 9 * DAY;
    service.sweepExpiredLessons();
    expect(store.get(other.id)).toMatchObject({
      status: "stale",
      statusReason: "Not rated helpful for 28 days.",
    });
    expect(store.get(kept.id)?.status).toBe("active");
    expect(LESSON_EXPIRY_MS).toBe(28 * DAY);
  });

  it("expiry is off when the switch is off", async () => {
    const lesson = await rememberPnpmLesson();
    service.updateSettings({ lessonExpiry: false });
    clock += 40 * DAY;
    service.sweepExpiredLessons();
    expect(store.get(lesson.id)?.status).toBe("active");
  });

  it("pending lessons (Capture lessons) are not injected until approved", async () => {
    const pending = (
      await service.remember({
        agentId: "agent-1",
        scope: "project",
        kind: "lesson",
        status: "pending",
        text: "Install with pnpm install.",
        citations: [{ path: "package.json" }],
      })
    ).memory;
    expect(pending.status).toBe("pending");
    expect(await injectedIds("agent-2", "pnpm install dependencies")).toEqual([]);
    await service.saveAsUser({ id: pending.id, status: "active" });
    expect(await injectedIds("agent-2", "pnpm install dependencies")).toEqual([pending.id]);
  });

  it("remembering the same lesson again updates it in place (delta), and never demotes it to pending", async () => {
    const first = await rememberPnpmLesson();
    const again = await service.remember({
      agentId: "agent-2",
      scope: "project",
      kind: "lesson",
      status: "pending",
      text: "this project uses pnpm, not npm:  run pnpm install and pnpm test.",
      citations: [{ path: "package.json" }],
    });
    expect(again.deduplicated).toBe(true);
    expect(again.memory.id).toBe(first.id);
    expect(again.memory.status).toBe("active");
    expect(store.list({ projectId: "proj" })).toHaveLength(1);
  });

  it("a lesson goes before a plain memory with the same score", async () => {
    await service.remember({
      agentId: "agent-1",
      scope: "project",
      text: "Deploy the docs with pnpm deploy.",
    });
    const lesson = (
      await service.remember({
        agentId: "agent-1",
        scope: "project",
        kind: "lesson",
        text: "Deploy the site with pnpm deploy.",
        citations: [{ path: "package.json" }],
      })
    ).memory;
    const ids = await injectedIds("agent-2", "pnpm deploy");
    expect(ids[0]).toBe(lesson.id);
  });

  it("A42.6: graduation is offered at the bar; approving writes AGENTS.md, otherwise nothing changes", async () => {
    const lesson = await rememberPnpmLesson();
    for (let i = 0; i < 3; i += 1) service.rate({ id: lesson.id, helpful: true });
    await injectedIds("agent-2");
    expect(store.get(lesson.id)?.graduationReady).toBe(false);
    clock += 1;
    await injectedIds("agent-3");
    expect(store.get(lesson.id)).toMatchObject({ agentCount: 2, graduationReady: true });

    writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n");
    const preview = await service.graduationPreview(lesson.id);
    expect(preview.relativePath).toBe("AGENTS.md");
    expect(preview.diff).toContain("+## Learned rules");
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("# Agents\n");

    writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nedited\n");
    await expect(
      service.graduationApply({ id: lesson.id, baseHash: preview.baseHash }),
    ).rejects.toThrow("changed since the diff was shown");
    const fresh = await service.graduationPreview(lesson.id);
    const applied = await service.graduationApply({ id: lesson.id, baseHash: fresh.baseHash });
    expect(applied.memory).toMatchObject({ status: "graduated", graduatedPath: "AGENTS.md" });
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe(
      "# Agents\nedited\n\n## Learned rules\n\n- This project uses pnpm, not npm: run pnpm install and pnpm test. (see `package.json`, `pnpm-lock.yaml`)\n",
    );
    expect(await injectedIds("agent-2")).toEqual([]);
  });

  it("Validate now flags a broken lesson and brings a fixed one back", async () => {
    const lesson = await rememberPnpmLesson();
    unlinkSync(path.join(root, "pnpm-lock.yaml"));
    expect((await service.validate({ projectId: "proj" }))[0]).toMatchObject({ status: "stale" });
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const [revalidated] = await service.validate({ id: lesson.id });
    expect(revalidated).toMatchObject({ status: "active", lastValidatedAtMs: clock });
  });

  it("the spec 42 switches persist with the Memory settings", () => {
    expect(service.durableSettings()).toEqual({
      regroundAfterCompaction: true,
      recitation: true,
      ledgerNudge: true,
      learnFromCorrections: true,
      lessonExpiry: true,
    });
    service.updateSettings({ recitation: false, learnFromCorrections: false });
    expect(service.durableSettings()).toMatchObject({
      recitation: false,
      learnFromCorrections: false,
    });
  });
});
