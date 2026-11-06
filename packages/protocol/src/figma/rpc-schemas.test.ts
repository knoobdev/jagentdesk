import { describe, expect, it } from "vitest";
import {
  FIGMA_REQUEST_TYPES,
  FigmaFileNodesRequestSchema,
  FigmaFilePlaybackRequestSchema,
  FigmaFilePlaybackResponseSchema,
  FigmaFilePrototypeRequestSchema,
  FigmaFilePrototypeResponseSchema,
  FigmaRequestSchemas,
  FigmaResponseSchemas,
  type FigmaNode,
} from "./rpc-schemas.js";

// ADR-0037: `figma.file.playback.request` carries fileKey, an immutable version and 1–10 frame
// ids; the response returns `frames` (deep node payloads, passthrough like nodes.response) and a
// nullable `prototype`. These tests pin that contract, the schema-array registration that feeds
// the FigmaSession allowlist, and the unchanged legacy prototype RPC.

const PLAYBACK_TYPE = "figma.file.playback.request" as const;
const PLAYBACK_RESPONSE_TYPE = "figma.file.playback.response" as const;

// Figma REST `GET /v1/files/:key/nodes` shape: required id/name/type plus renderer-relevant
// properties the opaque passthrough must deliver untouched.
const HERO_FRAME: FigmaNode = {
  id: "1:2",
  name: "Onboarding",
  type: "FRAME",
  absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
  cornerRadius: 8,
  fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.9, a: 1 } }],
  reactions: [
    {
      trigger: { type: "ON_CLICK" },
      action: { type: "NODE", destinationId: "1:9", navigation: "NAVIGATE" },
    },
  ],
  children: [
    {
      id: "1:3",
      name: "Hero copy",
      type: "TEXT",
      characters: "Welcome to JAgentDesk",
      style: { fontFamily: "Inter", fontSize: 24 },
      children: [{ id: "1:4", name: "Glyph", type: "VECTOR", fillPaints: [], strokes: [] }],
    },
  ],
};

const PROTOTYPE = {
  flows: [{ nodeId: "1:2", name: "Onboarding flow", pageId: "0:1" }],
  interactions: [
    {
      nodeId: "1:2",
      trigger: { type: "ON_CLICK", delayMs: 300 },
      action: {
        type: "NODE",
        navigation: "OVERLAY",
        destinationId: "1:9",
        transition: { type: "MOVE_IN", direction: "LEFT", durationMs: 220, easing: "EASE_IN" },
      },
    },
  ],
  overlays: [
    { frameId: "1:9", position: "CENTER", background: { type: "SOLID", color: "#00000080" } },
  ],
  overlaySettingsAvailable: true,
};

function requestOverride(overrides: Record<string, unknown>) {
  return {
    type: PLAYBACK_TYPE,
    requestId: "req-playback",
    fileKey: "kH8TzQ2mV1",
    frameIds: ["1:2"],
    version: "1566622199797801477",
    ...overrides,
  };
}

function responseOverride(payload: Record<string, unknown>) {
  return {
    type: PLAYBACK_RESPONSE_TYPE,
    payload: { requestId: "req-playback", error: null, frames: {}, prototype: null, ...payload },
  };
}

describe("figma.file.playback.request schema", () => {
  it("parses the full request and round-trips every field", () => {
    expect(FigmaFilePlaybackRequestSchema.parse(requestOverride({}))).toEqual(requestOverride({}));
  });

  it("requires the immutable version (ADR-0037 snapshot pinning)", () => {
    const { version: _version, ...withoutVersion } = requestOverride({});
    expect(FigmaFilePlaybackRequestSchema.safeParse(withoutVersion).success).toBe(false);
    // An empty version reaches the node cache as a truthy-less pin: the read silently falls
    // back to the latest document instead of the outline snapshot.
    expect(FigmaFilePlaybackRequestSchema.safeParse(requestOverride({ version: "" })).success).toBe(
      false,
    );
  });

  it("requires fileKey and requestId", () => {
    expect(
      FigmaFilePlaybackRequestSchema.safeParse(requestOverride({ fileKey: undefined })).success,
    ).toBe(false);
    expect(
      FigmaFilePlaybackRequestSchema.safeParse({ ...requestOverride({}), requestId: 42 }).success,
    ).toBe(false);
  });

  it("accepts 1–10 frame ids and rejects the range edges", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `1:${i + 2}`);
    expect(
      FigmaFilePlaybackRequestSchema.safeParse(requestOverride({ frameIds: ids(1) })).success,
    ).toBe(true);
    expect(
      FigmaFilePlaybackRequestSchema.safeParse(requestOverride({ frameIds: ids(10) })).success,
    ).toBe(true);
    expect(
      FigmaFilePlaybackRequestSchema.safeParse(requestOverride({ frameIds: [] })).success,
    ).toBe(false);
    expect(
      FigmaFilePlaybackRequestSchema.safeParse(requestOverride({ frameIds: ids(11) })).success,
    ).toBe(false);
  });

  it("rejects empty frame-id strings on the playback RPC", () => {
    expect(
      FigmaFilePlaybackRequestSchema.safeParse(requestOverride({ frameIds: [""] })).success,
    ).toBe(false);
    expect(
      FigmaFilePlaybackRequestSchema.safeParse(requestOverride({ frameIds: ["1:2", ""] })).success,
    ).toBe(false);
  });

  it("rejects non-string frame ids", () => {
    expect(
      FigmaFilePlaybackRequestSchema.safeParse(requestOverride({ frameIds: [12] })).success,
    ).toBe(false);
  });

  it("is a plain object schema (wire purity: no transform/catch/preprocess)", () => {
    expect(
      (FigmaFilePlaybackRequestSchema as unknown as { _zod: { def: { type: string } } })._zod.def
        .type,
    ).toBe("object");
  });
});

