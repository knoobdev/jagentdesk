import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema, parseServerInfoStatusPayload } from "./messages.js";

// The `figmaPlayback` feature flag (spec 32 / ADR-0037) must be additive on the wire: a new
// daemon sends it, an old daemon does not, and a six-month-old app (whose `features` object
// strips unknown keys) still parses the message either way.

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

describe("server_info figmaPlayback capability", () => {
  it("keeps the flag optional and parses it when a new daemon advertises playback", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({ figma: true, figmaPlayback: true }),
    );

    expect(parsed.serverId).toBe(SERVER_ID);
    expect(parsed.features).toEqual({ figma: true, figmaPlayback: true });
  });

  it("parses an old daemon's server_info that never sent figmaPlayback", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(serverInfo({ figma: true }));

    expect(parsed.features).toEqual({ figma: true });
    expect("figmaPlayback" in (parsed.features ?? {})).toBe(false);
  });

  it("parses a pre-figma daemon with no figma flags at all", () => {
    const parsed = parseServerInfoStatusPayload(serverInfo({ autorun: false }));

    expect(parsed).not.toBeNull();
    expect(parsed?.features).toEqual({ autorun: false });
  });

  it("still parses unknown capability flags from a newer daemon (feature flags are additive)", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse(
      serverInfo({ figma: true, figmaPlayback: true, figmaInspect: true }),
    );

    expect(parsed.features).toEqual({ figma: true, figmaPlayback: true });
  });
});
