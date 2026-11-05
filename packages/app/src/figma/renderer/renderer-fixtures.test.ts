// Pixel-level proof for the renderer without a browser: every fixture under `__fixtures__/nodes`
// is drawn onto the recording fake context and the exact command stream is compared against the
// committed expectation in `__fixtures__/expected/<name>.json`. Regenerate with
// FIGMA_RENDERER_UPDATE=1 npx vitest run src/figma/renderer/renderer-fixtures.test.ts.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNode, recordedOps } from "./__fixtures__/render-harness";

export { defaultRenderOptions, loadNode, recordedOps } from "./__fixtures__/render-harness";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodesDir = path.join(here, "__fixtures__", "nodes");
const expectedDir = path.join(here, "__fixtures__", "expected");
const update = process.env.FIGMA_RENDERER_UPDATE === "1";

function fixtureNames(): string[] {
  return readdirSync(nodesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

describe("renderer fixture command streams", () => {
  const names = fixtureNames();

  it("has at least 30 fixtures", () => {
    expect(names.length).toBeGreaterThanOrEqual(30);
  });

  it.each(names)("%s draws the exact recorded command stream", (name) => {
    const ops = recordedOps(loadNode(name));
    const expectedPath = path.join(expectedDir, `${name}.json`);
    if (update) {
      if (!existsSync(expectedDir)) mkdirSync(expectedDir, { recursive: true });
      writeFileSync(expectedPath, `${JSON.stringify(ops, null, 2)}\n`);
      return;
    }
    expect(
      existsSync(expectedPath),
      `missing expectation ${expectedPath} (run with FIGMA_RENDERER_UPDATE=1)`,
    ).toBe(true);
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as unknown[];
    expect(ops).toEqual(expected);
  });
});
