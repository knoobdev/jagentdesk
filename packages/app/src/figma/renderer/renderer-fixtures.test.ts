// Pixel-level proof for the renderer without a browser: every fixture under `__fixtures__/nodes`
// is drawn onto the recording fake context and the exact command stream is compared against the
// committed expectation in `__fixtures__/expected/<name>.json`. Regenerate with
// FIGMA_RENDERER_UPDATE=1 npx vitest run src/figma/renderer/renderer-fixtures.test.ts.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { createFigmaRenderer } from "./index";
import { fakeImage, RecordingContext } from "./__fixtures__/recording-context";
import type { FigmaRenderOptions } from "./types";

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

export function loadNode(name: string): FigmaNode {
  return JSON.parse(readFileSync(path.join(nodesDir, `${name}.json`), "utf8")) as FigmaNode;
}

/** Deterministic options: every image, fallback raster and font resolves. */
export function defaultRenderOptions(overrides?: Partial<FigmaRenderOptions>): FigmaRenderOptions {
  return {
    scale: 2,
    imageForRef: (imageRef) => fakeImage(imageRef, 120, 80) as unknown as CanvasImageSource,
    fallbackForNode: (nodeId) => fakeImage(`raster:${nodeId}`) as unknown as CanvasImageSource,
    fontAvailable: () => true,
    ...overrides,
  };
}

export function recordedOps(node: FigmaNode, options?: Partial<FigmaRenderOptions>): unknown[] {
  const ctx = new RecordingContext();
  createFigmaRenderer().draw(
    ctx as unknown as CanvasRenderingContext2D,
    node,
    defaultRenderOptions(options),
  );
  return ctx.ops;
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
