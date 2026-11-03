import {
  runArchifyRenderer,
  type ArchifyDiagramError,
} from "../../agent-forum/archify-renderer.js";
import { toArchifyJson } from "./archify-json.js";
import type { GraphModel } from "./model.js";

// Renders an activity graph with the vendored archify 3.2.0 (ADR-0031 §1): one child process per
// render, the same sandboxed runtime contract as Team mode (ADR-0021), plus the wide-lifecycle
// switch (vendor/archify-3.2.0/README.md, patch 3).

export type ActivityGraphRenderResult =
  | { ok: true; html: string }
  | { ok: false; errors: ArchifyDiagramError[] };

export type ActivityGraphRenderer = (model: GraphModel) => Promise<ActivityGraphRenderResult>;

export const renderActivityGraph: ActivityGraphRenderer = async (model) => {
  const { diagramType, document } = toArchifyJson(model);
  return runArchifyRenderer({
    vendor: "archify-3.2.0",
    diagramType,
    json: JSON.stringify(document),
    env: { JAD_ARCHIFY_ALLOW_WIDE_LIFECYCLE: "1" },
  });
};
