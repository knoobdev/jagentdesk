import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillSourceSpec } from "@jagentdesk/protocol/native-skills";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { NativeSkillsError } from "./errors.js";
import { selectTreeSkills, type TreeBlob } from "./github-tree.js";
import { RemoteListingCache } from "./remote-listing.js";
import { NativeSkillsService } from "./service.js";
import { SkillSourceBrowser } from "./source-browser.js";
import { sourceIdFor } from "./source-config.js";
import {
  fakeFetch,
  fakeRoute,
  githubRepoRoutes,
  makeTempRoots,
  writeSkill,
} from "./test-utils/fixtures.js";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const API = "https://api.github.com/repos";
const RAW = "https://raw.githubusercontent.com";
const TEN_MINUTES = 10 * 60 * 1000;

let roots: ReturnType<typeof makeTempRoots>;

beforeEach(async () => {
  roots = makeTempRoots();
  await fs.mkdir(roots.home, { recursive: true });
  await fs.mkdir(roots.jdHome, { recursive: true });
});

afterEach(async () => {
  await fs.rm(roots.root, { recursive: true, force: true });
});

function skillMd(name: string, description = `${name} skill.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.\n`;
}

function github(owner: string, repo: string, subpath: string | null = null): SkillSourceSpec {
  return { kind: "github", owner, repo, ref: null, subpath };
}

const ANTHROPIC = githubRepoRoutes(
  "anthropics/skills",
  COMMIT_A,
  {
    "README.md": "readme",
    "skills/pdf/SKILL.md": skillMd("pdf"),
    "skills/pdf/reference.md": "ref",
    "skills/pdf/scripts/fill.py": "print(1)\n",
    "skills/docx/SKILL.md": skillMd("docx"),
    "skills/docx/tool": { content: "#!/bin/sh\n", mode: "100755" },
  },
  { etag: 'W/"anthropic-1"' },
);
const OPENAI = githubRepoRoutes("openai/skills", COMMIT_B, {
  "skills/.curated/lint/SKILL.md": skillMd("lint"),
  "skills/.curated/lint/notes.md": "notes",
});

function officialFetch() {
  return fakeFetch({ ...ANTHROPIC.routes, ...OPENAI.routes });
}

function newCache(fetch: ReturnType<typeof fakeFetch>, now: () => number = () => 1) {
  return new RemoteListingCache({ cacheDir: path.join(roots.root, "cache"), fetch, now });
}

function newService(fetch: ReturnType<typeof fakeFetch>): NativeSkillsService {
  return new NativeSkillsService({
    jagentdeskHome: roots.jdHome,
    homeDir: roots.home,
    logger: createTestLogger(),
    fetch,
  });
}

