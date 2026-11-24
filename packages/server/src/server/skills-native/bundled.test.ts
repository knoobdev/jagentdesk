import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { resolveBundledSkillsDir } from "./bundled.js";
import { NativeSkillsService } from "./service.js";
import { makeTempRoots, snapshotTree, writeSkill } from "./test-utils/fixtures.js";

const roots = makeTempRoots();
afterEach(async () => {
  await fs.rm(roots.root, { recursive: true, force: true });
});

describe("bundled orchestration skills", () => {
  it("resolves the source bundle and an emitted daemon's packaged bundle", async () => {
    expect(
      await fs.readFile(path.join(resolveBundledSkillsDir(), "jagentdesk", "SKILL.md"), "utf8"),
    ).toContain("name: jagentdesk");
    const bundle = path.join(roots.root, "dist", "server", "skills");
    await fs.mkdir(bundle, { recursive: true });
    const modulePath = path.join(
      roots.root,
      "dist",
      "server",
      "server",
      "skills-native",
      "bundled.js",
    );
    expect(resolveBundledSkillsDir(pathToFileURL(modulePath))).toBe(bundle);
  });

  it("only installs after a hub action, tracks the global Antigravity link and preserves foreign files", async () => {
    const bundle = path.join(roots.root, "bundle");
    await writeSkill(
      path.join(bundle, "jagentdesk"),
      "name: jagentdesk\ndescription: Control your agents.",
    );
    await fs.mkdir(roots.home, { recursive: true });
    const makeService = () =>
      new NativeSkillsService({
        jagentdeskHome: roots.jdHome,
        homeDir: roots.home,
        bundledDir: bundle,
        logger: createTestLogger(),
      });
    const service = makeService();
    await service.initialize();
    const before = await snapshotTree(roots.home);
    const sources = await service.listSources();
    const source = sources.find((entry) => entry.label === "JAgentDesk")!;
    expect(source.builtin).toBe(true);
    const items = await service.browse(undefined, { sourceId: source.sourceId });
    expect(items.map((entry) => entry.name)).toEqual(["jagentdesk"]);
    expect(await snapshotTree(roots.home)).toEqual(before);
    const installed = await service.install({
      item: { source: items[0].source, itemId: items[0].itemId },
      scope: "global",
    });
    const skill = installed.skill!;
    const antigravity = path.join(roots.home, ".gemini", "config", "skills", "jagentdesk");
    expect((await fs.lstat(antigravity)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(antigravity)).toBe(skill.realPath);
    expect(skill.visibleTo).toContain("antigravity");
    await fs.writeFile(path.join(roots.home, ".gemini", "config", "keep"), "foreign");
    const restarted = makeService();
    await restarted.initialize();
    await restarted.setEnabled({ skillId: skill.skillId, enabled: false });
    await expect(fs.lstat(antigravity)).rejects.toMatchObject({ code: "ENOENT" });
    await restarted.setEnabled({ skillId: skill.skillId, enabled: true });
    expect(await fs.realpath(antigravity)).toBe(skill.realPath);
    await restarted.uninstall({ skillId: skill.skillId });
    await expect(fs.lstat(antigravity)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(roots.home, ".gemini", "config", "keep"), "utf8")).toBe(
      "foreign",
    );
    await restarted.removeSource(source.sourceId);
    expect(
      (await makeService().listSources()).some((entry) => entry.sourceId === source.sourceId),
    ).toBe(false);
  });
});
