import { describe, expect, it } from "vitest";
import {
  ClusterContextsRequestSchema,
  ClusterContextsResponseSchema,
  ClusterImportRequestSchema,
  ClusterImportResponseSchema,
  ClusterListRequestSchema,
  ClusterListResponseSchema,
  ClusterConnectRequestSchema,
  ClusterConnectResponseSchema,
  ClusterDisconnectRequestSchema,
  ClusterDisconnectResponseSchema,
  ClusterResourcesRequestSchema,
  ClusterResourcesResponseSchema,
  ClusterGetRequestSchema,
  ClusterGetResponseSchema,
  ClusterLogsRequestSchema,
  ClusterLogsResponseSchema,
  ClusterWriteRequestSchema,
  ClusterWriteResponseSchema,
} from "./rpc-schemas.js";

describe("cluster RPC schemas", () => {
  it("round-trips contexts request/response", () => {
    const req = ClusterContextsRequestSchema.parse({
      type: "cluster/contexts",
      requestId: "req-1",
    });
    expect(req).toEqual({ type: "cluster/contexts", requestId: "req-1" });

    const res = ClusterContextsResponseSchema.parse({
      type: "cluster/contexts/response",
      payload: {
        requestId: "req-1",
        contexts: [
          {
            name: "minikube",
            cluster: "minikube",
            server: "https://127.0.0.1:6443",
            user: "minikube",
            current: true,
          },
        ],
        error: null,
      },
    });
    expect(res.payload.contexts[0].name).toBe("minikube");
    expect(res.payload.error).toBeNull();
  });

  it("round-trips import request/response", () => {
    const req = ClusterImportRequestSchema.parse({
      type: "cluster/import",
      requestId: "req-1",
      contextName: "my-cluster",
      displayName: "My Cluster",
    });
    expect(req.type).toBe("cluster/import");
    expect(req.contextName).toBe("my-cluster");

    const res = ClusterImportResponseSchema.parse({
      type: "cluster/import/response",
      payload: {
        requestId: "req-1",
        clusters: [
          {
            id: "clu_abc123",
            contextName: "my-cluster",
            displayName: "My Cluster",
            state: "saved",
          },
        ],
        error: null,
      },
    });
    expect(res.payload.clusters[0].id).toBe("clu_abc123");
  });

  it("round-trips list request/response", () => {
    const req = ClusterListRequestSchema.parse({
      type: "cluster/list",
      requestId: "req-1",
    });
    expect(req.type).toBe("cluster/list");

    const res = ClusterListResponseSchema.parse({
      type: "cluster/list/response",
      payload: {
        requestId: "req-1",
        clusters: [],
        error: null,
      },
    });
    expect(res.payload.clusters).toEqual([]);
  });

  it("round-trips connect request/response", () => {
    const req = ClusterConnectRequestSchema.parse({
      type: "cluster/connect",
      requestId: "req-1",
      id: "clu_abc123",
    });
    expect(req.id).toBe("clu_abc123");

    const res = ClusterConnectResponseSchema.parse({
      type: "cluster/connect/response",
      payload: {
        requestId: "req-1",
        cluster: null,
        error: "cluster not found",
      },
    });
    expect(res.payload.error).toBe("cluster not found");
  });

  it("round-trips disconnect request/response", () => {
    const req = ClusterDisconnectRequestSchema.parse({
      type: "cluster/disconnect",
      requestId: "req-1",
      id: "clu_abc123",
    });
    expect(req.type).toBe("cluster/disconnect");

    const res = ClusterDisconnectResponseSchema.parse({
      type: "cluster/disconnect/response",
      payload: {
        requestId: "req-1",
        ok: true,
        error: null,
      },
    });
    expect(res.payload.ok).toBe(true);
  });

  it("round-trips resources request/response", () => {
    const req = ClusterResourcesRequestSchema.parse({
      type: "cluster/resources",
      requestId: "req-1",
      id: "clu_abc123",
      kind: "pods",
      namespace: "default",
    });
    expect(req.kind).toBe("pods");

    const res = ClusterResourcesResponseSchema.parse({
      type: "cluster/resources/response",
      payload: {
        requestId: "req-1",
        kind: "pods",
        items: [{ name: "pod-1" }],
        error: null,
      },
    });
    expect(res.payload.kind).toBe("pods");
    expect(res.payload.items).toHaveLength(1);
  });

  it("round-trips get request/response", () => {
    const req = ClusterGetRequestSchema.parse({
      type: "cluster/get",
      requestId: "req-1",
      id: "clu_abc123",
      kind: "pod",
      namespace: "default",
      name: "my-pod",
    });
    expect(req.name).toBe("my-pod");

    const res = ClusterGetResponseSchema.parse({
      type: "cluster/get/response",
      payload: {
        requestId: "req-1",
        yaml: "apiVersion: v1\nkind: Pod\n",
        error: null,
      },
    });
    expect(res.payload.yaml).toContain("apiVersion:");
  });

  it("round-trips logs request/response", () => {
    const req = ClusterLogsRequestSchema.parse({
      type: "cluster/logs",
      requestId: "req-1",
      id: "clu_abc123",
      namespace: "default",
      pod: "my-pod",
      container: "app",
    });
    expect(req.container).toBe("app");

    const res = ClusterLogsResponseSchema.parse({
      type: "cluster/logs/response",
      payload: {
        requestId: "req-1",
        logs: "line 1\nline 2\n",
        error: null,
      },
    });
    expect(res.payload.logs).toContain("line 1");
  });

  it("round-trips write request/response", () => {
    const req = ClusterWriteRequestSchema.parse({
      type: "cluster/write",
      requestId: "req-1",
      id: "clu_abc123",
      kind: "deployment",
      namespace: "default",
      name: "my-deploy",
      action: "scale",
      replicas: 3,
      dryRun: true,
    });
    expect(req.action).toBe("scale");
    expect(req.dryRun).toBe(true);

    const res = ClusterWriteResponseSchema.parse({
      type: "cluster/write/response",
      payload: {
        requestId: "req-1",
        result: { ok: true, dryRun: true, message: "scale succeeded" },
        error: null,
      },
    });
    expect(res.payload.result?.ok).toBe(true);
  });
});