describe("figma.file.playback.response schema", () => {
  it("passes deep node payloads through untouched, children included", () => {
    const message = responseOverride({ frames: { "1:2": HERO_FRAME } });
    const parsed = FigmaFilePlaybackResponseSchema.parse(message);

    expect(parsed).toEqual(message);
    const frame = parsed.payload.frames["1:2"];
    expect(frame.absoluteBoundingBox).toEqual({ x: 0, y: 0, width: 375, height: 812 });
    expect(frame.children).toHaveLength(1);
    const text = frame.children?.[0] as FigmaNode;
    expect(text.characters).toBe("Welcome to JAgentDesk");
    const glyph = text.children?.[0] as FigmaNode;
    expect(glyph.type).toBe("VECTOR");
    expect(glyph.fillPaints).toEqual([]);
  });

  it("accepts a full prototype (flows/interactions/overlays/overlaySettingsAvailable)", () => {
    const message = responseOverride({
      frames: { "1:2": HERO_FRAME },
      prototype: PROTOTYPE,
    });
    expect(FigmaFilePlaybackResponseSchema.parse(message)).toEqual(message);
  });

  it("accepts prototype: null (REST without overlay metadata) but requires the field", () => {
    expect(
      FigmaFilePlaybackResponseSchema.safeParse(responseOverride({ prototype: null })).success,
    ).toBe(true);
    const { prototype: _prototype, ...payloadWithoutPrototype } = responseOverride({}).payload;
    expect(
      FigmaFilePlaybackResponseSchema.safeParse({
        type: PLAYBACK_RESPONSE_TYPE,
        payload: payloadWithoutPrototype,
      }).success,
    ).toBe(false);
  });

  it("accepts the error branch with empty data, as FigmaSession builds error responses", () => {
    expect(
      FigmaFilePlaybackResponseSchema.safeParse(
        responseOverride({
          error: { code: "not_found", message: "Frame 1:2 is not in this file." },
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects an unknown response type and a missing payload", () => {
    expect(
      FigmaFilePlaybackResponseSchema.safeParse({ ...responseOverride({}), type: "other" }).success,
    ).toBe(false);
    expect(
      FigmaFilePlaybackResponseSchema.safeParse({ type: PLAYBACK_RESPONSE_TYPE }).success,
    ).toBe(false);
  });
});

describe("playback RPC registration", () => {
  it("registers the request and response in the shared schema arrays", () => {
    const requestTypes = FigmaRequestSchemas.map(
      (schema) => (schema.shape.type as { value: string }).value,
    );
    const responseTypes = FigmaResponseSchemas.map(
      (schema) => (schema.shape.type as { value: string }).value,
    );

    expect(requestTypes).toContain(PLAYBACK_TYPE);
    expect(responseTypes).toContain(PLAYBACK_RESPONSE_TYPE);
    expect(FIGMA_REQUEST_TYPES).toContain(PLAYBACK_TYPE);
  });

  it("keeps every registered request paired with a response schema", () => {
    // FigmaSession derives `….response` from `….request` mechanically; an unpaired type throws
    // at `buildResponse` time, so the pairing is a hard registration invariant.
    const responseTypes = new Set(
      FigmaResponseSchemas.map((schema) => (schema.shape.type as { value: string }).value),
    );

    expect(
      FIGMA_REQUEST_TYPES.map(
        (type) => [type, responseTypes.has(type.replace(/\.request$/, ".response"))] as const,
      ),
    ).toEqual(FIGMA_REQUEST_TYPES.map((type) => [type, true] as const));
  });
});

describe("legacy prototype RPC unchanged (ADR-0037 keeps it for existing clients)", () => {
  it("pins the legacy request shape: no version, no frameIds, pageId still optional", () => {
    expect(Object.keys(FigmaFilePrototypeRequestSchema.shape)).toEqual([
      "type",
      "requestId",
      "fileKey",
      "pageId",
    ]);
    expect(
      FigmaFilePrototypeRequestSchema.parse({
        type: "figma.file.prototype.request",
        requestId: "req-legacy",
        fileKey: "kH8TzQ2mV1",
      }),
    ).toEqual({
      type: "figma.file.prototype.request",
      requestId: "req-legacy",
      fileKey: "kH8TzQ2mV1",
    });
  });

  it("pins the legacy response shape: prototype only, no frames", () => {
    expect(Object.keys(FigmaFilePrototypeResponseSchema.shape.payload.shape)).toEqual([
      "requestId",
      "error",
      "prototype",
    ]);
  });

  it("keeps the nodes RPC permissive: playback tightening did not leak to old RPCs", () => {
    // figma.file.nodes.request is the loader playback delegates to; its contract predates
    // ADR-0037 and callers may still send an empty version or empty id strings.
    expect(
      FigmaFileNodesRequestSchema.safeParse({
        type: "figma.file.nodes.request",
        requestId: "req-nodes",
        fileKey: "kH8TzQ2mV1",
        ids: [""],
        version: "",
      }).success,
    ).toBe(true);
  });
});
