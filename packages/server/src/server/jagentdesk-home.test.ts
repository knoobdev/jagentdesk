import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolveJAgentDeskHome } from "./jagentdesk-home.js";
import { PRIVATE_DIRECTORY_MODE } from "./private-files.js";

const MODE_MASK = 0o777;

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe.skipIf(process.platform === "win32")("resolveJAgentDeskHome permissions", () => {
  test("creates JAGENTDESK_HOME with private permissions", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "jagentdesk-home-parent-"));
    const jagentdeskHome = path.join(parent, "home");
    try {
      expect(resolveJAgentDeskHome({ JAGENTDESK_HOME: jagentdeskHome })).toBe(jagentdeskHome);
      expect(modeOf(jagentdeskHome)).toBe(PRIVATE_DIRECTORY_MODE);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
