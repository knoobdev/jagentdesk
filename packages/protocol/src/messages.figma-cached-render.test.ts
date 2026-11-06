import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema } from "./messages.js";
import { FigmaFileRenderRequestSchema } from "./figma/rpc-schemas.js";

describe("optional cached render contract", () => {
  it("preserves legacy render requests and permits cache-only without requiring it", () => {
    const render = {
      type: "figma.file.render.request",
      requestId: "req_a1b2c3",
      fileKey: "file_a1b2c3",
      ids: ["1:2"],
      scale: 0.25,
      version: "v1",
    };
    expect(FigmaFileRenderRequestSchema.parse(render)).toEqual({ ...render, format: "png" });
    expect(FigmaFileRenderRequestSchema.parse({ ...render, cachedOnly: true })).toEqual({
      ...render,
      format: "png",
      cachedOnly: true,
    });
  });
  it("accepts both old feature sets and the explicit cache-only capability", () => {
    const base = {
      status: "server_info",
      serverId: "srv_a1b2c3d4e5f6",
      hostname: "<hostname>",
      version: "0.9.55",
    };
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...base, features: { figma: true } }).features,
    ).toEqual({ figma: true });
    expect(
      ServerInfoStatusPayloadSchema.parse({
        ...base,
        features: { figma: true, figmaCachedRender: true },
      }).features,
    ).toEqual({ figma: true, figmaCachedRender: true });
  });
});
