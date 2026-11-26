import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractQueryTerms } from "./query-terms.js";
import { findSecret } from "./secrets.js";
import { MemoryInputError, MemoryStore } from "./store.js";

const agentSource = { by: "agent" as const, agentId: "agent-1", provider: "claude" };

let clock: number;
let ids: number;
let store: MemoryStore;

beforeEach(() => {
  clock = 1_000;
  ids = 0;
  store = new MemoryStore(new Database(":memory:"), {
    now: () => ++clock,
    newId: () => `mem_${++ids}`,
  });
});
afterEach(() => store.close());

function add(text: string, options: { scope?: "project" | "global"; projectId?: string } = {}) {
  return store.add({
    scope: options.scope ?? "project",
    projectId: options.projectId ?? "proj-a",
    text,
    source: agentSource,
  }).memory;
}

describe("MemoryStore dedup", () => {
  it("updates the existing memory when the normalized text repeats in the same scope", () => {
    const first = add("This project uses  pnpm");
    const second = store.add({
      scope: "project",
      projectId: "proj-a",
      text: "this project USES pnpm",
      tags: ["tooling"],
      source: agentSource,
    });
    expect(second.deduplicated).toBe(true);
    expect(second.memory.id).toBe(first.id);
    expect(second.memory.updatedAtMs).toBeGreaterThan(first.updatedAtMs);
    expect(second.memory.tags).toEqual(["tooling"]);
    expect(store.list({ projectId: "proj-a" })).toHaveLength(1);
  });

  it("keeps the same text in another project or in global as separate memories", () => {
    add("Run tests with vitest");
    add("Run tests with vitest", { projectId: "proj-b" });
    add("Run tests with vitest", { scope: "global" });
    expect(store.list()).toHaveLength(3);
  });

  it("merges two memories when an edit makes their text equal", () => {
    const keep = add("Use pnpm");
    const other = add("Use npm");
    store.update(other.id, { text: "use   PNPM" });
    expect(store.list().map((memory) => memory.id)).toEqual([other.id]);
    expect(store.get(keep.id)).toBeNull();
  });
});

describe("MemoryStore validation", () => {
  it("refuses text with a secret and stores nothing", () => {
    expect(() =>
      add("Deploy token is ghp_0123456789abcdefghijABCDEFGHIJ0123456789"),
    ).toThrowError(MemoryInputError);
    expect(store.list()).toEqual([]);
  });

  it("refuses empty and over-long text", () => {
    expect(() => add("   ")).toThrow(/empty/);
    expect(() => add("x".repeat(1_001))).toThrow(/limit is 1000/);
  });

  it("refuses a project memory without a project", () => {
    expect(() =>
      store.add({ scope: "project", projectId: null, text: "x", source: agentSource }),
    ).toThrow(/not in a project/);
  });
});

