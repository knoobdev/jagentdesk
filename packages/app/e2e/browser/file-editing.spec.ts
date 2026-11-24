import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.describe("CodeMirror workspace file editing", () => {
  test("jumps to each relative reference to the same file", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "relative-reference-qa-",
      title: "Relative line references",
      initialPrompt: "Show both references",
      featureValues: {
        mockAssistantResponse: "First `src/router.go:46`. Then `src/router.go:403`.",
      },
    });
    try {
      await mkdir(path.join(session.cwd, "src"));
      await writeFile(
        path.join(session.cwd, "src/router.go"),
        Array.from({ length: 450 }, (_, n) => `// line ${n + 1}`).join("\n"),
      );
      await openAgentRoute(page, session);
      for (const line of [46, 403, 46]) {
        await page
          .getByTestId(`workspace-tab-agent_${session.agentId}`)
          .filter({ visible: true })
          .click();
        await page.getByText(`src/router.go:${line}`, { exact: true }).click();
        await expect(page.getByLabel(`Line ${line}, column 1`)).toBeVisible();
      }
      await page.screenshot({ path: test.info().outputPath("relative-line-target.png") });
    } finally {
      await session.cleanup();
    }
  });
});
