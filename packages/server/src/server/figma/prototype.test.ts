import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FigmaPrototype } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaFilePrototypeResponseSchema } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError } from "./context.js";
import {
  buildPrototype,
  collectOverlayDestinations,
  normalizeOverlaySettings,
  normalizePrototypeFile,
} from "./prototype.js";
import { commentsHandlers } from "./handlers/comments.js";
import {
  fakeConnection,
  fakeFile,
  fakeLink,
  fakeRest,
  fakeStore,
  makeFigmaContext,
} from "./test-support/fake-figma.js";

// Normalization tests for prototype data (32.5.3) against a realistic `GET /v1/files/:key`
// sample: flows come from each page's flowStartingPoints, every node's interactions are
// normalized (trigger delay/duration, NODE navigation + transitions, URL, BACK/CLOSE, legacy
// transitionNodeID), and overlay settings only exist behind Figma Link.

const here = path.dirname(fileURLToPath(import.meta.url));

const filePayload = JSON.parse(
  readFileSync(path.join(here, "__fixtures__", "file.prototype.rest.json"), "utf8"),
) as Record<string, unknown>;

const FILE_KEY = "Kx7QmP2vTnYhW3cLdRf5Ba";
const session = { sessionKey: "s1", canRunLoopback: false };

describe("normalizePrototypeFile", () => {
  const { flows, interactions } = normalizePrototypeFile(filePayload);
  const byNode = new Map(
    interactions.map((i) => [`${i.nodeId} ${i.trigger.type} ${i.action.type}`, i]),
  );

  it("collects flow starting points with their page", () => {
    expect(flows).toEqual([
      { nodeId: "1:2", name: "Onboarding", pageId: "0:1" },
      { nodeId: "1:20", name: "Checkout", pageId: "0:1" },
    ]);
  });

  it("normalizes an on-click navigate with a dissolve transition", () => {
    expect(byNode.get("1:3 ON_CLICK NODE")).toMatchObject({
      nodeId: "1:3",
      trigger: { type: "ON_CLICK" },
      action: {
        type: "NODE",
        navigation: "NAVIGATE",
        destinationId: "1:20",
        transition: { type: "DISSOLVE", durationMs: 300, easing: "EASE_IN_AND_OUT" },
      },
    });
  });

  it("keeps trigger delays and expands multi-action reactions into one entry per action", () => {
    const overlay = byNode.get("1:4 MOUSE_ENTER NODE");
    expect(overlay).toMatchObject({
      trigger: { type: "MOUSE_ENTER", delayMs: 500 },
      action: {
        type: "NODE",
        navigation: "OVERLAY",
        destinationId: "1:30",
        transition: {
          type: "PUSH",
          direction: "LEFT",
          durationMs: 400,
          easing: "EASE_OUT",
        },
      },
    });
    const url = byNode.get("1:4 MOUSE_ENTER URL");
    expect(url?.action).toEqual({
      type: "URL",
      url: "https://developers.figma.com/docs/rest-api/",
    });
    expect(url?.trigger).toEqual(overlay?.trigger);
  });

  it("normalizes AFTER_TIMEOUT, media hits, swap/navigate nulls and non-node actions", () => {
    expect(byNode.get("1:20 AFTER_TIMEOUT NODE")).toMatchObject({
      trigger: { type: "AFTER_TIMEOUT", delayMs: 2000 },
      action: {
        type: "NODE",
        navigation: "SWAP",
        destinationId: "1:31",
        transition: { type: "INSTANT" },
      },
    });
    expect(byNode.get("1:20 ON_MEDIA_HIT NODE")).toMatchObject({
      trigger: { type: "ON_MEDIA_HIT", delayMs: 4500 },
      action: {
        type: "NODE",
        navigation: "SCROLL_TO",
        destinationId: "1:21",
        transition: { type: "SCROLL_ANIMATE", durationMs: 0, easing: "LINEAR" },
      },
    });
    expect(byNode.get("1:20 ON_PRESS BACK")).toMatchObject({
      trigger: { type: "ON_PRESS" },
      action: { type: "BACK" },
    });
    expect(byNode.get("1:20 ON_HOVER CLOSE")).toMatchObject({
      action: { type: "CLOSE" },
    });
    expect(byNode.get("1:5 ON_CLICK NODE")).toMatchObject({
      action: { type: "NODE", navigation: "CHANGE_TO", destinationId: "1:5:2", transition: null },
    });
  });

  it("reaches nodes deep inside a frame", () => {
    expect(byNode.get("1:21 ON_CLICK NODE")).toMatchObject({
      action: {
        type: "NODE",
        navigation: "NAVIGATE",
        destinationId: "1:2",
        transition: {
          type: "MOVE_IN",
          direction: "TOP",
          durationMs: 250,
          easing: "CUSTOM_CUBIC_BEZIER(0.42,0,0.58,1)",
        },
      },
    });
  });

  it("synthesizes one interaction from a legacy transitionNodeID, never alongside reactions", () => {
    const legacy = interactions.filter((i) => i.nodeId === "1:25");
    expect(legacy).toEqual([
      {
        nodeId: "1:25",
        trigger: { type: "ON_CLICK" },
        action: {
          type: "NODE",
          navigation: "NAVIGATE",
          destinationId: "1:20",
          transition: { type: "DISSOLVE", durationMs: 250, easing: "LINEAR" },
        },
      },
    ]);
    // 1:20 has both transitionNodeID (a leftover default) and reactions: no synthesized entry.
    expect(interactions.some((i) => i.nodeId === "1:20" && i.trigger.type === "ON_CLICK")).toBe(
      false,
    );
  });

  it("filters to one page when pageId is given", () => {
    const cover = normalizePrototypeFile(filePayload, "0:2");
    expect(cover.flows).toEqual([]);
    expect(cover.interactions).toHaveLength(1);
    expect(cover.interactions[0]).toMatchObject({ nodeId: "2:1" });

    const missing = normalizePrototypeFile(filePayload, "0:99");
    expect(missing).toEqual({ flows: [], interactions: [] });
  });

  it("rejects a payload that is not a file", () => {
    expect(() => normalizePrototypeFile({ name: "empty" })).toThrow(FigmaServiceError);
  });
});

