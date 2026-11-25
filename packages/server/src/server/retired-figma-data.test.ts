import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeRetiredFigmaData } from "./retired-figma-data.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "jad-retired-figma-"));
  homes.push(home);
  return home;
}

function recordingLogger() {
  const lines: { level: "info" | "warn"; args: unknown[] }[] = [];
  return {
    lines,
    logger: {
      info: (...args: unknown[]) => lines.push({ level: "info", args }),
      warn: (...args: unknown[]) => lines.push({ level: "warn", args }),
    } as unknown as Parameters<typeof removeRetiredFigmaData>[0]["logger"],
  };
}

describe("removeRetiredFigmaData (ADR-0055)", () => {
  it("deletes the stored Figma secrets and cache once, logging one line without secret values", async () => {
    const home = await createHome();
    const dir = path.join(home, "figma");
    await mkdir(path.join(dir, "cache", "nodes"), { recursive: true });
    await writeFile(path.join(dir, "secret.key"), "c2VjcmV0LWtleS1ieXRlcw==");
    await writeFile(path.join(dir, "secrets.json"), '{"oauth":{"data":"sealed-token-value"}}');
    await writeFile(path.join(dir, "cache", "nodes", "1-2.json"), "{}");
    await writeFile(path.join(dir, "connections.json"), "[]");

    const first = recordingLogger();
    await expect(
      removeRetiredFigmaData({ jagentdeskHome: home, logger: first.logger }),
    ).resolves.toBe(true);
    expect(existsSync(path.join(dir, "secret.key"))).toBe(false);
    expect(existsSync(path.join(dir, "secrets.json"))).toBe(false);
    expect(existsSync(path.join(dir, "cache"))).toBe(false);
    // User data the ADR keeps.
    expect(await readFile(path.join(dir, "connections.json"), "utf8")).toBe("[]");
    expect(first.lines).toEqual([
      {
        level: "info",
        args: ["Removed stored Figma credentials and cache (feature removed, ADR-0055)"],
      },
    ]);
    const logged = JSON.stringify(first.lines);
    expect(logged).not.toContain("sealed-token-value");
    expect(logged).not.toContain("c2VjcmV0LWtleS1ieXRlcw==");

    const second = recordingLogger();
    await expect(
      removeRetiredFigmaData({ jagentdeskHome: home, logger: second.logger }),
    ).resolves.toBe(false);
    expect(second.lines).toEqual([]);
  });

  it("does nothing and logs nothing for a home that never used Figma", async () => {
    const home = await createHome();
    const { lines, logger } = recordingLogger();
    await expect(removeRetiredFigmaData({ jagentdeskHome: home, logger })).resolves.toBe(false);
    expect(lines).toEqual([]);
    expect(existsSync(path.join(home, "figma"))).toBe(false);
  });
});
