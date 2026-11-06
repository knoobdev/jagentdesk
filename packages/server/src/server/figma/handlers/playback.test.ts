import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FigmaFilePlaybackResponseSchema } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError } from "../context.js";
import {
  makeFile,
  makeFigmaApi,
  type FakeFigmaApi,
} from "../test-support/fake-figma-content-api.js";
import { playbackHandlers } from "./playback.js";

// Scoped playback (32.5.3, ADR-0037) against the realistic `GET /v1/files/:key/nodes` sample:
// the handler shares the (fileKey, version) node cache with the canvas, never fetches the
// whole document or the Tier-3 meta when a version is supplied, normalizes interactions from
// the requested subtrees only, takes flows from the cached outline, and treats Figma Link
// overlay metadata as optional. No test touches api.figma.com.

const FILE = "Kx7QmP2vTnYhW3cLdRf5Ba";
const VERSION = "1775068800"; // the fixture's own `version` field
const NODES_PATH = `/v1/files/${FILE}/nodes`;
const FULL_PATH = `/v1/files/${FILE}`;
const META_PATH = `/v1/files/${FILE}/meta`;
const SESSION = { sessionKey: "sess-1", canRunLoopback: false };

const here = path.dirname(fileURLToPath(import.meta.url));
const filePayload = JSON.parse(
  readFileSync(path.join(here, "..", "__fixtures__", "file.prototype.rest.json"), "utf8"),
) as Record<string, unknown>;

/** Every node of the fixture, keyed by id — the ids the `?nodes` endpoint answers for. */
const nodesById = new Map<string, Record<string, unknown>>();
(function walk(node: Record<string, unknown>): void {
  const id = node.id;
  if (typeof id === "string") nodesById.set(id, node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children)
    if (child && typeof child === "object") walk(child as Record<string, unknown>);
})({ ...(filePayload.document as Record<string, unknown>), id: "0:0" });

interface NodeCallLog {
  ids: string[];
  version?: string;
}

interface Fixture {
  api: FakeFigmaApi;
  nodeCalls: NodeCallLog[];
}

let home: string;
let fixture: Fixture;

/** The `GET /v1/files/:key/nodes` shape: each id maps to `{ document }` or null. Ids the
 *  fixture does not contain answer null when they start with `9:`, otherwise a plain frame, so
 *  tests can request subtrees the sample never defines. */
function buildRest(): void {
  fixture.nodeCalls = [];
  fixture.api.rest.respond(NODES_PATH, ({ query }) => {
    const ids = (query.ids ?? "").split(",").filter((id) => id !== "");
    fixture.nodeCalls.push({ ids, version: query.version });
    if (query.version !== VERSION)
      throw new FigmaServiceError("not_found", `fake Figma API has no version ${query.version}`);
    return {
      nodes: Object.fromEntries(
        ids.map((id) => {
          const node = nodesById.get(id);
          if (node) return [id, { document: structuredClone(node) }];
          if (id.startsWith("9:")) return [id, null];
          return [id, { document: { id, name: `Frame ${id}`, type: "FRAME" } }];
        }),
      ),
    };
  });
  // The outline handler's depth=2 full-file read. No `/meta` responder: a Tier-3 lookup would
  // throw, so zero meta calls is proven by the tests passing at all.
  fixture.api.rest.respond(FULL_PATH, structuredClone(filePayload));
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "jad-figma-playback-"));
  fixture = { api: makeFigmaApi({ home, logger: pino({ level: "silent" }) }), nodeCalls: [] };
  fixture.api.store.addFile(makeFile(FILE));
  buildRest();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function playback(frameIds: string[], version = VERSION) {
  return playbackHandlers["figma.file.playback.request"](
    { requestId: "r1", type: "figma.file.playback.request", fileKey: FILE, frameIds, version },
    fixture.api.ctx,
    SESSION,
  );
}

/** Interactions keyed the way prototype.test.ts reads them back. */
function byNode(prototype: {
  interactions: Array<{ nodeId: string; trigger: { type: string }; action: { type: string } }>;
}) {
  return new Map(
    prototype.interactions.map((i) => [`${i.nodeId} ${i.trigger.type} ${i.action.type}`, i]),
  );
}

/** The wire message the session puts around this data (32.9) — must parse exactly. */
function expectWire(response: Awaited<ReturnType<typeof playback>>): void {
  expect(() =>
    FigmaFilePlaybackResponseSchema.parse({
      type: "figma.file.playback.response",
      payload: { requestId: "r1", error: null, ...response },
    }),
  ).not.toThrow();
}

