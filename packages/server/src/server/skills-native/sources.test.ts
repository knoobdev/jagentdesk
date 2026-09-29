import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSkillInvocationLine } from "@jagentdesk/protocol/native-skills";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { prependInvocation } from "../agent/agent-prompt.js";
import { parseSkillMarkdown, readSkillMetadata } from "./frontmatter.js";
import { summarizeCodexConfig } from "./provider-marketplace.js";
import { RemoteListingCache } from "./remote-listing.js";
import { NpmPackageCache, parseRemoteSource } from "./remote-sources.js";
import { NativeSkillsService } from "./service.js";
import { extractTarGz } from "./tar.js";
import { fakeFetch, makeTarGz, makeTempRoots } from "./test-utils/fixtures.js";

let roots: ReturnType<typeof makeTempRoots>;

beforeEach(async () => {
  roots = makeTempRoots();
  await fs.mkdir(roots.home, { recursive: true });
  await fs.mkdir(roots.jdHome, { recursive: true });
});

afterEach(async () => {
  await fs.rm(roots.root, { recursive: true, force: true });
});

describe("parseRemoteSource", () => {
  it.each([
    [
      "anthropics/skills",
      { kind: "github", owner: "anthropics", repo: "skills", ref: null, subpath: null },
    ],
    [
      "owner/repo/skills/one",
      { kind: "github", owner: "owner", repo: "repo", ref: null, subpath: "skills/one" },
    ],
    [
      "https://github.com/owner/repo/tree/v2/skills/x",
      { kind: "github", owner: "owner", repo: "repo", ref: "v2", subpath: "skills/x" },
    ],
    [
      "github:owner/repo.git",
      { kind: "github", owner: "owner", repo: "repo", ref: null, subpath: null },
    ],
    ["npm:skill-pack", { kind: "npm", pkg: "skill-pack" }],
    ["@scope/skill-pack", { kind: "npm", pkg: "@scope/skill-pack" }],
    ["https://www.npmjs.com/package/@scope/skill-pack", { kind: "npm", pkg: "@scope/skill-pack" }],
  ])("parses %s", (input, expected) => {
    expect(parseRemoteSource(input)).toEqual(expected);
  });

  it("rejects unsupported input", () => {
    expect(parseRemoteSource("https://example.invalid/x")).toBeNull();
    expect(parseRemoteSource("just-a-word")).toBeNull();
  });
});

describe("remote sources", () => {
  it("lists an npm package from registry metadata + CDN files and installs from its tarball", async () => {
    const skillMd = "---\nname: lint\ndescription: Lint code.\n---\n\nRun lint.\n";
    const tarball = "https://registry.npmjs.org/@scope/skill-pack/-/skill-pack-1.2.3.tgz";
    const fetch = fakeFetch({
      "https://registry.npmjs.org/@scope%2Fskill-pack/latest": {
        version: "1.2.3",
        dist: { tarball },
      },
      "https://data.jsdelivr.com/v1/packages/npm/@scope/skill-pack@1.2.3?structure=flat": {
        files: [
          { name: "/package.json", hash: "p", size: 10 },
          { name: "/skills/lint/SKILL.md", hash: "h1", size: skillMd.length },
          { name: "/skills/lint/scripts/run.sh", hash: "h2", size: 5 },
        ],
      },
      "https://cdn.jsdelivr.net/npm/@scope/skill-pack@1.2.3/skills/lint/SKILL.md":
        Buffer.from(skillMd),
      [tarball]: makeTarGz(
        { "skills/lint/SKILL.md": skillMd, "skills/lint/scripts/run.sh": "echo\n" },
        { top: "package" },
      ),
    });
    const service = new NativeSkillsService({
      jagentdeskHome: roots.jdHome,
      homeDir: roots.home,
      logger: createTestLogger(),
      fetch,
    });
    await service.initialize();
    const source = { kind: "url" as const, url: "npm:@scope/skill-pack" };
    const items = await service.browse(source);
    expect(items).toMatchObject([
      { itemId: "skills/lint", name: "lint", revision: "1.2.3", hasScripts: true },
    ]);
    // Listing never downloads the tarball.
    expect(fetch.calls).not.toContain(tarball);
    const { skill } = await service.install({
      item: { source, itemId: "skills/lint" },
      scope: "global",
    });
    expect(skill?.source).toEqual({ kind: "npm", ref: "@scope/skill-pack", revision: "1.2.3" });
    expect(fetch.calls.filter((url) => url === tarball)).toHaveLength(1);
    await fs.stat(path.join(roots.home, ".agents", "skills", "lint", "scripts", "run.sh"));
  });

  it("falls back to unpkg when jsDelivr cannot list the package", async () => {
    const skillMd = "---\nname: one\ndescription: One.\n---\n";
    const fetch = fakeFetch({
      "https://registry.npmjs.org/pack/latest": {
        version: "2.0.0",
        dist: { tarball: "https://registry.npmjs.org/pack/-/pack-2.0.0.tgz" },
      },
      "https://unpkg.com/pack@2.0.0/?meta": {
        files: [{ path: "/SKILL.md", size: skillMd.length, integrity: "sha256-x" }],
      },
      "https://unpkg.com/pack@2.0.0/SKILL.md": Buffer.from(skillMd),
    });
    const cache = new RemoteListingCache({ cacheDir: roots.root, fetch, now: () => 1 });
    const listing = await cache.list({ kind: "npm", pkg: "pack" });
    expect(listing.skills.map((skill) => [skill.itemId, skill.content])).toEqual([[".", skillMd]]);
  });

  it("reuses an extracted npm package for the same version only", async () => {
    const v1 = "https://registry.npmjs.org/p/-/p-1.0.0.tgz";
    const v2 = "https://registry.npmjs.org/p/-/p-2.0.0.tgz";
    const fetch = fakeFetch({
      [v1]: makeTarGz({ "a/SKILL.md": "x" }, { top: "package" }),
      [v2]: makeTarGz({ "a/SKILL.md": "y" }, { top: "package" }),
    });
    const cache = new NpmPackageCache(path.join(roots.jdHome, "cache"), fetch, () => 1);
    const source = { kind: "npm" as const, pkg: "p" };
    await cache.materialize(source, { version: "1.0.0", tarball: v1 });
    const again = await cache.materialize(source, { version: "1.0.0", tarball: v1 });
    expect(fetch.calls).toEqual([v1]);
    expect(again.revision).toBe("1.0.0");
    const next = await cache.materialize(source, { version: "2.0.0", tarball: v2 });
    expect(await fs.readFile(path.join(next.root, "a", "SKILL.md"), "utf8")).toBe("y");
  });

  it("rejects archive entries escaping the destination", async () => {
    const archive = makeTarGz({}, { rawEntries: [["top/../../escape.txt", "x"]] });
    await expect(extractTarGz(archive, path.join(roots.root, "out"))).rejects.toThrow(/escapes/);
    await expect(fs.stat(path.join(roots.root, "escape.txt"))).rejects.toThrow();
  });
});

