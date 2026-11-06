import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";
import { WSInboundMessageSchema } from "../../src/messages.js";
import { WSOutboundMessageSchema as GeneratedWSOutboundMessageSchema } from "../../src/generated/validation/ws-outbound.aot.js";

interface GeneratedSchema {
  safeParse(input: unknown): { success: boolean; data?: unknown };
}

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedWSOutboundPath = resolve(
  protocolRoot,
  "src/generated/validation/ws-outbound.aot.ts",
);
const require = createRequire(import.meta.url);

async function compileInlineSchema(sourceSchema: string): Promise<GeneratedSchema> {
  const scratchRoot = resolve(protocolRoot, "../../.tmp");
  await mkdir(scratchRoot, { recursive: true });
  const tempDir = await mkdtemp(join(scratchRoot, "jagentdesk-zod-aot-"));

  try {
    const sourcePath = join(tempDir, "schema.source.js");
    const outputPath = join(tempDir, "schema.generated.ts");
    await writeFile(join(tempDir, "package.json"), '{"type":"module"}\n');
    await writeFile(
      sourcePath,
      [
        'import { z } from "zod";',
        'import { compile } from "zod-aot";',
        sourceSchema,
        "export const Schema = compile(SourceSchema);",
        "",
      ].join("\n"),
    );

    const zodAotEntry = require.resolve("zod-aot");
    const zodAotRoot = resolve(dirname(zodAotEntry), "..");
    const [{ discoverSchemas }, { compileSchemas }, { generateCompiledFileContent }] =
      await Promise.all([
        import(pathToFileURL(resolve(zodAotRoot, "dist/discovery.js")).href),
        import(pathToFileURL(resolve(zodAotRoot, "dist/core/pipeline.js")).href),
        import(pathToFileURL(resolve(zodAotRoot, "dist/cli/emitter.js")).href),
      ]);

    const schemas = await discoverSchemas(sourcePath, { cacheBust: true });
    const compiled = compileSchemas(schemas, { mode: "inline" });
    const content = generateCompiledFileContent(compiled, "./schema.source.js", {
      zodCompat: false,
    });
    await writeFile(outputPath, content);

    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const generated = await jiti.import(outputPath);
    return generated.Schema as GeneratedSchema;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("WS outbound zod-aot validation", () => {
  it("applies defaults inside discriminated-union branches", async () => {
    const schema = await compileInlineSchema(`
const SourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("with_default"),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("without_default"),
    label: z.string(),
  }),
]);
`);

    expect(schema.safeParse({ type: "with_default" })).toMatchObject({
      success: true,
      data: { type: "with_default", enabled: true },
    });
  });

  it("routes tool-call-like status unions through the current sequential item union", async () => {
    const schema = await compileInlineSchema(`
const ToolCallItemSchema = z.discriminatedUnion("status", [
  z.object({ type: z.literal("tool_call"), status: z.literal("running"), callId: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("completed"), callId: z.string(), output: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("failed"), callId: z.string(), error: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("canceled"), callId: z.string() }),
]);

const TimelineItemSchema = z.union([
  z.object({ type: z.literal("assistant_message"), text: z.string() }),
  ToolCallItemSchema,
]);

const SourceSchema = z.object({
  item: TimelineItemSchema,
});
`);

    expect(
      schema.safeParse({ item: { type: "tool_call", status: "running", callId: "run" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "running", callId: "run" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "completed", callId: "done", output: "ok" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "completed", callId: "done", output: "ok" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" } },
    });
    expect(
      schema.safeParse({ item: { type: "tool_call", status: "canceled", callId: "stop" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "canceled", callId: "stop" } },
    });
  });

  it("accepts a minimal valid envelope and rejects a corrupted envelope", () => {
    expect(GeneratedWSOutboundMessageSchema.safeParse({ type: "pong" }).success).toBe(true);
    expect(GeneratedWSOutboundMessageSchema.safeParse({ type: "not_a_message" }).success).toBe(
      false,
    );
  });

  it.each([
    {
      name: "dedicated attention message",
      message: {
        type: "agent_attention_required",
        payload: {
          agentId: "agent-1",
          reason: "finished",
          timestamp: "2026-07-22T18:00:00.000Z",
          shouldNotify: true,
          notification: {
            title: "Agent finished",
            body: "Done",
            data: {
              serverId: "server-1",
              workspaceId: "workspace-1",
              agentId: "agent-1",
              reason: "finished",
            },
          },
        },
      },
    },
    {
      name: "agent stream attention event",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          timestamp: "2026-07-22T18:00:00.000Z",
          event: {
            type: "attention_required",
            provider: "codex",
            reason: "finished",
            timestamp: "2026-07-22T18:00:00.000Z",
            shouldNotify: true,
            notification: {
              title: "Agent finished",
              body: "Done",
              data: {
                serverId: "server-1",
                workspaceId: "workspace-1",
                agentId: "agent-1",
                reason: "finished",
              },
            },
          },
        },
      },
    },
  ])("preserves workspaceId in a $name", ({ message }) => {
    const envelope = { type: "session", message };

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it("emits runtime imports with .js extensions", async () => {
    const generated = await readFile(generatedWSOutboundPath, "utf8");
    expect(generated).toContain('from "../../validation/ws-outbound-schema-metadata.js"');
  });

  it("accepts a forge.search.response envelope", () => {
    const result = GeneratedWSOutboundMessageSchema.safeParse({
      type: "session",
      message: {
        type: "forge.search.response",
        payload: {
          items: [
            {
              kind: "change_request",
              number: 17,
              title: "Fix search",
              url: "https://gitlab.com/acme/repo/-/merge_requests/17",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          authState: "authenticated",
          error: null,
          requestId: "search-forge",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a figma.file.nodes.response with three levels of children", () => {
    // FigmaNodeSchema must not recurse: zod-aot 0.20.4 miscompiled z.lazy so every child was
    // re-parsed against the whole WS message schema, rejecting any nodes response with children.
    const result = GeneratedWSOutboundMessageSchema.safeParse({
      type: "session",
      message: {
        type: "figma.file.nodes.response",
        payload: {
          requestId: "figma-nodes",
          error: null,
          version: "1566622199797801477",
          source: "rest",
          nodes: {
            "1:2": {
              id: "1:2",
              name: "Hero",
              type: "FRAME",
              absoluteBoundingBox: { x: 20, y: 40, width: 375, height: 812 },
              children: [
                {
                  id: "1:3",
                  name: "Header",
                  type: "GROUP",
                  children: [
                    {
                      id: "1:4",
                      name: "Logo",
                      type: "RECTANGLE",
                      children: [
                        { id: "1:5", name: "Path", type: "VECTOR", fillPaints: [], strokes: [] },
                      ],
                    },
                  ],
                },
              ],
            },
            "1:9": null,
          },
          components: { "1:1": { key: "ck1", name: "Button" } },
          styles: {},
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a figma.file.playback.response with three levels of frames and a null prototype", () => {
    // ADR-0037: playback returns only the requested frames. Frames share the opaque FigmaNode
    // passthrough of nodes.response, so the generated validator must carry unknown node
    // properties and nested children untouched.
    const envelope = {
      type: "session",
      message: {
        type: "figma.file.playback.response",
        payload: {
          requestId: "figma-playback",
          error: null,
          frames: {
            "1:2": {
              id: "1:2",
              name: "Onboarding",
              type: "FRAME",
              absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
              children: [
                {
                  id: "1:3",
                  name: "Hero copy",
                  type: "TEXT",
                  characters: "Welcome",
                  children: [
                    { id: "1:4", name: "Glyph", type: "VECTOR", fillPaints: [], strokes: [] },
                  ],
                },
              ],
            },
          },
          prototype: null,
        },
      },
    };

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it("accepts a figma.file.playback.response with prototype metadata", () => {
    const envelope = {
      type: "session",
      message: {
        type: "figma.file.playback.response",
        payload: {
          requestId: "figma-playback",
          error: null,
          frames: {},
          prototype: {
            flows: [{ nodeId: "1:2", name: "Onboarding flow", pageId: "0:1" }],
            interactions: [
              {
                nodeId: "1:2",
                trigger: { type: "ON_CLICK", delayMs: 300 },
                action: {
                  type: "NODE",
                  navigation: "OVERLAY",
                  destinationId: "1:9",
                  transition: { type: "MOVE_IN", durationMs: 220 },
                },
              },
            ],
            overlays: [{ frameId: "1:9", position: "CENTER" }],
            overlaySettingsAvailable: false,
          },
        },
      },
    };

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it("accepts a figma.file.outline.response with ADR-0039 section summary fields", () => {
    // SECTION children are separated into summaries carrying parentId; childrenLoaded:false
    // marks a section cut at the depth=3 boundary. Pre-ADR-0039 summaries (right frame) must
    // keep parsing unchanged through the generated validator.
    const envelope = {
      type: "session",
      message: {
        type: "figma.file.outline.response",
        payload: {
          requestId: "figma-outline",
          error: null,
          outline: {
            fileKey: "kH8TzQ2mV1",
            name: "Marketing site",
            version: "1566622199797801477",
            lastModified_ms: 1762400000000,
            editorType: "figma",
            source: "rest",
            pages: [
              {
                id: "0:1",
                name: "Cover",
                flowStartingPoints: [{ nodeId: "1:2", name: "Landing" }],
                frames: [
                  {
                    id: "1:2",
                    name: "Landing",
                    type: "FRAME",
                    bounds: { x: 0, y: 0, width: 375, height: 812 },
                  },
                  {
                    id: "1:10",
                    name: "Hero section",
                    type: "SECTION",
                    bounds: { x: 0, y: 812, width: 1440, height: 1024 },
                    childrenLoaded: true,
                  },
                  {
                    id: "1:11",
                    name: "Nav",
                    type: "FRAME",
                    bounds: { x: 0, y: 812, width: 1440, height: 64 },
                    parentId: "1:10",
                  },
                  {
                    id: "1:12",
                    name: "Nested section",
                    type: "SECTION",
                    bounds: { x: 0, y: 876, width: 1440, height: 960 },
                    parentId: "1:10",
                    childrenLoaded: false,
                  },
                ],
              },
            ],
          },
        },
      },
    };

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it("accepts a legacy github_search_response envelope", () => {
    const result = GeneratedWSOutboundMessageSchema.safeParse({
      type: "session",
      message: {
        type: "github_search_response",
        payload: {
          items: [
            {
              kind: "pr",
              number: 42,
              title: "Legacy PR",
              url: "https://github.com/acme/repo/pull/42",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          featuresEnabled: true,
          githubFeaturesEnabled: true,
          authState: "authenticated",
          error: null,
          requestId: "search-github",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// Requests travel client→daemon and are parsed by the daemon's runtime `WSInboundMessageSchema`
// (websocket-server.ts); only the outbound side has a generated zod-aot artifact. These cases
// pin the ADR-0037 playback request tightening at the real inbound parse boundary, so both WS
// directions of the RPC pair are covered.
describe("WS inbound figma playback request validation", () => {
  const playbackEnvelope = (params: Record<string, unknown>) => ({
    type: "session",
    message: {
      type: "figma.file.playback.request",
      requestId: "figma-playback",
      fileKey: "kH8TzQ2mV1",
      frameIds: ["1:2"],
      version: "1566622199797801477",
      ...params,
    },
  });

  it("accepts a playback request envelope with 10 frame ids", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `1:${i + 2}`);
    expect(WSInboundMessageSchema.safeParse(playbackEnvelope({ frameIds: ids })).success).toBe(
      true,
    );
  });

  it("rejects an empty version — a falsy pin would load the latest document, not the snapshot", () => {
    expect(WSInboundMessageSchema.safeParse(playbackEnvelope({ version: "" })).success).toBe(false);
  });

  it("rejects an empty frame id", () => {
    expect(WSInboundMessageSchema.safeParse(playbackEnvelope({ frameIds: [""] })).success).toBe(
      false,
    );
    expect(
      WSInboundMessageSchema.safeParse(playbackEnvelope({ frameIds: ["1:2", ""] })).success,
    ).toBe(false);
  });

  it("still accepts the unchanged legacy nodes request with an empty version and id", () => {
    expect(
      WSInboundMessageSchema.safeParse({
        type: "session",
        message: {
          type: "figma.file.nodes.request",
          requestId: "figma-nodes",
          fileKey: "kH8TzQ2mV1",
          ids: [""],
          version: "",
        },
      }).success,
    ).toBe(true);
  });
});

// ADR-0039: the optional depth=1 option rides the existing nodes request client→daemon. Only the
// literal 1 parses, and its absence must keep the old request valid (an old daemon never sees it).
describe("WS inbound figma nodes depth option", () => {
  const nodesEnvelope = (params: Record<string, unknown>) => ({
    type: "session",
    message: {
      type: "figma.file.nodes.request",
      requestId: "figma-nodes",
      fileKey: "kH8TzQ2mV1",
      ids: ["1:10"],
      version: "1566622199797801477",
      ...params,
    },
  });

  it("accepts a depth=1 request and the old request without depth", () => {
    expect(WSInboundMessageSchema.safeParse(nodesEnvelope({ depth: 1 })).success).toBe(true);
    expect(WSInboundMessageSchema.safeParse(nodesEnvelope({})).success).toBe(true);
  });

  it("rejects any other depth value", () => {
    expect(WSInboundMessageSchema.safeParse(nodesEnvelope({ depth: 2 })).success).toBe(false);
    expect(WSInboundMessageSchema.safeParse(nodesEnvelope({ depth: "1" })).success).toBe(false);
  });
});

// ADR-0040: the figma.remote.* responses travel daemon→client through the generated zod-aot
// validator. Remote MCP results are raw content arrays with arbitrary nesting — deep structures
// (get_metadata trees, use_figma node graphs) must survive compilation unchanged.
describe("WS outbound figma remote responses (generated validator)", () => {
  it("accepts a figma.remote.status.response with connected status and identityText", () => {
    const envelope = {
      type: "session",
      message: {
        type: "figma.remote.status.response",
        payload: {
          requestId: "figma-remote-status",
          error: null,
          status: { state: "connected", message: null, identityText: "ngocchanh" },
        },
      },
    };

    const res = GeneratedWSOutboundMessageSchema.safeParse(envelope);
    if (!res.success)
      console.log("AOT STATUS ERR:", JSON.stringify(res.error.issues).slice(0, 400));
    expect(res.success).toBe(true);
  });

  it("accepts a figma.remote.execute.response with deep MCP content, structuredContent, readback", () => {
    const envelope = {
      type: "session",
      message: {
        type: "figma.remote.execute.response",
        payload: {
          requestId: "figma-remote-execute",
          error: null,
          result: {
            content: [
              { type: "text", text: "1:2" },
              { type: "image", data: "cG5n", mimeType: "image/png" },
              {
                type: "resource",
                resource: { uri: "figma://node/1:2", text: '{"name":"Landing"}' },
              },
            ],
            structuredContent: {
              nodeId: "1:2",
              changes: [
                { op: "rename", from: "Frame 1", to: "Landing", nested: { deep: [1, [2, [3]]] } },
              ],
            },
            isError: false,
          },
          readback: {
            content: [{ type: "text", text: '{"name":"Landing","bounds":{"x":0,"y":0}}' }],
            structuredContent: { name: "Landing", bounds: { x: 0, y: 0, width: 375, height: 812 } },
          },
          readbackAvailable: true,
        },
      },
    };

    const res = GeneratedWSOutboundMessageSchema.safeParse(envelope);
    if (!res.success) console.log("AOT EXEC ERR:", JSON.stringify(res.error.issues).slice(0, 400));
    expect(res.success).toBe(true);
  });
});

// ADR-0040: figma.remote.* requests travel client→daemon through the runtime inbound union — the
// daemon's real parse boundary. Bare requests are empty-param; read/execute carry the ADR's
// parameter rules (nonempty fileKey, description 1–1000, code ≤65536 chars).
describe("WS inbound figma remote requests", () => {
  const remoteEnvelope = (type: string, params: Record<string, unknown>) => ({
    type: "session",
    message: { type, requestId: "figma-remote", ...params },
  });

  it("accepts the three bare requests and read/execute with params", () => {
    for (const type of [
      "figma.remote.status.request",
      "figma.remote.auth.begin.request",
      "figma.remote.disconnect.request",
    ]) {
      const res = WSInboundMessageSchema.safeParse(remoteEnvelope(type, {}));
      if (!res.success) console.log(type, "ERR:", JSON.stringify(res.error.issues).slice(0, 300));
      expect(res.success).toBe(true);
    }

    expect(
      WSInboundMessageSchema.safeParse(
        remoteEnvelope("figma.remote.read.request", { fileKey: "kH8TzQ2mV1", nodeId: "1:2" }),
      ).success,
    ).toBe(true);
    expect(
      WSInboundMessageSchema.safeParse(
        remoteEnvelope("figma.remote.execute.request", {
          fileKey: "kH8TzQ2mV1",
          code: 'figma.currentPage.children[0].name = "Landing";',
          description: "Rename the landing frame",
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects a read request with an empty fileKey", () => {
    const res = WSInboundMessageSchema.safeParse(
      remoteEnvelope("figma.remote.read.request", { fileKey: "" }),
    );
    if (res.success) console.log("EMPTY KEYS accepted:", JSON.stringify(res.data).slice(0, 200));
    expect(res.success).toBe(false);
  });

  it("keeps the execute code cap at 65536 characters and description at 1–1000", () => {
    expect(
      WSInboundMessageSchema.safeParse(
        remoteEnvelope("figma.remote.execute.request", {
          fileKey: "kH8TzQ2mV1",
          code: "a".repeat(65536),
          description: "d",
        }),
      ).success,
    ).toBe(true);
    expect(
      WSInboundMessageSchema.safeParse(
        remoteEnvelope("figma.remote.execute.request", {
          fileKey: "kH8TzQ2mV1",
          code: "a".repeat(65537),
          description: "d",
        }),
      ).success,
    ).toBe(false);
    expect(
      WSInboundMessageSchema.safeParse(
        remoteEnvelope("figma.remote.execute.request", {
          fileKey: "kH8TzQ2mV1",
          code: "return 1;",
          description: "",
        }),
      ).success,
    ).toBe(false);
    expect(
      WSInboundMessageSchema.safeParse(
        remoteEnvelope("figma.remote.execute.request", {
          fileKey: "kH8TzQ2mV1",
          code: "return 1;",
          description: "d".repeat(1001),
        }),
      ).success,
    ).toBe(false);
  });
});
