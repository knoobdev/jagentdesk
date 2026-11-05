import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import type { FigmaEditOp } from "@jagentdesk/protocol/figma/rpc-schemas";
import { MemorySecretStore } from "../../database/secret-store.js";
import { FigmaLinkServer } from "./bridge.js";
import { planOp } from "./edit-ops.js";
import { FakePlugin } from "./test-support/fake-plugin.js";
import { describe, expect, it } from "vitest";

const logger = pino({ level: "silent" });

function makeBridge(): Promise<{ bridge: FigmaLinkServer; port: number }> {
  const bridge = new FigmaLinkServer({
    secrets: new MemorySecretStore(),
    dataDir: mkdtempSync(path.join(tmpdir(), "jad-figma-link-")),
    logger,
    port: 0,
    autoInstall: false,
  });
  return bridge.start().then((started) => {
    if (!started.ok) throw new Error("bridge failed to bind");
    return { bridge, port: started.port };
  });
}

describe("planOp — FigmaEditOp → Forge tool mapping (32.6)", () => {
  it("maps rename to set_node_properties with the name", () => {
    expect(planOp({ op: "rename", nodeId: "1:2", name: "Hero" })).toMatchObject({
      tool: "set_node_properties",
      nodeIds: ["1:2"],
      params: { name: "Hero" },
    });
  });

  it("maps set_text to set_text_content using the plugin's text param", () => {
    expect(planOp({ op: "set_text", nodeId: "1:2", characters: "Hello" })).toMatchObject({
      tool: "set_text_content",
      nodeIds: ["1:2"],
      params: { text: "Hello" },
    });
  });

  it("maps set_visible to set_node_visibility items", () => {
    expect(planOp({ op: "set_visible", nodeId: "1:2", visible: false })).toMatchObject({
      tool: "set_node_visibility",
      params: { items: [{ nodeId: "1:2", visible: false }] },
    });
  });

  it("maps set_fill to set_solid_fill with a hex color and opacity only when transparent", () => {
    const opaque = planOp({
      op: "set_fill",
      nodeId: "1:2",
      color: { r: 1, g: 0.5, b: 0, a: 1 },
    });
    expect(opaque).toMatchObject({
      tool: "set_solid_fill",
      nodeIds: ["1:2"],
      params: { hex: "#ff8000" },
    });
    expect(opaque.params).not.toHaveProperty("opacity");

    const translucent = planOp({
      op: "set_fill",
      nodeId: "1:2",
      color: { r: 0, g: 0, b: 0, a: 0.5 },
    });
    expect(translucent.params).toMatchObject({ hex: "#000000", opacity: 0.5 });
  });

  it("maps locked state to lock_nodes / unlock_nodes", () => {
    expect(planOp({ op: "set_locked", nodeId: "1:2", locked: true })).toMatchObject({
      tool: "lock_nodes",
      nodeIds: ["1:2"],
    });
    expect(planOp({ op: "set_locked", nodeId: "1:2", locked: false })).toMatchObject({
      tool: "unlock_nodes",
      nodeIds: ["1:2"],
    });
  });

  it("maps reorder to an index-based reorder_nodes", () => {
    expect(planOp({ op: "reorder", nodeId: "1:2", index: 3 })).toMatchObject({
      tool: "reorder_nodes",
      nodeIds: ["1:2"],
      params: { order: "index", index: 3 },
    });
  });

  it("maps delete to delete_nodes with the confirm param the plugin demands", () => {
    expect(planOp({ op: "delete", nodeId: "1:2" })).toMatchObject({
      tool: "delete_nodes",
      nodeIds: ["1:2"],
      params: { confirm: true },
    });
  });

  it("maps create_node kinds to their create_* tools, registering the tempId", () => {
    expect(
      planOp({
        op: "create_node",
        parentId: "0:1",
        kind: "FRAME",
        tempId: "t1",
        x: 0,
        y: 0,
        width: 10,
        height: 20,
      }),
    ).toMatchObject({
      tool: "create_frame",
      tempId: "t1",
      params: { parentId: "0:1", width: 10, height: 20 },
    });
    expect(
      planOp({
        op: "create_node",
        parentId: "0:1",
        kind: "TEXT",
        tempId: "t2",
        x: 0,
        y: 0,
        width: 10,
        height: 20,
        characters: "Hi",
      }),
    ).toMatchObject({ tool: "create_text", tempId: "t2", params: { characters: "Hi" } });
    expect(
      planOp({
        op: "create_node",
        parentId: "0:1",
        kind: "RECTANGLE",
        tempId: "t3",
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      }),
    ).toMatchObject({ tool: "create_shape", tempId: "t3", params: { shapeType: "RECTANGLE" } });
  });

  it("maps component ops to their forge tools", () => {
    expect(planOp({ op: "create_component", nodeId: "1:2", tempId: "c1" })).toMatchObject({
      tool: "create_component",
      nodeIds: ["1:2"],
      tempId: "c1",
    });
    expect(
      planOp({
        op: "create_instance",
        componentId: "1:9",
        parentId: "0:1",
        x: 0,
        y: 0,
        tempId: "i1",
      }),
    ).toMatchObject({ tool: "create_instance", tempId: "i1", params: { componentId: "1:9" } });
    expect(planOp({ op: "swap_instance", nodeId: "1:3", componentId: "1:9" })).toMatchObject({
      tool: "swap_component",
      nodeIds: ["1:3"],
      params: { componentId: "1:9" },
    });
  });

  it("maps set_reaction to set_reactions and null destination to remove_reactions", () => {
    expect(
      planOp({
        op: "set_reaction",
        nodeId: "1:2",
        trigger: "ON_CLICK",
        destinationId: "1:8",
        transition: { type: "SMART_ANIMATE", durationMs: 300, easing: "EASE_IN" },
      }),
    ).toMatchObject({ tool: "set_reactions", nodeIds: ["1:2"] });
    const plan = planOp({
      op: "set_reaction",
      nodeId: "1:2",
      trigger: "ON_CLICK",
      destinationId: "1:8",
    });
    const reactions = (plan.params as { reactions: { action: Record<string, unknown> }[] })
      .reactions;
    expect(reactions[0]?.action).toMatchObject({
      actionType: "NODE",
      destinationId: "1:8",
      transition: { transitionType: "INSTANT" },
    });
    expect(
      planOp({ op: "set_reaction", nodeId: "1:2", trigger: "ON_HOVER", destinationId: null }),
    ).toMatchObject({ tool: "remove_reactions", nodeIds: ["1:2"] });
  });

  it("maps style and variable binds to their forge tools", () => {
    expect(planOp({ op: "apply_style", nodeId: "1:2", styleId: "S:1" })).toMatchObject({
      tool: "apply_style_to_node",
      params: { styleId: "S:1" },
    });
    expect(
      planOp({ op: "bind_variable", nodeId: "1:2", field: "fillColor", variableId: "V:1" }),
    ).toMatchObject({
      tool: "bind_variable_to_node",
      params: { field: "fillColor", variableId: "V:1" },
    });
  });
});