describe("GitHub tree listing", () => {
  it("lists both official repos with one API call each and only SKILL.md downloads", async () => {
    const fetch = officialFetch();
    const browser = new SkillSourceBrowser({
      cacheDir: path.join(roots.jdHome, "skills", "cache"),
      skillsHome: path.join(roots.jdHome, "skills"),
      homeDir: roots.home,
      fetch,
      now: () => 1_000_000,
    });
    const items = await browser.browse({ kind: "official" }, [], {});
    expect(
      items.map((item) => [item.itemId, item.name, item.revision, item.hasScripts, item.files]),
    ).toEqual([
      ["skills/docx", "docx", COMMIT_A, true, ["SKILL.md", "tool"]],
      ["skills/pdf", "pdf", COMMIT_A, true, ["SKILL.md", "reference.md", "scripts/fill.py"]],
      ["skills/.curated/lint", "lint", COMMIT_B, false, ["SKILL.md", "notes.md"]],
    ]);
    expect(items[0]).toMatchObject({ description: "docx skill.", body: "\nUse docx.\n" });
    expect(fetch.calls.filter((url) => url.startsWith(API)).sort()).toEqual([
      ANTHROPIC.treeUrl,
      OPENAI.treeUrl,
    ]);
    expect(fetch.calls.filter((url) => url.startsWith(RAW)).sort()).toEqual([
      `${RAW}/anthropics/skills/${COMMIT_A}/skills/docx/SKILL.md`,
      `${RAW}/anthropics/skills/${COMMIT_A}/skills/pdf/SKILL.md`,
      `${RAW}/openai/skills/${COMMIT_B}/skills/.curated/lint/SKILL.md`,
    ]);
    expect(fetch.calls.some((url) => url.includes("codeload") || url.includes("tar.gz"))).toBe(
      false,
    );
  });

  it("selects skills below a sub-path like a disk walk", () => {
    const blob = (p: string): TreeBlob => ({ path: p, mode: "100644", sha: "0", size: 1 });
    const blobs = [
      blob("SKILL.md"),
      blob("pack/a/SKILL.md"),
      blob("pack/a/nested/SKILL.md"),
      blob("pack/a/nested/x.md"),
      blob("pack/node_modules/dep/SKILL.md"),
      blob("pack/b/c/SKILL.md"),
      blob("pack-other/SKILL.md"),
      blob("pack/1/2/3/4/5/6/SKILL.md"),
      blob("pack/1/2/3/4/5/6/7/SKILL.md"),
    ];
    const skills = selectTreeSkills(blobs, "pack");
    expect(skills.map((skill) => skill.dir)).toEqual(["pack/1/2/3/4/5/6", "pack/a", "pack/b/c"]);
    expect(skills[1]!.files.map((file) => file.path)).toEqual([
      "pack/a/SKILL.md",
      "pack/a/nested/SKILL.md",
      "pack/a/nested/x.md",
    ]);
    expect(selectTreeSkills(blobs, null).map((skill) => skill.dir)).toEqual([""]);
  });

  it("lists a url source restricted to its sub-path at the given ref", async () => {
    const repo = githubRepoRoutes(
      "owner/repo",
      COMMIT_A,
      { "skills/one/SKILL.md": skillMd("one"), "skills/two/SKILL.md": skillMd("two") },
      { ref: "v2" },
    );
    const fetch = fakeFetch(repo.routes);
    const service = newService(fetch);
    await service.initialize();
    const items = await service.browse({
      kind: "url",
      url: "https://github.com/owner/repo/tree/v2/skills/two",
    });
    expect(items.map((item) => [item.itemId, item.origin])).toEqual([
      ["skills/two", "owner/repo/skills/two@v2"],
    ]);
    expect(fetch.calls.filter((url) => url.startsWith(RAW))).toHaveLength(1);
  });

  it("sends a GitHub token to the API only", async () => {
    const fetch = officialFetch();
    const cache = new RemoteListingCache({
      cacheDir: roots.root,
      fetch,
      now: () => 1,
      githubToken: "test-token",
    });
    await cache.list(github("anthropics", "skills"));
    for (const request of fetch.requests) {
      const auth = request.headers["Authorization"];
      expect(auth).toBe(request.url.startsWith(API) ? "Bearer test-token" : undefined);
    }
  });

  it("walks a truncated tree with the contents API and installs from it", async () => {
    const repo = githubRepoRoutes("big/repo", COMMIT_A, {}, { truncated: true });
    const contents = (dir: string) =>
      `${API}/big/repo/contents${dir ? `/${dir}` : ""}?ref=${COMMIT_A}`;
    const entry = (p: string, type: string, size = 1) => ({
      name: p.split("/").pop(),
      path: p,
      type,
      sha: `${p}-sha`,
      size,
    });
    const md = skillMd("deep");
    const fetch = fakeFetch({
      ...repo.routes,
      [contents("")]: [entry("docs", "dir"), entry("README.md", "file")],
      [contents("docs")]: [entry("docs/deep", "dir"), entry("docs/node_modules", "dir")],
      [contents("docs/deep")]: [
        entry("docs/deep/SKILL.md", "file", md.length),
        entry("docs/deep/scripts", "dir"),
      ],
      [contents("docs/deep/scripts")]: [entry("docs/deep/scripts/go.sh", "file", 3)],
      [`${RAW}/big/repo/${COMMIT_A}/docs/deep/SKILL.md`]: Buffer.from(md),
      [`${RAW}/big/repo/${COMMIT_A}/docs/deep/scripts/go.sh`]: Buffer.from("go\n"),
    });
    const cache = newCache(fetch);
    const listing = await cache.list(github("big", "repo"));
    expect(listing.via).toBe("github-contents");
    expect(listing.skills.map((skill) => [skill.itemId, skill.filesComplete])).toEqual([
      ["docs/deep", false],
    ]);
    expect(fetch.calls).not.toContain(contents("docs/node_modules"));
    const resolved = await cache.skillDir(github("big", "repo"), "docs/deep");
    expect(resolved?.source).toEqual({ kind: "github", ref: "big/repo", revision: COMMIT_A });
    expect(await fs.readFile(path.join(resolved!.dir, "scripts", "go.sh"), "utf8")).toBe("go\n");
  });

  it("reports a rate limit with its reset time and never downloads an archive", async () => {
    const resetSeconds = 2_000_000;
    const fetch = fakeFetch({
      [ANTHROPIC.treeUrl]: fakeRoute({
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) },
        body: { message: "API rate limit exceeded" },
      }),
    });
    const cache = newCache(fetch, () => resetSeconds * 1000 - 5 * 60_000);
    const error = await cache.list(github("anthropics", "skills")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NativeSkillsError);
    expect((error as NativeSkillsError).code).toBe("source_fetch_failed");
    expect((error as Error).message).toContain(new Date(resetSeconds * 1000).toISOString());
    expect((error as Error).message).toContain("in 5 min");
    expect((error as Error).message).toContain("GITHUB_TOKEN");
    expect(fetch.calls).toEqual([ANTHROPIC.treeUrl]);
    expect((await cache.status(github("anthropics", "skills"))).error).toMatch(/rate limit/);
  });
});

