import { expect, test, vi } from "vitest";
import { createJAgentDeskToolCatalog } from "./jagentdesk-tools.js";
import type { JAgentDeskToolHostDependencies } from "./jagentdesk-tools.js";
import type { ClusterRegistry } from "../../cluster/cluster-registry.js";
import type { KubeClient } from "../../cluster/kube-client.js";

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "debug" as const,
  } as unknown as ReturnType<typeof createJAgentDeskToolCatalog> extends never
    ? never
    : Parameters<typeof createJAgentDeskToolCatalog>[0]["logger"];
}

function createMinimalDeps(
  overrides?: Partial<JAgentDeskToolHostDependencies>,
): JAgentDeskToolHostDependencies {
  return {
    agentManager: vi.fn() as unknown as JAgentDeskToolHostDependencies["agentManager"],
    agentStorage: vi.fn() as unknown as JAgentDeskToolHostDependencies["agentStorage"],
    providerSnapshotManager:
      vi.fn() as unknown as JAgentDeskToolHostDependencies["providerSnapshotManager"],
    logger: createMockLogger(),
    ...overrides,
  };
}

test("catalog registers kubectl_get and kubectl_apply tools", () => {
  const catalog = createJAgentDeskToolCatalog(createMinimalDeps());
  expect(catalog.getTool("kubectl_get")).toBeDefined();
  expect(catalog.getTool("kubectl_apply")).toBeDefined();
});

test("kubectl_apply returns denied when requestHostToolPermission returns deny", async () => {
  const requestHostToolPermission = vi.fn().mockResolvedValue({ behavior: "deny" });
  const applyWrite = vi.fn();

  const mockClient = { applyWrite } as unknown as KubeClient;
  const clusterRegistry = {
    getClient: vi.fn().mockReturnValue(mockClient),
  } as unknown as ClusterRegistry;

  const catalog = createJAgentDeskToolCatalog(
    createMinimalDeps({
      callerAgentId: "test-agent-id",
      clusterRegistry,
      requestHostToolPermission,
    }),
  );

  const result = await catalog.executeTool("kubectl_apply", {
    clusterId: "test-cluster",
    action: "delete",
    kind: "Pod",
    name: "test-pod",
  });

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toBe("Denied by user.");
  expect(applyWrite).not.toHaveBeenCalled();
});

test("kubectl_apply calls applyWrite with dryRun:false when allowed", async () => {
  const requestHostToolPermission = vi.fn().mockResolvedValue({ behavior: "allow" });
  const applyWrite = vi.fn().mockResolvedValue({
    ok: true,
    dryRun: false,
    message: "delete Pod/test-pod succeeded",
  });

  const mockClient = { applyWrite } as unknown as KubeClient;
  const clusterRegistry = {
    getClient: vi.fn().mockReturnValue(mockClient),
  } as unknown as ClusterRegistry;

  const catalog = createJAgentDeskToolCatalog(
    createMinimalDeps({
      callerAgentId: "test-agent-id",
      clusterRegistry,
      requestHostToolPermission,
    }),
  );

  const result = await catalog.executeTool("kubectl_apply", {
    clusterId: "test-cluster",
    action: "delete",
    kind: "Pod",
    name: "test-pod",
  });

  expect(requestHostToolPermission).toHaveBeenCalledWith(
    "test-agent-id",
    expect.objectContaining({
      name: "kubectl_apply",
      kind: "tool",
    }),
  );
  expect(applyWrite).toHaveBeenCalledWith({
    kind: "Pod",
    namespace: undefined,
    name: "test-pod",
    action: "delete",
    replicas: undefined,
    manifestYaml: undefined,
    dryRun: false,
  });
  expect(result.isError).toBeFalsy();
});