describe("collectOverlayDestinations", () => {
  it("returns the overlay and swap destinations once each, in order", () => {
    const { interactions } = normalizePrototypeFile(filePayload);
    expect(collectOverlayDestinations(interactions)).toEqual(["1:30", "1:31"]);
  });
});

describe("normalizeOverlaySettings", () => {
  const pluginNode = {
    id: "1:30",
    name: "Tooltip",
    type: "FRAME",
    overlayPositionType: "TOP_CENTER",
    overlayBackground: { type: "SOLID_COLOR", color: { r: 0, g: 0, b: 0, a: 0.5 } },
    overlayBackgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE",
  };
  const expected = {
    frameId: "1:30",
    position: "TOP_CENTER",
    background: { type: "SOLID_COLOR", color: "#00000080" },
    closeOnClickOutside: true,
  };

  it("reads the overlay fields from a bare node", () => {
    expect(normalizeOverlaySettings("1:30", pluginNode)).toEqual(expected);
  });

  it("unwraps the node, the REST nodes map, and MCP text content envelopes", () => {
    expect(normalizeOverlaySettings("1:30", { node: pluginNode })).toEqual(expected);
    expect(
      normalizeOverlaySettings("1:30", { nodes: { "1:30": { document: pluginNode } } }),
    ).toEqual(expected);
    expect(
      normalizeOverlaySettings("1:30", {
        content: [{ type: "text", text: JSON.stringify(pluginNode) }],
      }),
    ).toEqual(expected);
  });

  it("marks close-on-click-outside false and keeps a NONE background", () => {
    expect(
      normalizeOverlaySettings("1:31", {
        id: "1:31",
        type: "FRAME",
        overlayPositionType: "CENTER",
        overlayBackground: { type: "NONE" },
        overlayBackgroundInteraction: "NONE",
      }),
    ).toEqual({
      frameId: "1:31",
      position: "CENTER",
      background: { type: "NONE" },
      closeOnClickOutside: false,
    });
  });

  it("defaults the position to CENTER and omits unknown background colors", () => {
    expect(
      normalizeOverlaySettings("1:31", { overlayBackgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE" }),
    ).toEqual({ frameId: "1:31", position: "CENTER", closeOnClickOutside: true });
    expect(
      normalizeOverlaySettings("1:31", {
        overlayPositionType: "MANUAL",
        overlayBackground: { type: "GRADIENT_LINEAR" },
      }),
    ).toEqual({ frameId: "1:31", position: "MANUAL", background: { type: "GRADIENT_LINEAR" } });
  });

  it("returns null when no overlay fields are present", () => {
    expect(normalizeOverlaySettings("1:30", { node: { id: "1:30", type: "FRAME" } })).toBeNull();
    expect(normalizeOverlaySettings("1:30", "not json")).toBeNull();
    expect(normalizeOverlaySettings("1:30", null)).toBeNull();
  });
});

describe("buildPrototype", () => {
  it("reads overlays through the link and flags them available for a linked file", async () => {
    const rest = fakeRest({ getJson: () => filePayload });
    const link = fakeLink({
      linked: true,
      callTool: (_fileKey, tool, args) => {
        if (tool !== "get_node") throw new Error(`unexpected tool ${tool}`);
        const nodeId = args.nodeId as string;
        return {
          node: {
            id: nodeId,
            type: "FRAME",
            overlayPositionType: nodeId === "1:30" ? "TOP_CENTER" : "BOTTOM_RIGHT",
            overlayBackground: { type: "SOLID_COLOR", color: { r: 1, g: 1, b: 1, a: 1 } },
            overlayBackgroundInteraction: "NONE",
          },
        };
      },
    });
    const prototype = await buildPrototype({
      fileKey: FILE_KEY,
      connectionId: "fgc_test",
      rest: rest.rest,
      link: link.link,
    });

    expect(rest.calls[0]).toMatchObject({
      method: "GET",
      path: `/v1/files/${FILE_KEY}`,
      tier: "1",
    });
    expect(prototype.overlaySettingsAvailable).toBe(true);
    expect(prototype.overlays).toEqual([
      {
        frameId: "1:30",
        position: "TOP_CENTER",
        background: { type: "SOLID_COLOR", color: "#FFFFFFFF" },
        closeOnClickOutside: false,
      },
      {
        frameId: "1:31",
        position: "BOTTOM_RIGHT",
        background: { type: "SOLID_COLOR", color: "#FFFFFFFF" },
        closeOnClickOutside: false,
      },
    ]);
    expect(link.calls).toEqual([
      { fileKey: FILE_KEY, tool: "get_node", args: { nodeId: "1:30" } },
      { fileKey: FILE_KEY, tool: "get_node", args: { nodeId: "1:31" } },
    ]);
  });

  it("returns no overlays and flags them unavailable without the link", async () => {
    const rest = fakeRest({ getJson: () => filePayload });
    const link = fakeLink({ linked: false });
    const prototype = await buildPrototype({
      fileKey: FILE_KEY,
      connectionId: "fgc_test",
      pageId: "0:1",
      rest: rest.rest,
      link: link.link,
    });
    expect(prototype.overlays).toEqual([]);
    expect(prototype.overlaySettingsAvailable).toBe(false);
    expect(link.calls).toEqual([]);
  });

  it("serves figma.file.prototype through the handler map and passes the wire schema", async () => {
    const rest = fakeRest({ getJson: () => filePayload });
    const link = fakeLink({
      linked: true,
      callTool: (_fileKey, _tool, args) => ({
        node: { overlayPositionType: "CENTER", overlayBackgroundInteraction: "NONE" },
        nodeId: args.nodeId,
      }),
    });
    const ctx = makeFigmaContext({
      store: fakeStore({
        files: [fakeFile({ fileKey: FILE_KEY })],
        connections: [fakeConnection()],
      }),
      rest: rest.rest,
      link: link.link,
    });
    const result = await commentsHandlers["figma.file.prototype.request"](
      { type: "figma.file.prototype.request", requestId: "r1", fileKey: FILE_KEY, pageId: "0:1" },
      ctx,
      session,
    );
    const prototype = result.prototype as FigmaPrototype;
    expect(prototype.overlaySettingsAvailable).toBe(true);
    expect(prototype.overlays.map((o) => o.frameId)).toEqual(["1:30", "1:31"]);
    expect(() =>
      FigmaFilePrototypeResponseSchema.parse({
        type: "figma.file.prototype.response",
        payload: { requestId: "r1", error: null, prototype },
      }),
    ).not.toThrow();
  });
});