describe("install downloads one skill folder", () => {
  it("fetches only the chosen folder pinned to the browsed commit", async () => {
    const fetch = officialFetch();
    const service = newService(fetch);
    await service.initialize();
    const source = { kind: "official" as const, repo: "anthropics/skills" };
    await service.browse(source);
    fetch.calls.length = 0;
    const { skill } = await service.install({
      item: { source, itemId: "skills/docx" },
      scope: "global",
    });
    expect(fetch.calls.sort()).toEqual([
      `${RAW}/anthropics/skills/${COMMIT_A}/skills/docx/SKILL.md`,
      `${RAW}/anthropics/skills/${COMMIT_A}/skills/docx/tool`,
    ]);
    expect(skill?.source).toEqual({ kind: "github", ref: "anthropics/skills", revision: COMMIT_A });
    const installed = path.join(roots.home, ".agents", "skills", "docx");
    expect((await fs.readdir(installed)).sort()).toEqual(["SKILL.md", "tool"]);
    expect((await fs.stat(path.join(installed, "tool"))).mode & 0o111).not.toBe(0);
    const lock = await fs.readFile(path.join(roots.jdHome, "skills", "lock.json"), "utf8");
    expect(lock).toContain(COMMIT_A);
  });

  it("rejects a listed file escaping the skill folder and writes nothing outside", async () => {
    const repo = githubRepoRoutes("o/r", COMMIT_A, {
      "s/SKILL.md": skillMd("s"),
      "s/../../escape.txt": "x",
    });
    const fetch = fakeFetch(repo.routes);
    const cacheDir = path.join(roots.root, "cache");
    const cache = new RemoteListingCache({ cacheDir, fetch, now: () => 1 });
    const error = await cache.skillDir(github("o", "r"), "s").catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/escapes/);
    await expect(fs.stat(path.join(roots.root, "escape.txt"))).rejects.toThrow();
    await expect(fs.stat(path.join(cacheDir, "escape.txt"))).rejects.toThrow();
  });

  it("refuses a skill above the download limits before fetching files", async () => {
    const fetch = officialFetch();
    const cache = new RemoteListingCache({
      cacheDir: roots.root,
      fetch,
      now: () => 1,
      limits: { maxBytes: 1024 * 1024, maxFiles: 2 },
    });
    const source = github("anthropics", "skills");
    await cache.list(source);
    const before = fetch.calls.length;
    await expect(cache.skillDir(source, "skills/pdf")).rejects.toThrow(/larger than/);
    expect(fetch.calls).toHaveLength(before);
  });
});

