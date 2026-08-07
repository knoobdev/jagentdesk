import { describe, expect, it } from "vitest";
import type { HostConnection } from "@/types/host-connection";
import {
  selectBestConnection,
  type ConnectionCandidate,
  type ConnectionProbeState,
} from "./connection-selection";

function makeDirect(id: string, endpoint: string): HostConnection {
  return { id, type: "directTcp", endpoint };
}

function makeTailnet(
  id: string,
  tailnetAddress: string,
  daemonPublicKeyB64 = "abc",
): HostConnection {
  return { id, type: "tailnet", tailnetAddress, daemonPublicKeyB64 };
}

function probes(input: Record<string, ConnectionProbeState>): Map<string, ConnectionProbeState> {
  return new Map(Object.entries(input));
}

describe("selectBestConnection", () => {
  it("picks the available connection with lowest latency regardless of transport", () => {
    const candidates: ConnectionCandidate[] = [
      { connectionId: "direct:a", connection: makeDirect("direct:a", "a:6767") },
      {
        connectionId: "tailnet:b",
        connection: makeTailnet("tailnet:b", "tailnet.example.ts.net:6767"),
      },
    ];

    const selected = selectBestConnection({
      candidates,
      probeByConnectionId: probes({
        "direct:a": { status: "available", latencyMs: 84 },
        "tailnet:b": { status: "available", latencyMs: 34 },
      }),
    });

    expect(selected).toBe("tailnet:b");
  });

  it("picks the lowest-latency connection among mixed transport candidates", () => {
    const candidates: ConnectionCandidate[] = [
      { connectionId: "direct:a", connection: makeDirect("direct:a", "a:6767") },
      { connectionId: "direct:c", connection: makeDirect("direct:c", "c:6767") },
      {
        connectionId: "tailnet:b",
        connection: makeTailnet("tailnet:b", "tailnet.example.ts.net:6767"),
      },
    ];

    const selected = selectBestConnection({
      candidates,
      probeByConnectionId: probes({
        "direct:a": { status: "available", latencyMs: 84 },
        "direct:c": { status: "available", latencyMs: 41 },
        "tailnet:b": { status: "available", latencyMs: 12 },
      }),
    });

    expect(selected).toBe("tailnet:b");
  });

  it("ignores unavailable and pending probes", () => {
    const candidates: ConnectionCandidate[] = [
      { connectionId: "direct:a", connection: makeDirect("direct:a", "a:6767") },
      {
        connectionId: "tailnet:b",
        connection: makeTailnet("tailnet:b", "tailnet.example.ts.net:6767"),
      },
      { connectionId: "direct:c", connection: makeDirect("direct:c", "c:6767") },
    ];

    const selected = selectBestConnection({
      candidates,
      probeByConnectionId: probes({
        "direct:a": { status: "pending", latencyMs: null },
        "tailnet:b": { status: "unavailable", latencyMs: null },
        "direct:c": { status: "available", latencyMs: 41 },
      }),
    });

    expect(selected).toBe("direct:c");
  });

  it("returns null when no candidates are available", () => {
    const candidates: ConnectionCandidate[] = [
      { connectionId: "direct:a", connection: makeDirect("direct:a", "a:6767") },
      {
        connectionId: "tailnet:b",
        connection: makeTailnet("tailnet:b", "tailnet.example.ts.net:6767"),
      },
    ];

    const selected = selectBestConnection({
      candidates,
      probeByConnectionId: probes({
        "direct:a": { status: "pending", latencyMs: null },
        "tailnet:b": { status: "unavailable", latencyMs: null },
      }),
    });

    expect(selected).toBeNull();
  });

  it("returns null when no probes are available even if candidates exist", () => {
    const candidates: ConnectionCandidate[] = [
      { connectionId: "direct:a", connection: makeDirect("direct:a", "a:6767") },
      {
        connectionId: "tailnet:b",
        connection: makeTailnet("tailnet:b", "tailnet.example.ts.net:6767"),
      },
    ];

    const selected = selectBestConnection({
      candidates,
      probeByConnectionId: probes({
        "direct:a": { status: "unavailable", latencyMs: null },
        "tailnet:b": { status: "pending", latencyMs: null },
      }),
    });

    expect(selected).toBeNull();
  });
});
