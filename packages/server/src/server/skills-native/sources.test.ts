import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSkillInvocationLine } from "@jagentdesk/protocol/native-skills";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { prependInvocation } from "../agent/agent-prompt.js";
import { parseSkillMarkdown, readSkillMetadata } from "./frontmatter.js";
import { summarizeCodexConfig } from "./provider-marketplace.js";
import { parseRemoteSource, RemoteSourceCache } from "./remote-sources.js";
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
  it("browses and installs an npm package source through the registry tarball", async () => {
    const fetch = fakeFetch({
      "https://registry.npmjs.org/@scope%2Fskill-pack/latest": {
        version: "1.2.3",
        dist: { tarball: "https://registry.npmjs.org/@scope/skill-pack/-/skill-pack-1.2.3.tgz" },
      },
      "https://registry.npmjs.org/@scope/skill-pack/-/skill-pack-1.2.3.tgz": makeTarGz(
        { "skills/lint/SKILL.md": "---\nname: lint\ndescription: Lint code.\n---\n\nRun lint.\n" },
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
    expect(items).toMatchObject([{ itemId: "skills/lint", name: "lint", revision: "1.2.3" }]);
    const { skill } = await service.install({
      item: { source, itemId: "skills/lint" },
      scope: "global",
    });
    expect(skill?.source).toEqual({ kind: "npm", ref: "@scope/skill-pack", revision: "1.2.3" });
    // Browse + install reused one download (cache in $JAGENTDESK_HOME/skills/cache).
    expect(fetch.calls).toHaveLength(2);
    await fs.stat(path.join(roots.jdHome, "skills", "cache"));
  });

  it("reuses the extracted tree for 10 minutes, then downloads again", async () => {
    let now = 1_000_000;
    const url = "https://codeload.github.com/o/r/tar.gz/HEAD";
    const fetch = fakeFetch({ [url]: makeTarGz({ "a/SKILL.md": "x" }, { commit: "c1" }) });
    const cache = new RemoteSourceCache(path.join(roots.jdHome, "cache"), fetch, () => now);
    const source = { kind: "github" as const, owner: "o", repo: "r", ref: null, subpath: null };
    await cache.materialize(source);
    now += 9 * 60 * 1000;
    await cache.materialize(source);
    expect(fetch.calls).toHaveLength(1);
    now += 2 * 60 * 1000;
    const again = await cache.materialize(source);
    expect(fetch.calls).toHaveLength(2);
    expect(again.revision).toBe("c1");
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
