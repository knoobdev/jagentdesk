import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { extractFrameTextOutlines } from "./text-outlines.js";

/** Export and node data run together. An unsettled export never delays the node response. */
export function prepareFrameTextOutlines(ports: {
  exportSvg: () => Promise<string | null>;
  cacheGlyph: (nodeId: string, svg: string) => Promise<void>;
}): { completed: Promise<void>; finish: (root: FigmaNode | null) => Promise<void> } {
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let ready: string | null | undefined;
  const exported = ports
    .exportSvg()
    .catch(() => null)
    .then((svg) => {
      ready = svg;
      return svg;
    });
  const cache = async (root: FigmaNode, svg: string | null) => {
    try {
      if (!svg) return;
      for (const [id, glyph] of extractFrameTextOutlines(svg, root))
        await ports.cacheGlyph(id, glyph);
    } finally {
      complete();
    }
  };
  return {
    completed,
    async finish(root) {
      if (!root) {
        complete();
        return;
      }
      if (ready !== undefined) await cache(root, ready).catch(() => undefined);
      else void exported.then((svg) => cache(root, svg)).catch(() => undefined);
    },
  };
}
