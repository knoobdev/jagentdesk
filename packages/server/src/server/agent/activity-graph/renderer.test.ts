import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveArchifyVendorDir } from "../../agent-forum/archify-renderer.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { buildFlowGraph, type ActivityRow } from "./flow-builder.js";
import { buildPlanGraph } from "./plan-builder.js";
import { renderActivityGraph } from "./renderer.js";
import { parseSpecKitTasks } from "./spec-plan-source.js";

// Real renders with the vendored archify 3.2.0 (ADR-0031): the generated JSON passes archify's
// validation and layout gates, every node is addressable by data-node-id, and the vendored copy
// carries the ADR-0021 patches.

function turnRows(steps: number): ActivityRow[] {
  const rows: ActivityRow[] = [];
  let seq = 0;
  const push = (item: AgentTimelineItem) => rows.push({ seq: ++seq, item });
  push({ type: "user_message", text: "Fix the flaky login test and add a regression test" });
  push({
    type: "todo",
    items: [
      { id: "1", text: "Reproduce the flaky login test", status: "in_progress", completed: false },
      { id: "2", text: "Patch session expiry handling", status: "pending", completed: false },
    ],
  });
  for (let index = 1; index <= steps; index += 1) {
    push({ type: "reasoning", text: "…" });
    push({
      type: "tool_call",
      callId: `call_${index}`,
      name: "Read",
      status: "completed",
      error: null,
      detail: { type: "read", filePath: `src/module-${index}/index.ts` },
    } as AgentTimelineItem);
  }
  push({
    type: "tool_call",
    callId: "call_task",
    name: "Task",
    status: "running",
    error: null,
    detail: { type: "sub_agent", subAgentType: "Explore", description: "Map the callers", log: "" },
  } as AgentTimelineItem);
  return rows;
}

function nodeIdsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/data-node-id="([^"]+)"/g)].map((match) => match[1]!));
}

describe("renderActivityGraph (archify 3.2.0)", () => {
  it("renders the Flow as a top-down tree with every node addressable", async () => {
    const model = buildFlowGraph({
      rows: turnRows(3),
      running: true,
      permissions: [
        {
          request: { id: "perm_1", name: "Bash", title: "Run the test suite", kind: "tool" },
          state: "pending",
          afterSeq: 9,
        },
      ],
    })!.model;
    const result = await renderActivityGraph(model);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const ids = nodeIdsIn(result.html);
    for (const node of model.nodes) expect(ids.has(node.id)).toBe(true);
    expect(result.html).toContain('data-tree-direction="down"');
  });

  it("renders a capped 40-node turn", async () => {
    const model = buildFlowGraph({ rows: turnRows(60), running: true })!.model;
    expect(model.nodes.length).toBe(40);
    const result = await renderActivityGraph(model);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(nodeIdsIn(result.html).has("earlier")).toBe(true);
  });

  it("renders the Plan tree with Spec mode phases", async () => {
    const plan = parseSpecKitTasks(
      "## Phase 1: Setup\n- [x] T001 Fixtures\n- [ ] T002 [P] Clock helper\n## Phase 2: Core\n- [ ] T003 Patch expiry\n",
    );
    const model = buildPlanGraph({ rows: turnRows(1), running: false }, plan)!.model;
    const result = await renderActivityGraph(model);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const ids = nodeIdsIn(result.html);
    for (const node of model.nodes) expect(ids.has(node.id)).toBe(true);
  });
});

describe("vendor/archify-3.2.0", () => {
  const dir = resolveArchifyVendorDir("archify-3.2.0");

  it("ships no brand-mark catalog and no update check", () => {
    expect(readdirSync(path.join(dir, "renderers", "shared"))).not.toContain(
      "generated-brand-marks.mjs",
    );
    const stub = readFileSync(path.join(dir, "renderers", "shared", "brand-marks.mjs"), "utf8");
    expect(stub).toContain("JAgentDesk vendor patch");
    expect(stub).not.toMatch(/https?:\/\//);
    expect(readdirSync(dir)).not.toContain("bin");
    expect(readdirSync(dir)).not.toContain("scripts");
  });

  it("keeps Team mode on archify 3.0.1 (spec 23)", () => {
    const teamReadme = readFileSync(
      path.join(resolveArchifyVendorDir("archify"), "README.md"),
      "utf8",
    );
    expect(teamReadme).toContain("| Version | 3.0.1 |");
  });
});
