import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema, parseServerInfoStatusPayload } from "./messages.js";

// ADR-0041: `figmaCommentRegions` gates the region-geometry comment surface. Additive like
// every capability: optional in the schema, absent from old daemons, stripped by older clients.
// Clients send a post-request `region` only when the flag is present — an old host strips the
// unknown field, so sending anyway would pass a point comment off as a region create.

const SERVER_ID = "srv_4b7d1e9c2a";

function serverInfo(features: Record<string, unknown> | undefined) {
  return {
    status: "server_info",
    serverId: SERVER_ID,
    hostname: "dev-mbp.local",
    version: "0.9.56",
    ...(features === undefined ? {} : { features }),
  };
}

describe("server_info figmaCommentRegions capability", () => {
  it("parses when a new daemon advertises region comments", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({
        figma: true,
        figmaPlayback: true,
        figmaNodeDepth: true,
        figmaRemoteWrites: true,
        figmaCommentRegions: true,
      }),
    );

    expect(parsed.serverId).toBe(SERVER_ID);
    expect(parsed.features).toEqual({
      figma: true,
      figmaPlayback: true,
      figmaNodeDepth: true,
      figmaRemoteWrites: true,
      figmaCommentRegions: true,
    });
  });

  it("parses a pre-ADR-0041 daemon that never advertised the flag", () => {
    const parsed = parseServerInfoStatusPayload(
      serverInfo({
        figma: true,
        figmaPlayback: true,
        figmaNodeDepth: true,
        figmaRemoteWrites: true,
      }),
    );

    expect(parsed).not.toBeNull();
    expect("figmaCommentRegions" in (parsed?.features ?? {})).toBe(false);
  });

  it("parses figmaCommentRegions:false (host predates the region surface)", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({ figma: true, figmaCommentRegions: false }),
    );

    expect(parsed.features).toEqual({ figma: true, figmaCommentRegions: false });
  });

  it("still strips unknown capability flags from newer daemons", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({ figma: true, figmaCommentRegions: true, figmaPresence: true }),
    );

    expect(parsed.features).toEqual({ figma: true, figmaCommentRegions: true });
  });
});