describe("listing cache", () => {
  it("serves fresh listings from memory and disk, then revalidates stale ones in background", async () => {
    let now = 1_000_000;
    const fetch = officialFetch();
    const cacheDir = path.join(roots.root, "cache");
    const source = github("anthropics", "skills");
    const cache = new RemoteListingCache({ cacheDir, fetch, now: () => now });
    await cache.list(source);
    const firstCalls = fetch.calls.length;

    now += TEN_MINUTES - 1;
    await cache.list(source);
    // A restarted daemon warms up from disk without the network.
    const restarted = new RemoteListingCache({ cacheDir, fetch, now: () => now });
    expect((await restarted.list(source)).revision).toBe(COMMIT_A);
    expect(fetch.calls).toHaveLength(firstCalls);

    // Stale + unchanged: returned at once, then a conditional request (304).
    now += 2;
    fetch.routes[ANTHROPIC.treeUrl] = ({ headers }) =>
      headers["If-None-Match"] === 'W/"anthropic-1"'
        ? fakeRoute({ status: 304 })
        : fakeRoute({ status: 500 });
    expect((await cache.list(source)).revision).toBe(COMMIT_A);
    await cache.idle();
    expect(fetch.calls.slice(firstCalls)).toEqual([ANTHROPIC.treeUrl]);
    expect((await cache.list(source)).fetchedAtMs).toBe(now);

    // Stale + changed: new commit; unchanged SKILL.md blobs are not downloaded again.
    now += TEN_MINUTES;
    const changed = githubRepoRoutes("anthropics/skills", COMMIT_B, {
      "skills/pdf/SKILL.md": skillMd("pdf"),
      "skills/docx/SKILL.md": skillMd("docx", "Changed."),
    });
    Object.assign(fetch.routes, changed.routes);
    const before = fetch.calls.length;
    expect((await cache.list(source)).revision).toBe(COMMIT_A);
    await cache.idle();
    expect(fetch.calls.slice(before)).toEqual([
      ANTHROPIC.treeUrl,
      `${RAW}/anthropics/skills/${COMMIT_B}/skills/docx/SKILL.md`,
    ]);
    const updated = await cache.list(source);
    expect(updated.revision).toBe(COMMIT_B);
    expect(updated.skills.find((skill) => skill.dir === "skills/docx")?.content).toContain(
      "Changed.",
    );
  });

  it("refresh waits for a fresh listing", async () => {
    const fetch = officialFetch();
    const cache = newCache(fetch);
    const source = github("anthropics", "skills");
    await cache.list(source);
    const changed = githubRepoRoutes("anthropics/skills", COMMIT_B, {
      "skills/new/SKILL.md": skillMd("new"),
    });
    Object.assign(fetch.routes, changed.routes);
    expect((await cache.list(source)).revision).toBe(COMMIT_A);
    const refreshed = await cache.list(source, { refresh: true });
    expect(refreshed.skills.map((skill) => skill.dir)).toEqual(["skills/new"]);
  });

  it("keeps a stale listing when background revalidation fails", async () => {
    let now = 1;
    const errors: unknown[] = [];
    const fetch = officialFetch();
    const cache = new RemoteListingCache({
      cacheDir: roots.root,
      fetch,
      now: () => now,
      onBackgroundError: (error) => errors.push(error),
    });
    const source = github("anthropics", "skills");
    await cache.list(source);
    now += TEN_MINUTES;
    delete fetch.routes[ANTHROPIC.treeUrl];
    expect((await cache.list(source)).revision).toBe(COMMIT_A);
    await cache.idle();
    expect(errors).toHaveLength(1);
    expect((await cache.list(source)).revision).toBe(COMMIT_A);
    expect((await cache.status(source)).error).toMatch(/not found/);
  });

  it("does not list an unchanged npm version again", async () => {
    let now = 1;
    const latest = "https://registry.npmjs.org/skill-pack/latest";
    const files = "https://data.jsdelivr.com/v1/packages/npm/skill-pack@1.0.0?structure=flat";
    const md = "https://cdn.jsdelivr.net/npm/skill-pack@1.0.0/SKILL.md";
    const fetch = fakeFetch({
      [latest]: { version: "1.0.0", dist: { tarball: "https://registry.npmjs.org/x.tgz" } },
      [files]: { files: [{ name: "/SKILL.md", hash: "h", size: 3 }] },
      [md]: Buffer.from(skillMd("pack")),
    });
    const cache = newCache(fetch, () => now);
    const source: SkillSourceSpec = { kind: "npm", pkg: "skill-pack" };
    expect((await cache.list(source)).skills.map((skill) => skill.itemId)).toEqual(["."]);
    now += TEN_MINUTES;
    await cache.list(source);
    await cache.idle();
    expect(fetch.calls).toEqual([latest, files, md, latest]);
    expect((await cache.list(source)).fetchedAtMs).toBe(now);
  });
});

