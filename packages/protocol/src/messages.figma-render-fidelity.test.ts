import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema, parseServerInfoStatusPayload } from "./messages.js";

// ADR-0042: `figmaRenderFidelity` gates the render `svg` text-outline format and
// `useAbsoluteBounds`. Additive like every capability: optional in the schema, absent from old
// daemons, stripped by older clients. A host without the flag answers the fidelity path with
// plugin crop bytes that mean something else (Live Link knows neither option), so the client
// keeps the old PNG-crop fallback there and does not claim the new quality.

const SERVER_ID = "srv_8e2a5c1d7f";

function serverInfo(features: Record<string, unknown> | undefined) {
  return {
    status: "server_info",
    serverId: SERVER_ID,
    hostname: "dev-mbp.local",
    version: "0.9.57",
    ...(features === undefined ? {} : { features }),
  };
}

describe("server_info figmaRenderFidelity capability", () => {
  it("parses when a new daemon advertises render fidelity", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({
        figma: true,
        figmaPlayback: true,
        figmaNodeDepth: true,
        figmaRemoteWrites: true,
        figmaCommentRegions: true,
        figmaRenderFidelity: true,
      }),
    );

    expect(parsed.serverId).toBe(SERVER_ID);
    expect(parsed.features).toEqual({
      figma: true,
      figmaPlayback: true,
      figmaNodeDepth: true,
      figmaRemoteWrites: true,
      figmaCommentRegions: true,
      figmaRenderFidelity: true,
    });
  });

  it("parses a pre-ADR-0042 daemon that never advertised the flag", () => {
    const parsed = parseServerInfoStatusPayload(
      serverInfo({
        figma: true,
        figmaPlayback: true,
        figmaNodeDepth: true,
        figmaRemoteWrites: true,
        figmaCommentRegions: true,
      }),
    );

    expect(parsed).not.toBeNull();
    expect("figmaRenderFidelity" in (parsed?.features ?? {})).toBe(false);
  });

  it("parses figmaRenderFidelity:false (host predates the fidelity path)", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({ figma: true, figmaRenderFidelity: false }),
    );

    expect(parsed.features).toEqual({ figma: true, figmaRenderFidelity: false });
  });

  it("still strips unknown capability flags from newer daemons", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({ figma: true, figmaRenderFidelity: true, figmaVectorEffects: true }),
    );

    expect(parsed.features).toEqual({ figma: true, figmaRenderFidelity: true });
  });
});
