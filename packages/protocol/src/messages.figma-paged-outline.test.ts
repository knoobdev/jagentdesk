import { describe, expect, it } from "vitest";
import {
  FigmaFileOutlineRequestSchema,
  FigmaFileOutlineResponseSchema,
} from "./figma/rpc-schemas.js";
import { ServerInfoStatusPayloadSchema } from "./messages.js";

describe("optional page outline contract", () => {
  const request = {
    type: "figma.file.outline.request",
    requestId: "req_a1b2c3",
    fileKey: "file_a1b2c3",
  };
  it("preserves legacy requests and accepts both new scopes structurally", () => {
    expect(FigmaFileOutlineRequestSchema.parse(request)).toEqual(request);
    expect(FigmaFileOutlineRequestSchema.parse({ ...request, pagesOnly: true }).pagesOnly).toBe(
      true,
    );
    expect(
      FigmaFileOutlineRequestSchema.parse({ ...request, pageId: "1:1", version: "v1" }).pageId,
    ).toBe("1:1");
  });
  it("keeps page load state and the capability optional", () => {
    const response = {
      type: "figma.file.outline.response",
      payload: {
        requestId: request.requestId,
        error: null,
        outline: {
          fileKey: request.fileKey,
          version: "v1",
          name: "<file>",
          lastModified_ms: 1,
          editorType: "figma",
          source: "rest",
          pages: [{ id: "1:1", name: "<page>", frames: [], flowStartingPoints: [] }],
        },
      },
    };
    expect(FigmaFileOutlineResponseSchema.parse(response)).toEqual(response);
    const paged = structuredClone(response);
    Object.assign(paged.payload.outline.pages[0]!, { childrenLoaded: false });
    expect(FigmaFileOutlineResponseSchema.parse(paged)).toEqual(paged);
    const server = {
      status: "server_info",
      serverId: "srv_a1b2c3d4e5f6",
      hostname: "<hostname>",
      version: "0.9.55",
    };
    expect(ServerInfoStatusPayloadSchema.parse(server).features).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...server, features: { figmaPagedOutline: true } })
        .features?.figmaPagedOutline,
    ).toBe(true);
  });
});