describe("applyOps — sequential execution with the fake plugin socket", () => {
  it("runs each op as its planned tool and resolves tempIds to real node ids", async () => {
    const { bridge, port } = await makeBridge();
    const plugin = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws` });
    await plugin.connect();
    plugin.hello();
    const required = await plugin.nextFrame("pairing_required");
    await bridge.pair(String(required.code));

    plugin.respond("create_instance", { data: { nodeId: "I12:34" } });
    plugin.respond("set_text_content", { data: { nodeId: "1:2" } });

    const ops: FigmaEditOp[] = [
      { op: "create_instance", componentId: "1:9", parentId: "0:1", x: 0, y: 0, tempId: "newCard" },
      { op: "set_text", nodeId: "newCard", characters: "Hello" },
    ];
    const applied = await bridge.applyOps("fk-1", ops);

    expect(applied).toEqual({
      createdIds: { newCard: "I12:34" },
      results: [{ ok: true }, { ok: true }],
    });
    expect(plugin.requests.map((r) => r.toolName)).toEqual(["create_instance", "set_text_content"]);
    // The second op must target the id the plugin actually created.
    expect(plugin.requests[1]?.nodeIds).toEqual(["I12:34"]);

    await plugin.close();
    await bridge.close();
  });

  it("registers the duplicate from duplicate_nodes[0].nodeId", async () => {
    const { bridge, port } = await makeBridge();
    const plugin = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws` });
    await plugin.connect();
    plugin.hello();
    const required = await plugin.nextFrame("pairing_required");
    await bridge.pair(String(required.code));
    plugin.respond("duplicate_nodes", { data: { duplicates: [{ nodeId: "1:6" }] } });

    const applied = await bridge.applyOps("fk-1", [
      { op: "duplicate", nodeId: "1:2", tempId: "copy" },
    ]);
    expect(applied.createdIds).toEqual({ copy: "1:6" });

    await plugin.close();
    await bridge.close();
  });

  it("reports an op whose prerequisite tempId was never created, without aborting the batch", async () => {
    const { bridge, port } = await makeBridge();
    const plugin = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws` });
    await plugin.connect();
    plugin.hello();
    const required = await plugin.nextFrame("pairing_required");
    await bridge.pair(String(required.code));
    plugin.respond("create_frame", { ok: false, message: "parent is locked" });
    plugin.respond("set_node_visibility", { data: {} });

    const ops: FigmaEditOp[] = [
      {
        op: "create_node",
        parentId: "0:1",
        kind: "FRAME",
        tempId: "box",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      },
      { op: "set_visible", nodeId: "box", visible: false },
      { op: "rename", nodeId: "1:2", name: "Still runs" },
    ];
    const applied = await bridge.applyOps("fk-1", ops);

    expect(applied.results).toEqual([
      { ok: false, message: "parent is locked" },
      { ok: false, message: "Prerequisite node box was never created in this batch" },
      { ok: true },
    ]);
    // The failed prerequisite never reaches the plugin as an id reference.
    expect(plugin.requests.map((r) => r.toolName)).toEqual(["create_frame", "set_node_properties"]);

    await plugin.close();
    await bridge.close();
  });

  it("carries a per-op plugin failure through as that op's message", async () => {
    const { bridge, port } = await makeBridge();
    const plugin = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws` });
    await plugin.connect();
    plugin.hello();
    const required = await plugin.nextFrame("pairing_required");
    await bridge.pair(String(required.code));
    plugin.respond("set_text_content", { ok: false, message: "node is not a TEXT layer" });

    const applied = await bridge.applyOps("fk-1", [
      { op: "set_text", nodeId: "1:2", characters: "Hello" },
    ]);
    expect(applied.results).toEqual([{ ok: false, message: "node is not a TEXT layer" }]);

    await plugin.close();
    await bridge.close();
  });
});