describe("index and local sources", () => {
  const INDEX_URL = "https://skills.invalid/index.json";

  it("lists an index from its metadata only and installs through the entry's GitHub source", async () => {
    const repo = githubRepoRoutes("owner/repo", COMMIT_A, {
      "skills/pdf/SKILL.md": skillMd("pdf"),
      "skills/pdf/a.md": "a",
      "skills/other/SKILL.md": skillMd("other"),
    });
    const fetch = fakeFetch({
      [INDEX_URL]: {
        skills: [
          { name: "pdf", description: "PDFs.", source: "owner/repo", path: "skills/pdf" },
          { name: "pdf-again", description: "Dup.", source: "owner/repo/skills/pdf" },
          { name: "Bad Name", description: "x", source: "npm:some-pack" },
        ],
      },
      ...repo.routes,
    });
    const cache = newCache(fetch);
    const spec: SkillSourceSpec = { kind: "index", url: INDEX_URL };
    const listing = await cache.list(spec);
    expect(listing.skills.map((skill) => [skill.itemId, skill.name])).toEqual([
      ["owner/repo#skills/pdf", "pdf"],
      ["npm:some-pack#", "Bad Name"],
    ]);
    expect(fetch.calls).toEqual([INDEX_URL]);
    const resolved = await cache.skillDir(spec, "owner/repo#skills/pdf");
    expect(resolved?.source).toEqual({
      kind: "github",
      ref: "owner/repo/skills/pdf",
      revision: COMMIT_A,
    });
    expect((await fs.readdir(resolved!.dir)).sort()).toEqual(["SKILL.md", "a.md"]);
    expect(fetch.calls.filter((url) => url.includes("skills/other"))).toEqual([]);
  });

  it("rejects an index that does not match the schema", async () => {
    const fetch = fakeFetch({ [INDEX_URL]: { items: [] } });
    const error = await newCache(fetch)
      .list({ kind: "index", url: INDEX_URL })
      .catch((e: unknown) => e);
    expect((error as NativeSkillsError).code).toBe("invalid_request");
  });

  it("lists and installs from a local directory", async () => {
    const dir = path.join(roots.root, "my-skills");
    await writeSkill(path.join(dir, "helper"), "name: helper\ndescription: Helps.", "Body\n", {
      "scripts/run.sh": "echo\n",
    });
    const fetch = fakeFetch({});
    const service = newService(fetch);
    await service.initialize();
    const added = await service.addSource(dir, "Mine");
    const items = await service.browse(undefined, { sourceId: added.sourceId });
    expect(items).toMatchObject([
      { itemId: "helper", name: "helper", hasScripts: true, sourceLabel: "Mine" },
    ]);
    const { skill } = await service.install({
      item: { source: items[0]!.source, itemId: "helper" },
      scope: "global",
    });
    expect(skill?.source).toEqual({ kind: "local", ref: path.join(dir, "helper"), revision: null });
    expect(fetch.calls).toEqual([]);
  });
});