describe("provider marketplaces", () => {
  async function seedMarketplaces(): Promise<void> {
    const claudePlugins = path.join(roots.home, ".claude", "plugins");
    const marketRoot = path.join(claudePlugins, "marketplaces", "official");
    await fs.mkdir(path.join(marketRoot, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(claudePlugins, "known_marketplaces.json"),
      JSON.stringify({ official: { installLocation: marketRoot } }),
    );
    await fs.writeFile(
      path.join(marketRoot, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "official",
        plugins: [
          { name: "gopls-lsp", description: "Go LSP", category: "dev" },
          { name: "frontend", description: "Frontend skills" },
        ],
      }),
    );
    await fs.writeFile(
      path.join(claudePlugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "gopls-lsp@official": [{ scope: "user" }] } }),
    );
    const codexMarket = path.join(roots.root, "codex-market");
    await fs.mkdir(path.join(codexMarket, ".agents", "plugins"), { recursive: true });
    await fs.mkdir(path.join(codexMarket, "plugins", "pdf", ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(codexMarket, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "runtime",
        plugins: [{ name: "pdf", source: { source: "local", path: "./plugins/pdf" } }],
      }),
    );
    await fs.writeFile(
      path.join(codexMarket, "plugins", "pdf", ".codex-plugin", "plugin.json"),
      JSON.stringify({ description: "Read PDFs" }),
    );
    await fs.mkdir(path.join(roots.home, ".codex"), { recursive: true });
    await fs.writeFile(
      path.join(roots.home, ".codex", "config.toml"),
      `model = "x"\n\n[marketplaces.runtime]\nsource_type = "local"\nsource = "${codexMarket}"\n\n[plugins."pdf@runtime"]\nenabled = true\n`,
    );
  }

  it("lists plugins from the manifests the provider CLIs saved and installs via the CLI", async () => {
    await seedMarketplaces();
    const commands: Array<{ command: string; args: string[]; cwd: string | null }> = [];
    const service = new NativeSkillsService({
      jagentdeskHome: roots.jdHome,
      homeDir: roots.home,
      logger: createTestLogger(),
      fetch: fakeFetch({}),
      runCommand: async (command, args, options) => {
        commands.push({ command, args, cwd: options.cwd });
        return { exitCode: 0, stdout: "Installed", stderr: "" };
      },
    });
    await service.initialize();
    const items = await service.browse({ kind: "provider-marketplace" });
    expect(
      items.map((item) => [item.itemId, item.provider, item.installed, item.description]),
    ).toEqual([
      ["gopls-lsp@official", "claude", true, "Go LSP"],
      ["frontend@official", "claude", false, "Frontend skills"],
      ["pdf@runtime", "codex", true, "Read PDFs"],
    ]);

    const project = path.join(roots.root, "project");
    await fs.mkdir(project);
    const result = await service.install({
      item: {
        source: { kind: "provider-marketplace", provider: "claude" },
        itemId: "frontend@official",
      },
      scope: "project",
      cwd: project,
    });
    expect(result.skill).toBeNull();
    expect(result.plugin).toMatchObject({ ok: true, stdout: "Installed" });
    expect(commands).toEqual([
      {
        command: "claude",
        args: ["plugin", "install", "frontend@official", "--scope", "project"],
        cwd: project,
      },
    ]);
    await service.install({
      item: { source: { kind: "provider-marketplace", provider: "codex" }, itemId: "pdf@runtime" },
      scope: "global",
    });
    expect(commands[1]).toEqual({
      command: "codex",
      args: ["plugin", "add", "pdf@runtime"],
      cwd: null,
    });
  });

  it("summarizes the codex config tables it needs", () => {
    const summary = summarizeCodexConfig(
      '[marketplaces."a-b"]\nsource = "/x"\n[plugins."p@a-b"]\nenabled = false\n[plugins.q]\nenabled = true\n',
    );
    expect([...summary.marketplaceSources]).toEqual([["a-b", "/x"]]);
    expect([...summary.enabledPlugins]).toEqual(["q"]);
  });
});

