import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema } from "./messages.js";
import {
  FigmaFileNodesRequestSchema,
  FigmaFilePlaybackRequestSchema,
} from "./figma/rpc-schemas.js";

describe("optional text-outline preparation contract", () => {
  it("accepts an old host without the capability and a host advertising it", () => {
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
        features: { figma: true, figmaTextOutlines: true },
      }).features,
    ).toEqual({ figma: true, figmaTextOutlines: true });
  });

  it("preserves existing nodes/playback requests and adds only an optional preparation hint", () => {
    const nodes = {
      type: "figma.file.nodes.request",
      requestId: "req_a1b2c3",
      fileKey: "file_a1b2c3",
      ids: ["1:2"],
      version: "v1",
    };
    const playback = {
      type: "figma.file.playback.request",
      requestId: "req_a1b2c3",
      fileKey: "file_a1b2c3",
      frameIds: ["1:2"],
      version: "v1",
    };
    expect(FigmaFileNodesRequestSchema.parse(nodes)).toEqual(nodes);
    expect(FigmaFileNodesRequestSchema.parse({ ...nodes, prepareTextOutlines: true })).toEqual({
      ...nodes,
      prepareTextOutlines: true,
    });
    expect(FigmaFilePlaybackRequestSchema.parse(playback)).toEqual(playback);
    expect(
      FigmaFilePlaybackRequestSchema.parse({ ...playback, prepareTextOutlines: true }),
    ).toEqual({ ...playback, prepareTextOutlines: true });
  });
});
