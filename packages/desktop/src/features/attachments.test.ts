import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyAttachmentFileToManagedStorage } from "./attachments";

const originalJAgentDeskHome = process.env.JAGENTDESK_HOME;
let testHome: string | null = null;

async function useTempJAgentDeskHome(): Promise<string> {
  testHome = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-desktop-attachments-"));
  process.env.JAGENTDESK_HOME = testHome;
  return testHome;
}

describe("desktop attachment files", () => {
  afterEach(async () => {
    if (originalJAgentDeskHome === undefined) {
      delete process.env.JAGENTDESK_HOME;
    } else {
      process.env.JAGENTDESK_HOME = originalJAgentDeskHome;
    }

    if (testHome) {
      await rm(testHome, { recursive: true, force: true });
      testHome = null;
    }
  });

  it("accepts dot-prefixed picker extensions for managed copies", async () => {
    const jagentdeskHome = await useTempJAgentDeskHome();
    const sourcePath = path.join(jagentdeskHome, "report.md");
    await writeFile(sourcePath, "# Report\n");

    const result = await copyAttachmentFileToManagedStorage({
      attachmentId: "att_markdown",
      sourcePath,
      extension: ".md",
    });

    expect(result).toEqual({
      path: path.join(jagentdeskHome, "desktop-attachments", "att_markdown.md"),
      byteSize: 9,
    });
    await expect(readFile(result.path, "utf8")).resolves.toBe("# Report\n");
  });

  it("normalizes legacy bare extensions for managed copies", async () => {
    const jagentdeskHome = await useTempJAgentDeskHome();
    const sourcePath = path.join(jagentdeskHome, "report.md");
    await writeFile(sourcePath, "# Report\n");

    const result = await copyAttachmentFileToManagedStorage({
      attachmentId: "att_markdown_legacy",
      sourcePath,
      extension: "md",
    });

    expect(result).toEqual({
      path: path.join(jagentdeskHome, "desktop-attachments", "att_markdown_legacy.md"),
      byteSize: 9,
    });
    await expect(readFile(result.path, "utf8")).resolves.toBe("# Report\n");
  });
});
