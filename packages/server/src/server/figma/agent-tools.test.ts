/**
 * Figma agent tools (spec 32.7) — classification, permission flow, run_script
 * gate, queue hand-off, comments, render content, compaction, CSS generation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import type { FigmaService } from "./service.js";
import type { FigmaContext, FigmaNode } from "./context.js";
import {
  createFigmaAgentTools,
  figmaNodeToCss,
  FIGMA_FORGE_TOOLS,
  FIGMA_READ_TOOL_NAMES,
  type FigmaAgentTool,
} from "./agent-tools.js";
import {
  FakeFigmaLink,
  FakeFigmaRest,
  FakeFigmaStore,
  fakeFigmaContext,
  fakeFile,
} from "./test-support/fake-figma-queue.js";

const logger = pino({ level: "silent" });
const FILE_KEY = "AbC123xyz";

interface PermissionAsk {
  agentId: string;
  name: string;
  title: string;
}

interface Harness {
  ctx: FigmaContext;
  link: FakeFigmaLink;
  rest: FakeFigmaRest;
  store: FakeFigmaStore;
  asks: PermissionAsk[];
  decide: (behavior: "allow" | "deny") => void;
  tool: (name: string) => FigmaAgentTool;
  run: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ isError?: boolean; content: { type: string; text?: string; data?: string }[] }>;
}

let home: string;
let harnesses: Harness[];

function setup(opts?: {
  linked?: boolean;
  runScriptEnabled?: boolean;
  lastVersion?: string;
  node?: FigmaNode;
}): Harness {
  const store = new FakeFigmaStore();
  store.files.set(
    FILE_KEY,
    fakeFile({ fileKey: FILE_KEY, lastVersion: opts?.lastVersion ?? "171:2", lastModified_ms: 1 }),
  );
  const rest = new FakeFigmaRest();
  const link = new FakeFigmaLink();
  if (opts?.linked !== false) link.setLinked(FILE_KEY);
  if (opts?.runScriptEnabled !== undefined) link.runScriptEnabled = opts.runScriptEnabled;
  if (opts?.node) link.setNode(FILE_KEY, opts.node);
  const { ctx } = fakeFigmaContext({ jagentdeskHome: home, logger, store, rest, link });

  const asks: PermissionAsk[] = [];
  let decision: { behavior: "allow" | "deny" } = { behavior: "allow" };
  const tools = createFigmaAgentTools({
    service: { ctx } as unknown as FigmaService,
    callerAgentId: "agent-1",
    requestPermission: async (agentId, request) => {
      asks.push({ agentId, name: request.name, title: request.title });
      return decision.behavior === "allow"
        ? ({ behavior: "allow" } as const)
        : ({ behavior: "deny" } as const);
    },
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const harness: Harness = {
    ctx,
    link,
    rest,
    store,
    asks,
    decide: (behavior) => (decision = { behavior }),
    tool: (name) => {
      const found = byName.get(name);
      if (!found) throw new Error(`no such tool: ${name}`);
      return found;
    },
    run: async (name, input) =>
      (await harness.tool(name).handler(input, undefined as never)) as Awaited<
        ReturnType<Harness["run"]>
      >,
  };
  harnesses.push(harness);
  return harness;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "jad-figma-tools-"));
  harnesses = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("classification (spec 32.7)", () => {
  it("registers every Forge tool as figma_link_* with the right permission class", () => {
    const h = setup();
    const read = new Set(FIGMA_READ_TOOL_NAMES);
    expect(h.link).toBeDefined();
    for (const spec of FIGMA_FORGE_TOOLS) {
      const tool = h.tool(`figma_link_${spec.name}`);
      expect(tool.requiresPermission, spec.name).toBe(spec.write);
      expect(read.has(`figma_link_${spec.name}`)).toBe(!spec.write);
    }
    expect(FIGMA_FORGE_TOOLS.length).toBe(100);
  });

  it("named auto-run and named permission tools are classified as researched", () => {
    const read = new Set(FIGMA_READ_TOOL_NAMES);
    for (const name of [
      "get_variable_defs",
      "get_metadata",
      "get_screenshot",
      "audit_design",
      "design_preflight",
      "get_annotations",
      "list_files",
    ]) {
      expect(read.has(`figma_link_${name}`), name).toBe(true);
    }
    for (const name of [
      "set_solid_fill",
      "set_auto_layout",
      "set_variable_value",
      "create_frame",
      "save_screenshots",
      "run_script",
    ]) {
      expect(read.has(`figma_link_${name}`), name).toBe(false);
    }
  });

  it("queue list and REST reads auto-run; queue add and comment require permission", () => {
    const h = setup();
    expect(h.tool("figma_queue_list").requiresPermission).toBe(false);
    expect(h.tool("figma_post_comment").requiresPermission).toBe(true);
    expect(h.tool("figma_queue_ops").requiresPermission).toBe(true);
    expect(h.tool("figma_list_files").requiresPermission).toBe(false);
    expect(h.tool("figma_render_nodes").requiresPermission).toBe(false);
    const read = new Set(FIGMA_READ_TOOL_NAMES);
    for (const name of [
      "figma_list_files",
      "figma_get_file_outline",
      "figma_get_nodes",
      "figma_render_nodes",
      "figma_get_comments",
      "figma_get_versions",
      "figma_get_components",
      "figma_get_styles",
      "figma_inspect_css",
      "figma_get_prototype",
      "figma_queue_list",
    ]) {
      expect(read.has(name), name).toBe(true);
    }
  });

  it("total tool surface is 113", () => {
    const h = setup();
    const tools = createFigmaAgentTools({
      service: { ctx: h.ctx } as unknown as FigmaService,
      callerAgentId: "agent-1",
      requestPermission: async () => ({ behavior: "allow" as const }),
    });
    expect(tools.length).toBe(113);
  });
});

describe("permission flow", () => {
  it("write tool asks permission; denial never reaches the link", async () => {
    const h = setup();
    h.decide("deny");
    const res = await h.run("figma_link_set_auto_layout", {
      fileKey: FILE_KEY,
      args: { mode: "HORIZONTAL" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/denied/i);
    expect(h.link.toolCalls).toEqual([]);
    expect(h.asks).toEqual([
      {
        agentId: "agent-1",
        name: "figma_link_set_auto_layout",
        title: `Edit via Figma Link (set_auto_layout) in ${FILE_KEY}`,
      },
    ]);
  });

  it("approved write reaches the link with the raw Forge tool name", async () => {
    const h = setup();
    await h.run("figma_link_set_solid_fill", { fileKey: FILE_KEY, args: { color: "#fff" } });
    expect(h.link.toolCalls).toEqual([
      { fileKey: FILE_KEY, tool: "set_solid_fill", args: { color: "#fff" } },
    ]);
    expect(h.asks).toHaveLength(1);
  });

  it("read-class link tool runs with no permission ask", async () => {
    const h = setup();
    h.link.callToolResult = { nodes: { "1:2": { document: { opacity: 0.5 } } } };
    const res = await h.run("figma_link_get_metadata", { fileKey: FILE_KEY });
    expect(res.isError).toBeUndefined();
    expect(h.asks).toEqual([]);
    expect(h.link.toolCalls[0]!.tool).toBe("get_metadata");
  });

  it("unlinked file is refused before any call; unknown file is not_found", async () => {
    const h = setup({ linked: false });
    const res = await h.run("figma_link_get_metadata", { fileKey: FILE_KEY });
    expect(res.content[0].text).toMatch(/not connected/i);
    expect(h.link.toolCalls).toEqual([]);

    const h2 = setup();
    const res2 = await h2.run("figma_list_files", {});
    expect(res2.content[0].text).toContain(FILE_KEY);
  });

  it("missing fileKey fails input validation", async () => {
    const h = setup();
    const res = await h.run("figma_link_get_metadata", {});
    expect(res.isError).toBe(true);
    expect(h.asks).toEqual([]);
  });
});

describe("run_script gate", () => {
  it("refused when the plugin's run script is disabled, before any permission ask", async () => {
    const h = setup({ runScriptEnabled: false });
    const res = await h.run("figma_link_run_script", { fileKey: FILE_KEY, args: { code: "1+1" } });
    expect(res.content[0].text).toMatch(/figma_link_run_script is disabled/i);
    expect(h.asks).toEqual([]);
    expect(h.link.toolCalls).toEqual([]);
  });

  it("asks permission when enabled", async () => {
    const h = setup({ runScriptEnabled: true });
    await h.run("figma_link_run_script", { fileKey: FILE_KEY, args: { code: "1+1" } });
    expect(h.asks[0]!.title).toBe(`Run script in ${FILE_KEY}`);
    expect(h.link.toolCalls[0]!.tool).toBe("run_script");
  });
});

describe("figma_queue tools", () => {
  it("add queues an agent-origin op and list shows it", async () => {
    const h = setup({ node: { id: "1:1", name: "Old", type: "RECTANGLE" } as FigmaNode });
    const res = await h.run("figma_queue_ops", {
      fileKey: FILE_KEY,
      ops: [{ op: "rename", nodeId: "1:1", name: "New" }],
    });
    expect(res.content[0].text).toMatch(/Queued 1 change\(s\): fpo_/);
    expect(h.asks[0]!.title).toBe(`Queue 1 Figma change(s) in ${FILE_KEY}`);

    const list = await h.run("figma_queue_list", { fileKey: FILE_KEY });
    expect(list.content[0].text).toContain("[pending] rename 1:1 (agent, base v171:2)");
    expect(h.store.files.get(FILE_KEY)!.lastVersion).toBe("171:2");
  });

  it("list auto-runs without a permission ask", async () => {
    const h = setup();
    await h.run("figma_queue_list", { fileKey: FILE_KEY });
    expect(h.asks).toEqual([]);
  });
});

describe("figma_post_comment", () => {
  it("asks permission then posts via tier 2 with client_meta", async () => {
    const h = setup();
    h.rest.replySend(`/v1/files/${FILE_KEY}/comments`, { id: "c1" });
    const res = await h.run("figma_post_comment", {
      fileKey: FILE_KEY,
      message: "Looks good",
      nodeId: "1:2",
      x: 10,
      y: 20,
    });
    expect(h.asks[0]).toEqual({
      agentId: "agent-1",
      name: "figma_post_comment",
      title: `Comment on ${FILE_KEY}`,
    });
    expect(res.content[0].text).toContain("Comment c1 posted");
    const call = h.rest.calls.find((c) => c.path === `/v1/files/${FILE_KEY}/comments`)!;
    expect(call.tier).toBe("2");
    expect(call.body).toEqual({
      message: "Looks good",
      client_meta: { node_id: "1:2", x: 10, y: 20 },
    });
  });

  it("denied comment never hits REST", async () => {
    const h = setup();
    h.decide("deny");
    const res = await h.run("figma_post_comment", { fileKey: FILE_KEY, message: "Hi" });
    expect(res.content[0].text).toMatch(/denied/i);
    expect(h.rest.calls).toEqual([]);
  });
});

describe("figma_render_nodes", () => {
  it("attaches image content under the size cap and notes oversized renders", async () => {
    const h = setup();
    h.rest.reply(`/v1/images/${FILE_KEY}`, {
      images: { "1:2": "https://fig.example/a.png", "1:3": "https://fig.example/b.png" },
    });
    h.rest.bytes["https://fig.example/a.png"] = { mimeType: "image/png", data: Buffer.from("png") };
    h.rest.bytes["https://fig.example/b.png"] = {
      mimeType: "image/png",
      data: Buffer.alloc(3 * 1024 * 1024),
    };
    const res = await h.run("figma_render_nodes", { fileKey: FILE_KEY, ids: ["1:2", "1:3"] });
    expect(res.content[0].text).toContain("1:2: attached below");
    expect(res.content[0].text).toContain("too large to attach");
    const image = res.content.find((c) => c.type === "image");
    expect(image!.data).toBe(Buffer.from("png").toString("base64"));
  });
});

describe("result compaction", () => {
  it("caps large results with a truncation marker", async () => {
    const h = setup();
    h.link.callToolResult = { giant: "x".repeat(100_000) };
    const res = await h.run("figma_link_get_metadata", { fileKey: FILE_KEY });
    expect(res.content[0].text).toContain("truncated");
    expect(res.content[0].text!.length).toBeLessThan(30_000);
  });

  it("drops heavy geometry keys from payloads", async () => {
    const h = setup();
    h.link.callToolResult = {
      nodes: {
        "1:2": { document: { fillGeometry: [{ path: "M0 0" }], vectorPaths: [], opacity: 1 } },
      },
    };
    const res = await h.run("figma_link_get_metadata", { fileKey: FILE_KEY });
    expect(res.content[0].text).not.toContain("fillGeometry");
    expect(res.content[0].text).toContain("opacity");
  });
});

describe("figmaNodeToCss", () => {
  const solidRect = {
    id: "1:2",
    name: "Surface",
    type: "RECTANGLE",
    cornerRadius: 8,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    strokeWeight: 1,
  } as unknown as FigmaNode;

  it("maps solid fills, radii, and strokes", () => {
    const css = figmaNodeToCss(solidRect);
    expect(css).toContain(".Surface {");
    expect(css).toContain("background-color: #ffffff;");
    expect(css).toContain("border-radius: 8px;");
    expect(css).toContain("border: 1px solid #000000;");
  });

  it("maps partial opacity and alpha colors", () => {
    const css = figmaNodeToCss({ ...solidRect, opacity: 0.5 } as unknown as FigmaNode);
    expect(css).toContain("opacity: 0.5;");
    const alpha = figmaNodeToCss({
      ...solidRect,
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 0.5 } }],
    } as unknown as FigmaNode);
    expect(alpha).toContain("rgba(255, 0, 0, 0.5)");
  });

  it("maps text nodes with font, size, and alignment", () => {
    const css = figmaNodeToCss({
      id: "3:1",
      name: "Label",
      type: "TEXT",
      characters: "Hello world",
      style: { fontFamily: "Inter", fontWeight: 600, fontSize: 14, textAlignHorizontal: "CENTER" },
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    } as unknown as FigmaNode);
    expect(css).toContain('font-family: "Inter";');
    expect(css).toContain("font-size: 14px;");
    expect(css).toContain("text-align: center;");
    expect(css).toContain("color: #000000;");
  });

  it("maps auto-layout frames with gap and padding", () => {
    const css = figmaNodeToCss({
      id: "4:1",
      name: "Row",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      itemSpacing: 12,
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 8,
      paddingBottom: 8,
    } as unknown as FigmaNode);
    expect(css).toContain("display: flex;");
    expect(css).toContain("flex-direction: row;");
    expect(css).toContain("gap: 12px;");
    expect(css).toContain("padding: 8px 16px 8px 16px;");
  });

  it("maps shadows and blurs", () => {
    const css = figmaNodeToCss({
      id: "5:1",
      name: "Card",
      type: "FRAME",
      effects: [
        {
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 1 },
          offset: { x: 0, y: 2 },
          radius: 8,
        },
        { type: "LAYER_BLUR", radius: 4 },
      ],
    } as unknown as FigmaNode);
    expect(css).toContain("box-shadow: 0px 2px 8px #000000;");
    expect(css).toContain("filter: blur(4px);");
  });

  it("maps gradient fills and hidden nodes", () => {
    const css = figmaNodeToCss({
      id: "6:1",
      name: "Band",
      type: "RECTANGLE",
      fills: [
        {
          type: "GRADIENT_LINEAR",
          gradientStops: [
            { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
            { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 },
          ],
        },
      ],
    } as unknown as FigmaNode);
    expect(css).toContain("linear-gradient(#ff0000 0%, #0000ff 100%)");
    const hidden = figmaNodeToCss({ ...solidRect, visible: false } as unknown as FigmaNode);
    expect(hidden).toContain("display: none;");
  });

  it("falls back to a comment for nodes with nothing expressible", () => {
    const css = figmaNodeToCss({
      id: "7:1",
      name: "Empty",
      type: "SECTION",
    } as unknown as FigmaNode);
    expect(css).toContain("/* 7:1 Empty: nothing expressible as CSS */");
  });
});
