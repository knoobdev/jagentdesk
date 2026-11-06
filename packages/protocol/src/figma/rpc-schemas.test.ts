import { describe, expect, it } from "vitest";
import { validateWSOutboundMessage } from "../validation/ws-outbound.js";
import {
  FIGMA_REQUEST_TYPES,
  FigmaCommentRegionSchema,
  FigmaCommentSchema,
  FigmaCommentsPostRequestSchema,
  FigmaFileNodesRequestSchema,
  FigmaFileNodesResponseSchema,
  FigmaFilePlaybackRequestSchema,
  FigmaFilePlaybackResponseSchema,
  FigmaFilePrototypeRequestSchema,
  FigmaFilePrototypeResponseSchema,
  FigmaFrameSummarySchema,
  FigmaRemoteAuthBeginRequestSchema,
  FigmaRemoteAuthBeginResponseSchema,
  FigmaRemoteCallResultSchema,
  FigmaRemoteDisconnectRequestSchema,
  FigmaRemoteDisconnectResponseSchema,
  FigmaRemoteExecuteRequestSchema,
  FigmaRemoteExecuteResponseSchema,
  FigmaRemoteReadRequestSchema,
  FigmaRemoteReadResponseSchema,
  FigmaRemoteStatusRequestSchema,
  FigmaRemoteStatusResponseSchema,
  FigmaRemoteStatusSchema,
  FigmaRequestSchemas,
  FigmaResponseSchemas,
  type FigmaNode,
  type FigmaRemoteStatus,
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

// ADR-0039 (32.5.1): SECTION outlines expose summary `parentId`/`childrenLoaded` and a depth=1
// shallow node read. Every field is optional — old outlines and old node requests must parse and
// round-trip exactly as before, and the nodes response shape is untouched.
describe("figma.frame_summary section fields (ADR-0039)", () => {
  const BOUNDS = { x: 0, y: 0, width: 1440, height: 1024 };

  it("still parses a pre-ADR-0039 summary unchanged, with no new keys appearing", () => {
    const legacy = { id: "1:2", name: "Landing", type: "FRAME", bounds: BOUNDS };

    expect(FigmaFrameSummarySchema.parse(legacy)).toEqual(legacy);
    expect(Object.keys(FigmaFrameSummarySchema.parse(legacy))).toEqual([
      "id",
      "name",
      "type",
      "bounds",
    ]);
  });

  it("keeps every pre-ADR-0039 required field required", () => {
    for (const field of ["id", "name", "type", "bounds"] as const) {
      const { [field]: _omitted, ...without } = {
        id: "1:2",
        name: "Landing",
        type: "FRAME",
        bounds: BOUNDS,
      };
      expect(FigmaFrameSummarySchema.safeParse(without).success).toBe(false);
    }
  });

  it("carries SECTION membership on separated child frames", () => {
    const child = {
      id: "1:11",
      name: "Nav",
      type: "FRAME",
      bounds: BOUNDS,
      parentId: "1:10",
    };

    expect(FigmaFrameSummarySchema.parse(child)).toEqual(child);
  });

  it("marks a SECTION cut at the depth=3 boundary childrenLoaded:false, not an empty section", () => {
    const section = {
      id: "1:12",
      name: "Nested section",
      type: "SECTION",
      bounds: BOUNDS,
      parentId: "1:10",
      childrenLoaded: false,
    };
    const loadedSection = { ...section, id: "1:10", name: "Hero section", childrenLoaded: true };

    expect(FigmaFrameSummarySchema.parse(section)).toEqual(section);
    expect(FigmaFrameSummarySchema.parse(loadedSection)).toEqual(loadedSection);
  });

  it("is a plain object schema (wire purity: no transform/catch/preprocess/refine)", () => {
    expect(
      (FigmaFrameSummarySchema as unknown as { _zod: { def: { type: string } } })._zod.def.type,
    ).toBe("object");
  });
});

describe("figma.file.nodes.request depth option (ADR-0039)", () => {
  const base = () => ({
    type: "figma.file.nodes.request",
    requestId: "req-nodes",
    fileKey: "kH8TzQ2mV1",
    ids: ["1:10"],
  });

  it("still parses the old request unchanged when depth is absent", () => {
    expect(FigmaFileNodesRequestSchema.parse(base())).toEqual(base());
  });

  it("accepts depth:1 with a version pinned for the snapshot read", () => {
    const request = { ...base(), version: "1566622199797801477", depth: 1 };

    expect(FigmaFileNodesRequestSchema.parse(request)).toEqual(request);
  });

  it("accepts depth:1 without a version at schema level — the nonempty-version rule is a server handler requirement (W5), not a Zod refine", () => {
    expect(FigmaFileNodesRequestSchema.safeParse({ ...base(), depth: 1 }).success).toBe(true);
    expect(
      FigmaFileNodesRequestSchema.safeParse({ ...base(), version: "", depth: 1 }).success,
    ).toBe(true);
  });

  it("rejects any depth other than the literal 1", () => {
    expect(FigmaFileNodesRequestSchema.safeParse({ ...base(), depth: 2 }).success).toBe(false);
    expect(FigmaFileNodesRequestSchema.safeParse({ ...base(), depth: "1" }).success).toBe(false);
    expect(FigmaFileNodesRequestSchema.safeParse({ ...base(), depth: undefined }).success).toBe(
      true,
    );
  });

  it("keeps the nodes response shape untouched: no depth-related fields", () => {
    expect(Object.keys(FigmaFileNodesResponseSchema.shape.payload.shape)).toEqual([
      "requestId",
      "error",
      "version",
      "source",
      "nodes",
      "components",
      "styles",
    ]);
  });
});

// ADR-0040: five provider-independent write RPCs over the Codex-backed Figma Remote MCP
// connector. Requests/params per the ADR table; the call result is raw MCP content with no
// secrets, since Codex owns the native token. Error responses reuse the existing FigmaError
// envelope, and optional fields must also accept null so FigmaSession's error branch
// (emptyData fills optionals with null) still yields one schema-valid response per request.
describe("figma remote status DTO", () => {
  const STATES: FigmaRemoteStatus["state"][] = [
    "disconnected",
    "connecting",
    "needs_auth",
    "connected",
    "unavailable",
    "error",
  ];

  it("accepts exactly the six documented states", () => {
    for (const state of STATES) {
      expect(FigmaRemoteStatusSchema.parse({ state })).toEqual({ state });
    }
    expect(FigmaRemoteStatusSchema.safeParse({ state: "ready" }).success).toBe(false);
    expect(FigmaRemoteStatusSchema.safeParse({}).success).toBe(false);
  });

  it("keeps message/identityText optional and accepts null for the session error branch", () => {
    const withText = {
      state: "needs_auth",
      message: "Figma editing needs sign-in on the host",
      identityText: "ngocchanh",
    } as const;

    expect(FigmaRemoteStatusSchema.parse(withText)).toEqual(withText);
    expect(FigmaRemoteStatusSchema.safeParse({ state: "connected" }).success).toBe(true);
    expect(
      FigmaRemoteStatusSchema.safeParse({ state: "error", message: null, identityText: null })
        .success,
    ).toBe(true);
  });
});

describe("figma remote call result DTO", () => {
  it("passes raw MCP content through untouched, including nested structures", () => {
    const result = {
      content: [
        { type: "text", text: '{"name":"Landing","id":"1:2"}' },
        "plain string entry",
        42,
        null,
        { type: "image", data: "cG5n", mimeType: "image/png" },
      ],
      structuredContent: { nodes: { "1:2": { id: "1:2", children: [1, 2, 3] } } },
      isError: false,
    };

    expect(FigmaRemoteCallResultSchema.parse(result)).toEqual(result);
  });

  it("accepts minimal and nullable error-branch shapes", () => {
    expect(FigmaRemoteCallResultSchema.parse({ content: [] })).toEqual({ content: [] });
    expect(
      FigmaRemoteCallResultSchema.safeParse({
        content: [],
        structuredContent: null,
        isError: null,
      }).success,
    ).toBe(true);
    expect(FigmaRemoteCallResultSchema.safeParse({ content: {} }).success).toBe(false);
    expect(FigmaRemoteCallResultSchema.safeParse({}).success).toBe(false);
  });

  it("carries no secrets: unknown keys are stripped, never required (ADR-0040 vault ownership)", () => {
    expect(
      FigmaRemoteCallResultSchema.parse({
        content: [],
        token: "figd_secret",
        authHeader: "Bearer …",
      }),
    ).toEqual({ content: [] });
  });
});

describe("figma.remote.status|auth.begin|disconnect RPCs", () => {
  it("parses the three bare requests with only type+requestId", () => {
    const cases = [
      [FigmaRemoteStatusRequestSchema, "figma.remote.status.request"],
      [FigmaRemoteAuthBeginRequestSchema, "figma.remote.auth.begin.request"],
      [FigmaRemoteDisconnectRequestSchema, "figma.remote.disconnect.request"],
    ] as const;

    for (const [schema, type] of cases) {
      expect(schema.parse({ type, requestId: "req-remote" })).toEqual({
        type,
        requestId: "req-remote",
      });
    }
  });

  it("status response returns the status object; error envelope reuses FigmaError", () => {
    const message = {
      type: "figma.remote.status.response",
      payload: { requestId: "req-remote", error: null, status: { state: "connected" } },
    };
    expect(FigmaRemoteStatusResponseSchema.parse(message)).toEqual(message);
    expect(
      FigmaRemoteStatusResponseSchema.safeParse({
        type: "figma.remote.status.response",
        payload: {
          requestId: "req-remote",
          error: { code: "unsupported", message: "Codex app-server mcpServer/tool/call missing." },
          status: { state: "unavailable", message: null, identityText: null },
        },
      }).success,
    ).toBe(true);
  });

  it("auth.begin response carries status plus optional authorizationUrl", () => {
    const withUrl = {
      type: "figma.remote.auth.begin.response",
      payload: {
        requestId: "req-remote",
        error: null,
        status: { state: "connecting" },
        authorizationUrl: "https://www.figma.com/oauth/mcp",
      },
    };
    const withoutUrl = {
      type: "figma.remote.auth.begin.response",
      payload: {
        requestId: "req-remote",
        error: null,
        status: { state: "connected", identityText: "ngocchanh" },
      },
    };

    expect(FigmaRemoteAuthBeginResponseSchema.parse(withUrl)).toEqual(withUrl);
    expect(FigmaRemoteAuthBeginResponseSchema.parse(withoutUrl)).toEqual(withoutUrl);
  });

  it("disconnect response returns the status object", () => {
    const message = {
      type: "figma.remote.disconnect.response",
      payload: {
        requestId: "req-remote",
        error: null,
        status: {
          state: "disconnected",
          message: "Connector stopped; other Codex sessions keep auth.",
        },
      },
    };
    expect(FigmaRemoteDisconnectResponseSchema.parse(message)).toEqual(message);
  });
});

describe("figma.remote.read request and response", () => {
  const base = () => ({
    type: "figma.remote.read.request",
    requestId: "req-read",
    fileKey: "kH8TzQ2mV1",
  });

  it("requires a nonempty fileKey — an empty key cannot target a file", () => {
    const { fileKey: _omitted, ...withoutKey } = base();
    expect(FigmaRemoteReadRequestSchema.safeParse(base()).success).toBe(true);
    expect(FigmaRemoteReadRequestSchema.safeParse(withoutKey).success).toBe(false);
    expect(FigmaRemoteReadRequestSchema.safeParse({ ...base(), fileKey: "" }).success).toBe(false);
    expect(FigmaRemoteReadRequestSchema.safeParse({ ...base(), fileKey: 42 }).success).toBe(false);
  });

  it("accepts an optional nodeId targeting one node", () => {
    expect(FigmaRemoteReadRequestSchema.safeParse({ ...base(), nodeId: "1:2" }).success).toBe(true);
  });

  it("read response returns the raw MCP result", () => {
    const message = {
      type: "figma.remote.read.response",
      payload: {
        requestId: "req-read",
        error: null,
        result: {
          content: [{ type: "text", text: '{"document":{"children":[]}}' }],
          structuredContent: { document: { children: [] } },
          isError: false,
        },
      },
    };
    expect(FigmaRemoteReadResponseSchema.parse(message)).toEqual(message);
  });
});

describe("figma.remote.execute request and response", () => {
  const base = () => ({
    type: "figma.remote.execute.request",
    requestId: "req-execute",
    fileKey: "kH8TzQ2mV1",
    code: 'const f = figma.currentPage.children[0]; f.name = "Landing"; return f.id;',
    description: "Rename the landing frame",
  });

  it("requires fileKey, code and description together", () => {
    expect(FigmaRemoteExecuteRequestSchema.safeParse(base()).success).toBe(true);
    for (const field of ["fileKey", "code", "description"] as const) {
      const { [field]: _omitted, ...without } = base();
      expect(FigmaRemoteExecuteRequestSchema.safeParse(without).success).toBe(false);
    }
    expect(FigmaRemoteExecuteRequestSchema.safeParse({ ...base(), fileKey: "" }).success).toBe(
      false,
    );
  });

  it("caps code at 65536 schema characters (backend adds the UTF-8 byte check)", () => {
    expect(
      FigmaRemoteExecuteRequestSchema.safeParse({ ...base(), code: "a".repeat(65536) }).success,
    ).toBe(true);
    expect(
      FigmaRemoteExecuteRequestSchema.safeParse({ ...base(), code: "a".repeat(65537) }).success,
    ).toBe(false);
  });

  it("requires description 1–1000 characters", () => {
    expect(FigmaRemoteExecuteRequestSchema.safeParse({ ...base(), description: "" }).success).toBe(
      false,
    );
    expect(
      FigmaRemoteExecuteRequestSchema.safeParse({ ...base(), description: "д".repeat(1000) })
        .success,
    ).toBe(true);
    expect(
      FigmaRemoteExecuteRequestSchema.safeParse({ ...base(), description: "d".repeat(1001) })
        .success,
    ).toBe(false);
  });

  it("execute response separates tool reply from readback; readback is optional", () => {
    const withReadback = {
      type: "figma.remote.execute.response",
      payload: {
        requestId: "req-execute",
        error: null,
        result: { content: [{ type: "text", text: "1:2" }], isError: false },
        readback: {
          content: [{ type: "text", text: '{"name":"Landing"}' }],
          structuredContent: { name: "Landing" },
        },
        readbackAvailable: true,
      },
    };
    const unverified = {
      type: "figma.remote.execute.response",
      payload: {
        requestId: "req-execute",
        error: null,
        result: { content: [{ type: "text", text: "1:2" }] },
        readbackAvailable: false,
      },
    };

    expect(FigmaRemoteExecuteResponseSchema.parse(withReadback)).toEqual(withReadback);
    expect(FigmaRemoteExecuteResponseSchema.parse(unverified)).toEqual(unverified);
    // Error-branch shape built by FigmaSession.emptyData.
    expect(
      FigmaRemoteExecuteResponseSchema.safeParse({
        type: "figma.remote.execute.response",
        payload: {
          requestId: "req-execute",
          error: { code: "rate_limited", message: "Figma limited requests." },
          result: { content: [], structuredContent: null, isError: null },
          readback: null,
          readbackAvailable: false,
        },
      }).success,
    ).toBe(true);
  });
});

describe("figma remote RPC registration", () => {
  const REMOTE_REQUEST_TYPES = [
    "figma.remote.status.request",
    "figma.remote.auth.begin.request",
    "figma.remote.disconnect.request",
    "figma.remote.read.request",
    "figma.remote.execute.request",
  ] as const;

  it("registers exactly the five ADR-0040 request types in the allowlist", () => {
    for (const type of REMOTE_REQUEST_TYPES) {
      expect(FIGMA_REQUEST_TYPES).toContain(type);
    }
    expect(FIGMA_REQUEST_TYPES.filter((type) => type.startsWith("figma.remote."))).toEqual([
      ...REMOTE_REQUEST_TYPES,
    ]);
  });

  it("keeps every remote request paired with its response schema (FigmaSession dispatch)", () => {
    const responseTypes = new Set(
      FigmaResponseSchemas.map((schema) => (schema.shape.type as { value: string }).value),
    );

    for (const type of REMOTE_REQUEST_TYPES) {
      expect(responseTypes.has(type.replace(/\.request$/, ".response"))).toBe(true);
    }
  });

  it("adds no remote pushes: readback rides the existing figma.file.changed contract (W3)", () => {
    expect(FIGMA_REQUEST_TYPES.join().includes("figma.remote")).toBe(true);
  });
});

// ── ADR-0041: comment region geometry ─────────────────────────────────────────

const REGION_COMMENT = (region: unknown) => ({
  id: "201",
  parentId: null,
  message: "Region.",
  user: { handle: "ravi", figmaUserId: "450:111" },
  createdAt_ms: 1_774_000_000_000,
  resolvedAt_ms: null,
  nodeId: "23:4",
  offset: { x: 10, y: 20 },
  ...(region === undefined ? {} : { region }),
  reactions: [],
  mine: false,
});

describe("figma comment region DTO (ADR-0041)", () => {
  it("accepts every pin corner with positive finite dimensions", () => {
    for (const pinCorner of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
      expect(FigmaCommentRegionSchema.parse({ width: 200, height: 80.5, pinCorner })).toEqual({
        width: 200,
        height: 80.5,
        pinCorner,
      });
    }
  });

  it("rejects non-positive or non-finite dimensions and non-numbers", () => {
    const good = { width: 10, height: 10, pinCorner: "top-left" };
    expect(FigmaCommentRegionSchema.safeParse({ ...good, width: 0 }).success).toBe(false);
    expect(FigmaCommentRegionSchema.safeParse({ ...good, height: 0 }).success).toBe(false);
    expect(FigmaCommentRegionSchema.safeParse({ ...good, width: -5 }).success).toBe(false);
    expect(FigmaCommentRegionSchema.safeParse({ ...good, height: -0.5 }).success).toBe(false);
    expect(
      FigmaCommentRegionSchema.safeParse({ ...good, width: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(FigmaCommentRegionSchema.safeParse({ ...good, height: Number.NaN }).success).toBe(false);
    expect(FigmaCommentRegionSchema.safeParse({ ...good, width: "10" }).success).toBe(false);
  });

  it("rejects an unknown or missing pinCorner — never a guessed corner", () => {
    expect(
      FigmaCommentRegionSchema.safeParse({ width: 10, height: 10, pinCorner: "middle" }).success,
    ).toBe(false);
    expect(
      FigmaCommentRegionSchema.safeParse({ width: 10, height: 10, pinCorner: null }).success,
    ).toBe(false);
    expect(FigmaCommentRegionSchema.safeParse({ width: 10, height: 10 }).success).toBe(false);
  });

  it("keeps old payloads parsing: region absent, null, or a full region", () => {
    // Pre-ADR-0041 hosts simply omit the field; clients must read that as "no region".
    expect(FigmaCommentSchema.safeParse(REGION_COMMENT(undefined)).success).toBe(true);
    // New responses answer null for point pins.
    expect(FigmaCommentSchema.safeParse(REGION_COMMENT(null)).success).toBe(true);
    expect(
      FigmaCommentSchema.safeParse(
        REGION_COMMENT({ width: 200, height: 80, pinCorner: "bottom-right" }),
      ).success,
    ).toBe(true);
    // A malformed region is a hard failure, not a silent drop.
    expect(FigmaCommentSchema.safeParse(REGION_COMMENT({ width: 0, height: 80 })).success).toBe(
      false,
    );
  });
});

describe("figma.file.comments.post.request region option (ADR-0041)", () => {
  const POST = {
    type: "figma.file.comments.post.request" as const,
    requestId: "req-c",
    fileKey: "kH8TzQ2mV1",
    message: "Pinned region.",
  };

  it("keeps legacy point requests parsing unchanged", () => {
    expect(FigmaCommentsPostRequestSchema.safeParse(POST).success).toBe(true);
    expect(
      FigmaCommentsPostRequestSchema.safeParse({
        ...POST,
        parentId: "101",
        nodeId: "23:4",
        offset: { x: 1, y: 2 },
      }).success,
    ).toBe(true);
  });

  it("accepts an optional well-formed region and refuses a malformed one", () => {
    expect(
      FigmaCommentsPostRequestSchema.safeParse({
        ...POST,
        offset: { x: 1, y: 2 },
        region: { width: 200, height: 80, pinCorner: "top-left" },
      }).success,
    ).toBe(true);
    expect(
      FigmaCommentsPostRequestSchema.safeParse({
        ...POST,
        region: { width: 200, height: 0, pinCorner: "top-left" },
      }).success,
    ).toBe(false);
    expect(
      FigmaCommentsPostRequestSchema.safeParse({
        ...POST,
        region: { width: 200, height: 80, pinCorner: "north-east" },
      }).success,
    ).toBe(false);
    expect(
      FigmaCommentsPostRequestSchema.safeParse({ ...POST, region: { width: 1, height: 2 } })
        .success,
    ).toBe(false); // pinCorner required: no guessed default on the wire
  });
});

describe("outbound deep validation of region comments (zod-aot)", () => {
  // The client's hot path validates daemon→client traffic with the generated ws-outbound
  // validator; responses ride inside a `session` envelope under `message`.
  const LIST_RESPONSE = (comments: unknown[]) => ({
    type: "session",
    message: {
      type: "figma.file.comments.list.response",
      payload: { requestId: "req-l", error: null, comments },
    },
  });

  it("accepts a region-carrying comments list response and an old field-less payload", () => {
    const withRegion = validateWSOutboundMessage(
      LIST_RESPONSE([REGION_COMMENT({ width: 200, height: 80, pinCorner: "bottom-left" })]),
    );
    expect(withRegion.success).toBe(true);
    const legacy = validateWSOutboundMessage(LIST_RESPONSE([REGION_COMMENT(undefined)]));
    expect(legacy.success).toBe(true);
    const point = validateWSOutboundMessage(LIST_RESPONSE([REGION_COMMENT(null)]));
    expect(point.success).toBe(true);
  });

  it("rejects a malformed region through the generated validator, not just runtime zod", () => {
    expect(
      validateWSOutboundMessage(LIST_RESPONSE([REGION_COMMENT({ width: 0, height: 8 })])).success,
    ).toBe(false);
    expect(
      validateWSOutboundMessage(
        LIST_RESPONSE([REGION_COMMENT({ width: 4, height: 8, pinCorner: "side" })]),
      ).success,
    ).toBe(false);
  });
});
