import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema, parseServerInfoStatusPayload } from "./messages.js";

// ADR-0040: `figmaRemoteWrites` gates the provider-independent write RPCs
// (figma.remote.status/auth.begin/disconnect/read/execute). Additive like every capability:
// optional in the schema, absent from old daemons, stripped by older clients. The client gates
// the write surface once and asks the user to update the host — see ADR-0037/0039 pins for the
// sibling flags.

const SERVER_ID = "srv_9c1f2e4a7b";

function serverInfo(features: Record<string, unknown> | undefined) {
  return {
    status: "server_info",
    serverId: SERVER_ID,
    hostname: "dev-mbp.local",
    version: "0.9.55",
    ...(features === undefined ? {} : { features }),
  };
}

describe("server_info figmaRemoteWrites capability", () => {
  it("parses when a new daemon advertises remote MCP writes", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({
        figma: true,
        figmaPlayback: true,
        figmaNodeDepth: true,
        figmaRemoteWrites: true,
      }),
    );

    expect(parsed.serverId).toBe(SERVER_ID);
    expect(parsed.features).toEqual({
      figma: true,
      figmaPlayback: true,
      figmaNodeDepth: true,
      figmaRemoteWrites: true,
    });
  });

  it("parses a pre-ADR-0040 daemon that only advertised the existing flags", () => {
    const parsed = parseServerInfoStatusPayload(
      serverInfo({ figma: true, figmaPlayback: true, figmaNodeDepth: true }),
    );

    expect(parsed).not.toBeNull();
    expect("figmaRemoteWrites" in (parsed?.features ?? {})).toBe(false);
  });

  it("parses figmaRemoteWrites:false (connector wired without the write surface)", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({ figma: true, figmaRemoteWrites: false }),
    );

    expect(parsed.features).toEqual({ figma: true, figmaRemoteWrites: false });
  });

  it("still strips unknown capability flags from newer daemons", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({ figma: true, figmaRemoteWrites: true, figmaRemoteProven: true }),
    );

    expect(parsed.features).toEqual({ figma: true, figmaRemoteWrites: true });
  });
});