describe("configured sources", () => {
  const officialIds = [
    sourceIdFor(github("anthropics", "skills")),
    sourceIdFor(github("openai", "skills")),
  ];

  it("defaults to the official repositories and browses every enabled source merged", async () => {
    const fetch = officialFetch();
    const service = newService(fetch);
    await service.initialize();
    const sources = await service.listSources();
    expect(
      sources.map((source) => [source.sourceId, source.label, source.builtin, source.enabled]),
    ).toEqual([
      [officialIds[0], "anthropics/skills", true, true],
      [officialIds[1], "openai/skills", true, true],
    ]);
    expect(sources[0]).toMatchObject({ lastRefreshMs: null, itemCount: null, error: null });

    const items = await service.browse(undefined);
    expect(items.map((item) => [item.itemId, item.sourceId, item.sourceLabel])).toEqual([
      ["skills/docx", officialIds[0], "anthropics/skills"],
      ["skills/pdf", officialIds[0], "anthropics/skills"],
      ["skills/.curated/lint", officialIds[1], "openai/skills"],
    ]);
    expect(items[0]!.source).toEqual({ kind: "configured", sourceId: officialIds[0] });
    expect((await service.listSources())[0]).toMatchObject({ itemCount: 2, revision: COMMIT_A });

    // Installing through the configured ref works like the official one.
    const { skill } = await service.install({
      item: { source: items[1]!.source, itemId: "skills/pdf" },
      scope: "global",
    });
    expect(skill?.source.revision).toBe(COMMIT_A);
  });

  it("adds, de-duplicates, disables, removes and restores sources", async () => {
    const fetch = officialFetch();
    const service = newService(fetch);
    await service.initialize();
    const changes: number[] = [];
    service.onChange(() => changes.push(1));

    // A sub-path of an official repo: same skill, shown once in the merged browse.
    const sub = await service.addSource(
      "https://github.com/anthropics/skills/tree/HEAD/skills/pdf",
    );
    expect(sub).toMatchObject({ builtin: false, enabled: true, itemCount: 1 });
    expect(changes).toHaveLength(1);
    const merged = await service.browse(undefined);
    expect(merged.filter((item) => item.itemId === "skills/pdf")).toHaveLength(1);

    await service.setSourceEnabled(officialIds[0]!, false);
    const withoutOfficial = await service.browse(undefined);
    expect(withoutOfficial.map((item) => [item.itemId, item.sourceId])).toEqual([
      ["skills/.curated/lint", officialIds[1]],
      ["skills/pdf", sub.sourceId],
    ]);

    await service.removeSource(officialIds[1]!);
    expect((await service.listSources()).map((source) => source.sourceId)).toEqual([
      officialIds[0],
      sub.sourceId,
    ]);
    const saved = JSON.parse(
      await fs.readFile(path.join(roots.jdHome, "skills", "sources.json"), "utf8"),
    );
    expect(saved.sources).toHaveLength(2);

    // Re-adding a default restores it under the same id.
    const restored = await service.addSource("openai/skills");
    expect(restored).toMatchObject({ sourceId: officialIds[1], builtin: true, enabled: true });
    expect(changes).toHaveLength(4);
  });

  it("rejects invalid, empty and unknown sources with clear codes", async () => {
    const empty = githubRepoRoutes("owner/empty", COMMIT_A, { "README.md": "x" });
    const service = newService(fakeFetch({ ...empty.routes }));
    await service.initialize();
    const codeOf = (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved",
        (error: NativeSkillsError) => error.code,
      );
    expect(await codeOf(service.addSource("just-a-word"))).toBe("invalid_request");
    expect(await codeOf(service.addSource("http://insecure.invalid/index.json"))).toBe(
      "invalid_request",
    );
    expect(await codeOf(service.addSource(path.join(roots.root, "missing-dir")))).toBe(
      "invalid_request",
    );
    expect(await codeOf(service.addSource("owner/empty"))).toBe("invalid_request");
    expect(await codeOf(service.addSource("owner/missing"))).toBe("source_fetch_failed");
    expect(await codeOf(service.removeSource("src_unknown"))).toBe("source_not_found");
    expect(await codeOf(service.browse(undefined, { sourceId: "src_unknown" }))).toBe(
      "source_not_found",
    );
    expect((await service.listSources()).map((source) => source.builtin)).toEqual([true, true]);
  });

  it("skips a failing source in a merged browse and reports it in the status", async () => {
    const fetch = fakeFetch({ ...ANTHROPIC.routes });
    const service = newService(fetch);
    await service.initialize();
    const items = await service.browse(undefined);
    expect(items.map((item) => item.sourceId)).toEqual([officialIds[0], officialIds[0]]);
    const status = await service.listSources();
    expect(status[1]!.error).toMatch(/openai\/skills/);
    await expect(service.browse(undefined, { sourceId: officialIds[1] })).rejects.toThrow(
      /openai\/skills/,
    );
  });
});
