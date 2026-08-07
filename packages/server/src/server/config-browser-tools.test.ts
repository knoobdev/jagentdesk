import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createJAgentDeskHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-config-browser-tools-"));
  roots.push(root);
  const jagentdeskHome = path.join(root, ".jagentdesk");
  await mkdir(jagentdeskHome, { recursive: true });
  await writeFile(path.join(jagentdeskHome, "config.json"), JSON.stringify(config, null, 2));
  return jagentdeskHome;
}

describe("daemon browser tools config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("defaults browser tools off when config is absent", async () => {
    const home = await createJAgentDeskHome({ version: 1 });

    expect(loadConfig(home, { env: {} }).browserToolsEnabled).toBe(false);
  });

  test("loads browser tools opt-in from persisted daemon config", async () => {
    const home = await createJAgentDeskHome({
      version: 1,
      daemon: { browserTools: { enabled: true } },
    });

    expect(loadConfig(home, { env: {} }).browserToolsEnabled).toBe(true);
  });
});