describe("MemoryStore search and auto-inject selection", () => {
  it("injects the pnpm memory for a question about installing dependencies", () => {
    const pnpm = add("This project uses pnpm to install dependencies (pnpm install).");
    add("The API server listens on port 4000.");
    const selected = store.selectForPrompt({
      text: "How should I install the dependencies?",
      projectId: "proj-a",
      tokenCap: 1_500,
    });
    expect(selected.map((memory) => memory.id)).toEqual([pnpm.id]);
    expect(selected[0]!.score).toBeGreaterThan(0);
  });

  it("does not inject on a single shared common word when the message has several terms", () => {
    add("Release notes go in docs/releases.");
    const selected = store.selectForPrompt({
      text: "Write the onboarding notes for the login screen",
      projectId: "proj-a",
      tokenCap: 1_500,
    });
    expect(selected).toEqual([]);
  });

  it("injects on one matching path or identifier", () => {
    const memory = add("packages/server/src/bootstrap.ts wires every daemon service.");
    const selected = store.selectForPrompt({
      text: "Why does bootstrap.ts crash at start?",
      projectId: "proj-a",
      tokenCap: 1_500,
    });
    expect(selected.map((entry) => entry.id)).toEqual([memory.id]);
  });

  it("matches Vietnamese text without diacritics sensitivity", () => {
    const memory = add("Trả lời bằng tiếng Việt", { scope: "global" });
    const selected = store.selectForPrompt({
      text: "tieng viet nhe",
      projectId: "proj-b",
      tokenCap: 1_500,
    });
    expect(selected.map((entry) => entry.id)).toEqual([memory.id]);
  });

  it("sees global memories from any project but not another project's memories", () => {
    add("Deploy with docker compose up", { projectId: "proj-b" });
    const global = add("Deploy previews with docker compose", { scope: "global" });
    expect(
      store.search({ query: "docker compose deploy", projectId: "proj-a" }).map((m) => m.id),
    ).toEqual([global.id]);
  });

  it("ranks the memory matching more and rarer terms first", () => {
    add("Lint with npm run lint");
    const best = add("Format with npm run format before every commit");
    add("Typecheck with npm run typecheck");
    const ranked = store.search({ query: "format commit", projectId: "proj-a" });
    expect(ranked[0]!.id).toBe(best.id);
    expect(ranked).toHaveLength(1);
  });

  it("caps relevant memories at five and pinned at ten", () => {
    for (let index = 0; index < 8; index++) add(`Docker compose service number ${index} detail`);
    for (let index = 0; index < 12; index++) {
      const memory = add(`Pinned rule ${index}`);
      store.update(memory.id, { pinned: true });
    }
    const selected = store.selectForPrompt({
      text: "docker compose service",
      projectId: "proj-a",
      tokenCap: 100_000,
    });
    expect(selected.filter((memory) => memory.pinned)).toHaveLength(10);
    expect(selected.filter((memory) => !memory.pinned)).toHaveLength(5);
    expect(selected.slice(0, 10).every((memory) => memory.pinned)).toBe(true);
  });

  it("keeps the injected total within the token cap", () => {
    for (let index = 0; index < 5; index++) add(`Docker compose ${index} ${"word ".repeat(150)}`);
    const selected = store.selectForPrompt({
      text: "docker compose",
      projectId: "proj-a",
      tokenCap: 500,
    });
    const tokens = selected.reduce(
      (total, memory) => total + Math.ceil(memory.text.length / 4) + 8,
      0,
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(5);
    expect(tokens).toBeLessThanOrEqual(500);
  });

  it("limits search results to ten", () => {
    for (let index = 0; index < 14; index++) add(`Kubernetes namespace ${index}`);
    expect(store.search({ query: "kubernetes", projectId: "proj-a", limit: 50 })).toHaveLength(
      10,
    );
  });
});

describe("MemoryStore usage", () => {
  it("counts each memory once per turn and lists what an agent used", () => {
    const memory = add("Use pnpm");
    store.recordUses({
      agentId: "agent-2",
      turnKey: "turn-1",
      kind: "injected",
      memories: [{ id: memory.id, score: 1.2 }],
    });
    store.recordUses({
      agentId: "agent-2",
      turnKey: "turn-1",
      kind: "injected",
      memories: [{ id: memory.id, score: 1.2 }],
    });
    expect(store.get(memory.id)?.useCount).toBe(1);
    expect(store.usesForAgent("agent-2").map((use) => use.memory.id)).toEqual([memory.id]);
    store.remove(memory.id);
    expect(store.usesForAgent("agent-2")).toEqual([]);
  });
});

describe("extractQueryTerms", () => {
  it("drops stopwords and keeps paths as phrases", () => {
    expect(extractQueryTerms("How do I run the src/app.ts file?").map((term) => term.fts)).toEqual([
      '"run"',
      '"src app ts"',
      '"file"',
    ]);
  });

  it("keeps camelCase identifiers whole", () => {
    expect(extractQueryTerms("fix useMemoryStore")).toEqual([
      { fts: '"fix"', key: "fix", identifier: false },
      { fts: '"usememorystore"', key: "usememorystore", identifier: true },
    ]);
  });
});

describe("findSecret", () => {
  it.each([
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "password = hunter2hunter2",
    "https://user:s3cretpass@example.internal/repo.git",
    "xoxb-1234567890-abcdefghij",
  ])("finds a secret in %s", (text) => {
    expect(findSecret(text)).not.toBeNull();
  });

  it.each(["This project uses pnpm", "The token budget is 1500 tokens", "Keys live in Keychain"])(
    "allows %s",
    (text) => {
      expect(findSecret(text)).toBeNull();
    },
  );
});