describe("frontmatter", () => {
  it("reads folded, literal and nested values", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: pdf\ndescription: >\n  Work with\n  PDF files.\nlicense: 'MIT'\nmetadata:\n  author: someone\nallowed-tools: [Read, Bash]\n---\nBody\n",
    );
    expect(parsed.frontmatter).toEqual({
      name: "pdf",
      description: "Work with PDF files.",
      license: "MIT",
      metadata: { author: "someone" },
      "allowed-tools": ["Read", "Bash"],
    });
    expect(parsed.body).toBe("Body\n");
    expect(readSkillMetadata(parsed.frontmatter).invalidReason).toBeNull();
  });

  it("flags invalid names", () => {
    const meta = readSkillMetadata({ name: "My Skill", description: "x" });
    expect(meta.invalidReason).toMatch(/Invalid name/);
  });
});

describe("multi-skill invocation (spec 22.7)", () => {
  const cases: Array<{ provider: string; one: string; two: string; three: string }> = [
    {
      provider: "claude",
      one: "/a",
      two: "/a\nBefore you answer, load this skill with the Skill tool: `b`.",
      three: "/a\nBefore you answer, load these skills with the Skill tool: `b`, `c`.",
    },
    ...["cursor", "copilot", "kiro"].map((provider) => ({
      provider,
      one: "/a",
      two: "/a\nBefore you answer, load this skill: `b`.",
      three: "/a\nBefore you answer, load these skills: `b`, `c`.",
    })),
    ...["pi", "omp", "kimi"].map((provider) => ({
      provider,
      one: "/skill:a",
      two: "/skill:a\nBefore you answer, load this skill: `b`.",
      three: "/skill:a\nBefore you answer, load these skills: `b`, `c`.",
    })),
    { provider: "codex", one: "$a", two: "$a $b", three: "$a $b $c" },
    ...["opencode", "some-acp"].map((provider) => ({
      provider,
      one: "Before you answer, load this skill: `a`.",
      two: "Before you answer, load these skills: `a`, `b`.",
      three: "Before you answer, load these skills: `a`, `b`, `c`.",
    })),
  ];

  it.each(cases)("$provider: 1, 2 and 3 skills", ({ provider, one, two, three }) => {
    expect(buildSkillInvocationLine(provider, [])).toBe("");
    expect(buildSkillInvocationLine(provider, ["a"])).toBe(one);
    expect(buildSkillInvocationLine(provider, ["a", "b"])).toBe(two);
    expect(buildSkillInvocationLine(provider, ["a", "b", "c"])).toBe(three);
  });

  it("emits only one leading command for slash providers", () => {
    const line = buildSkillInvocationLine("claude", ["a", "b", "c", "b"]);
    expect(line.match(/^\//gm)).toHaveLength(1);
    expect(prependInvocation("Fix it", line)).toBe(
      "/a\nBefore you answer, load these skills with the Skill tool: `b`, `c`.\n\nFix it",
    );
  });
});

describe("prompt prefix (spec 22.7)", () => {
  it("prefixes string and block prompts", () => {
    const line = buildSkillInvocationLine("codex", ["a", "b", "a"]);
    expect(line).toBe("$a $b");
    expect(prependInvocation("Fix it", line)).toBe("$a $b\n\nFix it");
    expect(prependInvocation("", "/x")).toBe("/x");
    expect(
      prependInvocation(
        [
          { type: "image", data: "d", mimeType: "image/png" },
          { type: "text", text: "Look" },
        ],
        "/x",
      ),
    ).toEqual([
      { type: "image", data: "d", mimeType: "image/png" },
      { type: "text", text: "/x\n\nLook" },
    ]);
    expect(prependInvocation("unchanged", "")).toBe("unchanged");
  });
});
