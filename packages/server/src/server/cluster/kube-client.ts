import { KubeConfig, CoreV1Api, AppsV1Api } from "@kubernetes/client-node";
import { dumpYaml } from "@kubernetes/client-node";
import type {
  PodDTO,
  ContainerDTO,
  DeploymentDTO,
  NodeDTO,
  EventDTO,
  WriteResult,
} from "./cluster-dto.js";

export class KubeClient {
  private kc: KubeConfig | undefined;
  private coreApi: CoreV1Api | undefined;
  private appsApi: AppsV1Api | undefined;
  private readonly contextName: string;

  constructor(contextName: string) {
    this.contextName = contextName;
  }

  async connect(): Promise<void> {
    this.kc = new KubeConfig();
    this.kc.loadFromDefault();
    this.kc.setCurrentContext(this.contextName);
    this.coreApi = this.kc.makeApiClient(CoreV1Api);
    this.appsApi = this.kc.makeApiClient(AppsV1Api);

    // Verify connection with a lightweight call
    try {
      await this.coreApi.listNamespace();
    } catch (err) {
      throw new Error(
        `KubeClient connect failed for context "${this.contextName}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  async listPods(namespace?: string): Promise<PodDTO[]> {
    this.ensureConnected();
    let items: Array<Record<string, unknown>>;

    if (namespace) {
      const res = await this.coreApi!.listNamespacedPod({ namespace });
      items = (res as unknown as { items: Array<Record<string, unknown>> }).items;
    } else {
      const res = await this.coreApi!.listPodForAllNamespaces();
      items = (res as unknown as { items: Array<Record<string, unknown>> }).items;
    }

    return items.map(mapPod);
  }

  async listDeployments(namespace?: string): Promise<DeploymentDTO[]> {
    this.ensureConnected();
    let items: Array<Record<string, unknown>>;

    if (namespace) {
      const res = await this.appsApi!.listNamespacedDeployment({ namespace });
      items = (res as unknown as { items: Array<Record<string, unknown>> }).items;
    } else {
      const res = await this.appsApi!.listDeploymentForAllNamespaces();
      items = (res as unknown as { items: Array<Record<string, unknown>> }).items;
    }

    return items.map(mapDeployment);
  }

  async listNodes(): Promise<NodeDTO[]> {
    this.ensureConnected();
    const res = await this.coreApi!.listNode();
    const items = (res as unknown as { items: Array<Record<string, unknown>> }).items;
    return items.map(mapNode);
  }

  async listEvents(namespace?: string): Promise<EventDTO[]> {
    this.ensureConnected();
    let items: Array<Record<string, unknown>>;

    if (namespace) {
      const res = await this.coreApi!.listNamespacedEvent({ namespace });
      items = (res as unknown as { items: Array<Record<string, unknown>> }).items;
    } else {
      const res = await this.coreApi!.listEventForAllNamespaces();
      items = (res as unknown as { items: Array<Record<string, unknown>> }).items;
    }

    return items.map(mapEvent);
  }

  async getResourceYaml(
    kind: string,
    namespace: string | undefined,
    name: string,
  ): Promise<string> {
    this.ensureConnected();

    const kindLower = kind.toLowerCase();
    let obj: unknown;

    if (kindLower === "pod") {
      obj = await this.coreApi!.readNamespacedPod({
        name,
        namespace: namespace ?? "default",
      });
    } else if (kindLower === "deployment") {
      obj = await this.appsApi!.readNamespacedDeployment({
        name,
        namespace: namespace ?? "default",
      });
    } else if (kindLower === "node") {
      obj = await this.coreApi!.readNode({ name });
    } else if (kindLower === "namespace") {
      obj = await this.coreApi!.readNamespace({ name });
    } else if (kindLower === "service") {
      obj = await this.coreApi!.readNamespacedService({
        name,
        namespace: namespace ?? "default",
      });
    } else if (kindLower === "configmap") {
      obj = await this.coreApi!.readNamespacedConfigMap({
        name,
        namespace: namespace ?? "default",
      });
    } else {
      throw new Error(`unsupported kind: ${kind}`);
    }

    return dumpYaml(obj);
  }

  async getPodLogs(namespace: string, pod: string, container?: string): Promise<string> {
    this.ensureConnected();
    // Use CoreV1Api.readNamespacedPodLog which returns the log string directly
    const logStr = await this.coreApi!.readNamespacedPodLog({
      name: pod,
      namespace,
      container,
      tailLines: 100,
    });
    return logStr;
  }

  async applyWrite(op: {
    kind: string;
    namespace?: string;
    name: string;
    action: "scale" | "delete" | "restart" | "apply";
    replicas?: number;
    manifestYaml?: string;
    dryRun: boolean;
  }): Promise<WriteResult> {
    this.ensureConnected();
    const dryRunOption = op.dryRun ? "All" : undefined;

    try {
      switch (op.action) {
        case "scale": {
          if (op.replicas === undefined) {
            return { ok: false, dryRun: op.dryRun, message: "replicas required for scale" };
          }
          const kindLower = op.kind.toLowerCase();
          if (kindLower === "deployment") {
            await this.appsApi!.patchNamespacedDeploymentScale({
              name: op.name,
              namespace: op.namespace ?? "default",
              body: { spec: { replicas: op.replicas } },
              dryRun: dryRunOption,
            });
          } else {
            return {
              ok: false,
              dryRun: op.dryRun,
              message: `scale not supported for kind: ${op.kind}`,
            };
          }
          break;
        }
        case "delete": {
          const kindLower = op.kind.toLowerCase();
          if (kindLower === "pod") {
            await this.coreApi!.deleteNamespacedPod({
              name: op.name,
              namespace: op.namespace ?? "default",
              dryRun: dryRunOption,
            });
          } else if (kindLower === "deployment") {
            await this.appsApi!.deleteNamespacedDeployment({
              name: op.name,
              namespace: op.namespace ?? "default",
              dryRun: dryRunOption,
            });
          } else {
            return {
              ok: false,
              dryRun: op.dryRun,
              message: `delete not supported for kind: ${op.kind}`,
            };
          }
          break;
        }
        case "restart": {
          const kindLower = op.kind.toLowerCase();
          if (kindLower === "deployment") {
            await this.appsApi!.patchNamespacedDeployment({
              name: op.name,
              namespace: op.namespace ?? "default",
              body: {
                spec: {
                  template: {
                    metadata: {
                      annotations: {
                        "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
                      },
                    },
                  },
                },
              },
              dryRun: dryRunOption,
            });
          } else {
            return {
              ok: false,
              dryRun: op.dryRun,
              message: `restart not supported for kind: ${op.kind}`,
            };
          }
          break;
        }
        case "apply": {
          if (!op.manifestYaml) {
            return { ok: false, dryRun: op.dryRun, message: "manifestYaml required for apply" };
          }
          return { ok: false, dryRun: op.dryRun, message: "apply not yet implemented" };
        }
        default:
          return { ok: false, dryRun: op.dryRun, message: `unknown action: ${op.action}` };
      }

      return {
        ok: true,
        dryRun: op.dryRun,
        message: `${op.action} ${op.kind}/${op.name} succeeded`,
      };
    } catch (err) {
      return {
        ok: false,
        dryRun: op.dryRun,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async disconnect(): Promise<void> {
    this.kc = undefined;
    this.coreApi = undefined;
    this.appsApi = undefined;
  }

  private ensureConnected(): void {
    if (!this.coreApi || !this.appsApi) {
      throw new Error("KubeClient not connected. Call connect() first.");
    }
  }
}

function mapContainerState(cs: Record<string, unknown>): string {
  const state = cs.state as Record<string, unknown> | undefined;
  if (state?.running) {
    return "Running";
  }
  if (state?.terminated) {
    const term = state.terminated as Record<string, unknown>;
    return `Terminated:${(term.reason as string) ?? ""}`;
  }
  if (state?.waiting) {
    const wait = state.waiting as Record<string, unknown>;
    return `Waiting:${(wait.reason as string) ?? ""}`;
  }
  return "Waiting";
}

function mapOneContainer(cs: Record<string, unknown>): ContainerDTO {
  const stateStr = mapContainerState(cs);
  const resources = cs.resources as Record<string, unknown> | undefined;
  const limits = resources?.limits as Record<string, string> | undefined;
  const requests = resources?.requests as Record<string, string> | undefined;

  const lastState = cs.lastState as Record<string, unknown> | undefined;
  const lastTerminated = lastState?.terminated as Record<string, unknown> | undefined;
  const cLastExitCode = lastTerminated?.exitCode as number | undefined;

  const state = cs.state as Record<string, unknown> | undefined;
  const currentTerminated = state?.terminated as Record<string, unknown> | undefined;
  const cCurrentExitCode = currentTerminated?.exitCode as number | undefined;

  return {
    name: cs.name as string,
    image: cs.image as string,
    ready: cs.ready === true,
    restartCount: (cs.restartCount as number) ?? 0,
    state: stateStr,
    memoryLimit: limits?.memory,
    memoryRequest: requests?.memory,
    lastExitCode: cCurrentExitCode ?? cLastExitCode,
  };
}

function computeStatusReason(status: Record<string, unknown> | undefined): string | undefined {
  if (!status?.phase) return undefined;
  if (status.phase === "Running") {
    const containerStatuses = (status.containerStatuses ?? []) as Array<Record<string, unknown>>;
    for (const cs of containerStatuses) {
      const state = cs.state as Record<string, unknown> | undefined;
      const waiting = state?.waiting as Record<string, unknown> | undefined;
      if (waiting?.reason) {
        return waiting.reason as string;
      }
    }
    return undefined;
  }
  return status.phase as string;
}

function mapPod(raw: Record<string, unknown>): PodDTO {
  const metadata = raw.metadata as Record<string, unknown> | undefined;
  const status = raw.status as Record<string, unknown> | undefined;
  const spec = raw.spec as Record<string, unknown> | undefined;
  const containerStatuses = (status?.containerStatuses ?? []) as Array<Record<string, unknown>>;
  const initContainerStatuses = (status?.initContainerStatuses ?? []) as Array<
    Record<string, unknown>
  >;

  const allContainers = [...containerStatuses, ...initContainerStatuses];
  const readyCount = allContainers.filter((c) => c.ready === true).length;
  const totalRestarts = allContainers.reduce(
    (sum, c) => sum + ((c.restartCount as number) ?? 0),
    0,
  );

  const statusReason = computeStatusReason(status);

  const containers: ContainerDTO[] = allContainers.map(mapOneContainer);
  const labels = (metadata?.labels as Record<string, string>) ?? {};

  const creationTimestamp = metadata?.creationTimestamp;
  let createdAt_ms = 0;
  if (creationTimestamp instanceof Date) {
    createdAt_ms = creationTimestamp.getTime();
  } else if (typeof creationTimestamp === "string") {
    createdAt_ms = new Date(creationTimestamp).getTime();
  }

  return {
    name: metadata?.name as string,
    namespace: metadata?.namespace as string,
    phase: (status?.phase as string) ?? "",
    ready: `${readyCount}/${allContainers.length}`,
    restarts: totalRestarts,
    node: (spec?.nodeName as string) ?? (status?.hostIP as string),
    containers,
    labels,
    createdAt_ms,
    statusReason,
  };
}

function mapDeployment(raw: Record<string, unknown>): DeploymentDTO {
  const metadata = raw.metadata as Record<string, unknown> | undefined;
  const status = raw.status as Record<string, unknown> | undefined;
  const spec = raw.spec as Record<string, unknown> | undefined;

  const available = (status?.availableReplicas as number) ?? 0;
  const desired = (status?.replicas as number) ?? (spec?.replicas as number) ?? 0;
  const ready = (status?.readyReplicas as number) ?? 0;

  const updatedAt = metadata?.creationTimestamp;
  let updatedAt_ms = 0;
  if (updatedAt instanceof Date) {
    updatedAt_ms = updatedAt.getTime();
  } else if (typeof updatedAt === "string") {
    updatedAt_ms = new Date(updatedAt).getTime();
  }

  const labels = (metadata?.labels as Record<string, string>) ?? {};

  return {
    name: metadata?.name as string,
    namespace: metadata?.namespace as string,
    ready: `${ready}/${desired}`,
    available,
    desired,
    updatedAt_ms,
    labels,
  };
}

function mapNode(raw: Record<string, unknown>): NodeDTO {
  const metadata = raw.metadata as Record<string, unknown> | undefined;
  const status = raw.status as Record<string, unknown> | undefined;

  const conditions = (status?.conditions ?? []) as Array<Record<string, unknown>>;
  const readyCondition = conditions.find((c) => c.type === "Ready");
  const ready = readyCondition?.status === "True";

  const labels = (metadata?.labels as Record<string, string>) ?? {};
  const roles: string[] = [];
  for (const key of Object.keys(labels)) {
    if (key.startsWith("node-role.kubernetes.io/")) {
      roles.push(key.slice("node-role.kubernetes.io/".length));
    }
  }
  if (roles.length === 0) {
    if (labels["node-role.kubernetes.io/control-plane"]) {
      roles.push("control-plane");
    } else if (labels["node-role.kubernetes.io/master"]) {
      roles.push("master");
    } else {
      roles.push("worker");
    }
  }

  const nodeInfo = status?.nodeInfo as Record<string, unknown> | undefined;
  const version = (nodeInfo?.kubeletVersion as string) ?? "";

  const capacity = status?.capacity as Record<string, string> | undefined;
  const cpuCapacity = capacity?.cpu;
  const memoryCapacity = capacity?.memory;

  return {
    name: metadata?.name as string,
    ready,
    roles,
    version,
    cpuCapacity,
    memoryCapacity,
  };
}

function mapEvent(raw: Record<string, unknown>): EventDTO {
  const metadata = raw.metadata as Record<string, unknown> | undefined;
  const involved = raw.involvedObject as Record<string, unknown> | undefined;
  const lastTimestamp = raw.lastTimestamp as Date | string | undefined;

  let lastSeen_ms = 0;
  if (lastTimestamp instanceof Date) {
    lastSeen_ms = lastTimestamp.getTime();
  } else if (typeof lastTimestamp === "string") {
    lastSeen_ms = new Date(lastTimestamp).getTime();
  }

  return {
    type: (raw.type as string) ?? "",
    reason: (raw.reason as string) ?? "",
    message: (raw.message as string) ?? "",
    involvedKind: (involved?.kind as string) ?? "",
    involvedName: (involved?.name as string) ?? "",
    namespace: metadata?.namespace as string | undefined,
    lastSeen_ms,
  };
}