describe("figma.file.playback.request", () => {
  it("loads requested subtrees, edges and flows from the pinned version with no meta or full-graph fetch", async () => {
    const response = await playback(["1:2", "1:20"]);
    expectWire(response);

    // Only the two requested subtrees come back, from one batched Tier-1 nodes call.
    expect(Object.keys(response.frames).sort()).toEqual(["1:2", "1:20"]);
    expect(response.frames["1:2"]).toMatchObject({ name: "Welcome" });
    const calls = fixture.nodeCalls;
    expect(calls).toEqual([{ ids: ["1:2", "1:20"], version: VERSION }]);
    const nodesCall = fixture.api.rest.callsTo(NODES_PATH)[0];
    expect(nodesCall.tier).toBe("1");
    expect(nodesCall.query).toMatchObject({ ids: "1:2,1:20", geometry: "paths", version: VERSION });

    // The pinned version means no Tier-3 metadata resolution, and the only whole-document read
    // is the shared depth=2 outline — never the full graph for interactions.
    expect(fixture.api.rest.callsTo(META_PATH)).toHaveLength(0);
    const fullCalls = fixture.api.rest.callsTo(FULL_PATH);
    expect(fullCalls).toHaveLength(1);
    expect(fullCalls[0].query).toMatchObject({ depth: 2, version: VERSION });
    expect(fixture.api.rest.callsTo(`/v1/images/${FILE}`)).toHaveLength(0);

    // Edges: the requested subtrees only — 1:25 (unrequested sibling) and 2:1 (unrequested
    // page) contribute nothing here.
    expect(response.prototype?.interactions).toHaveLength(9);
    const edges = byNode(response.prototype!);
    expect(edges.get("1:3 ON_CLICK NODE")).toMatchObject({
      action: {
        type: "NODE",
        navigation: "NAVIGATE",
        destinationId: "1:20",
        transition: { type: "DISSOLVE", durationMs: 300, easing: "EASE_IN_AND_OUT" },
      },
    });
    expect(edges.get("1:4 MOUSE_ENTER NODE")).toMatchObject({
      trigger: { type: "MOUSE_ENTER", delayMs: 500 },
      action: { navigation: "OVERLAY", destinationId: "1:30" },
    });
    expect(edges.get("1:4 MOUSE_ENTER URL")).toMatchObject({
      action: { type: "URL", url: "https://developers.figma.com/docs/rest-api/" },
    });
    expect(edges.get("1:5 ON_CLICK NODE")).toMatchObject({
      action: { navigation: "CHANGE_TO", destinationId: "1:5:2", transition: null },
    });
    expect(edges.get("1:20 ON_MEDIA_HIT NODE")).toMatchObject({
      trigger: { type: "ON_MEDIA_HIT", delayMs: 4500 },
      action: {
        navigation: "SCROLL_TO",
        destinationId: "1:21",
        transition: { type: "SCROLL_ANIMATE", easing: "LINEAR", durationMs: 0 },
      },
    });
    expect(edges.get("1:21 ON_CLICK NODE")).toMatchObject({
      action: {
        destinationId: "1:2",
        transition: { easing: "CUSTOM_CUBIC_BEZIER(0.42,0,0.58,1)", durationMs: 250 },
      },
    });
    expect(edges.has("1:25 ON_CLICK NODE")).toBe(false);
    expect(edges.has("2:1 ON_CLICK NODE")).toBe(false);

    // Flows come from the cached outline's pages, not the graph.
    expect(response.prototype?.flows).toEqual([
      { nodeId: "1:2", name: "Onboarding", pageId: "0:1" },
      { nodeId: "1:20", name: "Checkout", pageId: "0:1" },
    ]);

    // REST-only: no Link calls, no overlay metadata claimed.
    expect(response.prototype?.overlays).toEqual([]);
    expect(response.prototype?.overlaySettingsAvailable).toBe(false);
    expect(fixture.api.link.toolCalls).toHaveLength(0);
  });

  it("replays a revisit entirely from the disk cache with no further REST or Link calls", async () => {
    const first = await playback(["1:2", "1:20"]);
    const callCount = fixture.api.rest.calls.length;
    const second = await playback(["1:2", "1:20"]);
    expect(fixture.api.rest.calls).toHaveLength(callCount);
    expect(second).toEqual(first);
  });

  it("fails explicitly on a missing root and never re-asks REST for the cached miss", async () => {
    await expect(playback(["9:9"])).rejects.toThrow(/9:9/);
    expect(fixture.nodeCalls).toEqual([{ ids: ["9:9"], version: VERSION }]);

    // 9:9 is a known-unknown now: the next request must fetch only 1:2, then fail on 9:9 again.
    await expect(playback(["9:9", "1:2"])).rejects.toThrow(/9:9/);
    expect(fixture.nodeCalls[1]).toEqual({ ids: ["1:2"], version: VERSION });
    expect(fixture.api.rest.callsTo(NODES_PATH)).toHaveLength(2);
  });

  it("rejects a blank version or blank frames with invalid_input before any REST call", async () => {
    await expect(playback(["1:2"], "   ")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(playback([" ", ""], VERSION)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fixture.api.rest.calls).toHaveLength(0);
  });

  it("deduplicates ids and keeps batched requests at the nodes handler's bound", async () => {
    const response = await playback([
      "1:2",
      "1:2",
      "1:20",
      "1:25",
      "2:1",
      ...Array.from({ length: 7 }, (_, i) => `4:${i + 1}`),
    ]);
    expect(Object.keys(response.frames)).toHaveLength(11); // the duplicate 1:2 collapsed
    expect(fixture.nodeCalls).toHaveLength(2); // 10 ids + 1, in two batched calls
    expect(fixture.nodeCalls[0].ids).toHaveLength(10);
    expect(fixture.nodeCalls[1].ids).toEqual(["4:7"]);
    // The unrequested 1:25 was requested here, so its legacy navigation shows up.
    expect(byNode(response.prototype!).get("1:25 ON_CLICK NODE")).toMatchObject({
      action: {
        navigation: "NAVIGATE",
        destinationId: "1:20",
        transition: { type: "DISSOLVE", durationMs: 250, easing: "LINEAR" },
      },
    });
  });

  it("passes an explicit older version straight through instead of resolving the live one", async () => {
    await expect(playback(["1:2"], "1775068799")).rejects.toMatchObject({ code: "not_found" });
    expect(fixture.nodeCalls).toEqual([{ ids: ["1:2"], version: "1775068799" }]);
    // The pinned version was asked for as-is: no Tier-3 meta, and the failed nodes read aborts
    // the request before the outline is ever fetched.
    expect(fixture.api.rest.callsTo(META_PATH)).toHaveLength(0);
    expect(fixture.api.rest.callsTo(FULL_PATH)).toHaveLength(0);
  });

  it("fetches overlay metadata only for requested destinations and never the live tree for a pinned version", async () => {
    fixture.api.link.linked.add(FILE);
    fixture.api.link.getNodesImpl = () => ({}); // no plugin document; outline falls back to REST
    fixture.api.link.callTool = async (fileKey, tool, args) => {
      fixture.api.link.toolCalls.push({ fileKey, tool, args });
      if (args.nodeId !== "1:31") return null;
      return {
        node: {
          id: "1:31",
          overlayPositionType: "CENTER",
          overlayBackground: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 0.5 } }],
          overlayBackgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE",
        },
      };
    };
    const response = await playback(["1:2", "1:20", "1:31"]);
    expectWire(response);

    // 1:30 (OVERLAY from 1:4) and 1:31 (SWAP from 1:20) are the destinations in these
    // subtrees; only 1:31 was requested, so only it is asked for.
    const getNode = fixture.api.link.toolCalls.filter((call) => call.tool === "get_node");
    expect(getNode.map((call) => call.args.nodeId)).toEqual(["1:31"]);
    expect(response.prototype?.overlaySettingsAvailable).toBe(true);
    expect(response.prototype?.overlays).toEqual([
      {
        frameId: "1:31",
        position: "CENTER",
        background: { type: "SOLID", color: "#00000080" },
        closeOnClickOutside: true,
      },
    ]);

    // A pinned version is a snapshot: the plugin's live getNodes tree never served it — the
    // frames came from the batched REST call, and the only plugin document read the outline
    // may attempt is the file root, never a frame id.
    for (const call of fixture.api.link.toolCalls.filter((c) => c.tool === "getNodes"))
      expect(call.args.ids).toEqual(["0:0"]);
    expect(fixture.nodeCalls).toEqual([{ ids: ["1:2", "1:20", "1:31"], version: VERSION }]);
  });

  it("degrades to no overlay metadata when the plugin call fails, keeping the playback intact", async () => {
    fixture.api.link.linked.add(FILE);
    fixture.api.link.getNodesImpl = () => ({});
    fixture.api.link.callTool = async (fileKey, tool, args) => {
      fixture.api.link.toolCalls.push({ fileKey, tool, args });
      throw new FigmaServiceError("figma_error", "plugin disconnected");
    };
    const response = await playback(["1:2", "1:20", "1:31"]);
    expectWire(response);
    expect(response.prototype?.overlays).toEqual([]);
    expect(response.prototype?.overlaySettingsAvailable).toBe(false);
    expect(Object.keys(response.frames).sort()).toEqual(["1:2", "1:20", "1:31"]);
    expect(response.prototype?.interactions).toHaveLength(9);
    expect(response.prototype?.flows).toHaveLength(2);
  });

  it("never fetches overlay metadata when no requested frame is an overlay destination", async () => {
    fixture.api.link.linked.add(FILE);
    fixture.api.link.getNodesImpl = () => ({});
    const response = await playback(["1:2", "1:20"]);
    expect(fixture.api.link.toolCalls.filter((call) => call.tool === "get_node")).toHaveLength(0);
    expect(response.prototype?.overlaySettingsAvailable).toBe(false);
  });
});
