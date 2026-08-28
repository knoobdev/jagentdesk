import { describe, expect, it, vi } from "vitest";
import { ClusterSession } from "./cluster-session.js";
import { GENERIC_KINDS } from "../../cluster/kube-client.js";

interface EmittedMessage {
  type: string;
  payload: { error: string | null; kinds: Array<{ kind: string }> };
}

function makeSession(discoverCRDs: () => Promise<unknown>) {
  const emitted: EmittedMessage[] = [];
  const host = { emit: (m: unknown) => emitted.push(m as EmittedMessage) };
  const clusterRegistry = { getClient: () => ({ discoverCRDs }) };
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), child: () => logger };
  const session = new ClusterSession({
    host: host as never,
    clusterRegistry: clusterRegistry as never,
    logger: logger as never,
  });
  return { session, emitted };
}

const request = { type: "cluster/kinds", id: "clu_x", requestId: "r1" } as never;

describe("ClusterSession.handleClusterKinds", () => {
  it("returns the built-in kinds even when CRD discovery is forbidden (RBAC)", async () => {
    const { session, emitted } = makeSession(() => {
      throw new Error("customresourcedefinitions.apiextensions.k8s.io is forbidden");
    });
    await session.handleClusterKinds(request);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("cluster/kinds/response");
    // NOT an error response — the menu must still render.
    expect(emitted[0].payload.error).toBeNull();
    expect(emitted[0].payload.kinds).toHaveLength(GENERIC_KINDS.length);
    expect(emitted[0].payload.kinds.some((k) => k.kind === "Pod")).toBe(true);
    expect(emitted[0].payload.kinds.some((k) => k.kind === "Deployment")).toBe(true);
  });

  it("appends discovered CRDs to the built-in kinds when permitted", async () => {
    const { session, emitted } = makeSession(async () => [
      { kind: "MyResource", apiVersion: "example.com/v1", namespaced: true, category: "Custom" },
    ]);
    await session.handleClusterKinds(request);
    expect(emitted[0].payload.kinds).toHaveLength(GENERIC_KINDS.length + 1);
    expect(emitted[0].payload.kinds.some((k) => k.kind === "MyResource")).toBe(true);
  });
});
