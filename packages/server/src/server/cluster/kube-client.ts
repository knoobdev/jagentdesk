import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  KubernetesObjectApi,
  ApiextensionsV1Api,
  loadYaml,
  dumpYaml,
  PatchStrategy,
} from "@kubernetes/client-node";
import type { KubernetesObject } from "@kubernetes/client-node";
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
  private objectApi: KubernetesObjectApi | undefined;
  private crdApi: ApiextensionsV1Api | undefined;
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
    this.objectApi = KubernetesObjectApi.makeApiClient(this.kc);
    this.crdApi = this.kc.makeApiClient(ApiextensionsV1Api);

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
          return this.applyGeneric(op.manifestYaml, op.dryRun);
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

  async listGeneric(kind: string, namespace?: string): Promise<Array<Record<string, unknown>>> {
    this.ensureConnected();
    const entry = findKindEntry(kind);
    const ns = entry.namespaced && namespace ? namespace : undefined;
    const res = await this.objectApi!.list(entry.apiVersion, entry.kind, ns);
    return (res as unknown as { items: Array<Record<string, unknown>> }).items;
  }

  async getGeneric(kind: string, namespace: string | undefined, name: string): Promise<string> {
    this.ensureConnected();
    const entry = findKindEntry(kind);
    const spec = {
      apiVersion: entry.apiVersion,
      kind: entry.kind,
      metadata: { name, namespace: entry.namespaced ? (namespace ?? "default") : undefined },
    } as unknown as Parameters<KubernetesObjectApi["read"]>[0];
    const obj = await this.objectApi!.read(spec);
    return dumpYaml(obj);
  }

  async applyGeneric(manifestYaml: string, dryRun: boolean): Promise<WriteResult> {
    this.ensureConnected();
    const dryRunOption = dryRun ? "All" : undefined;
    const obj = loadYaml<KubernetesObject>(manifestYaml);
    if (!obj.apiVersion || !obj.kind) {
      return { ok: false, dryRun, message: "manifest missing apiVersion or kind" };
    }
    try {
      await this.objectApi!.patch(
        obj,
        undefined,
        dryRunOption,
        "jagentdesk",
        true,
        PatchStrategy.ServerSideApply,
      );
      return { ok: true, dryRun, message: `applied ${obj.kind}/${obj.metadata?.name as string}` };
    } catch (patchErr) {
      const patchMsg = patchErr instanceof Error ? patchErr.message : String(patchErr);
      // If resource not found (404), fallback to create
      if (
        patchMsg.includes("404") ||
        patchMsg.includes("Not Found") ||
        patchMsg.includes("not found")
      ) {
        try {
          await this.objectApi!.create(obj, undefined, dryRunOption, "jagentdesk");
          return {
            ok: true,
            dryRun,
            message: `created ${obj.kind}/${obj.metadata?.name as string}`,
          };
        } catch (createErr) {
          return {
            ok: false,
            dryRun,
            message: createErr instanceof Error ? createErr.message : String(createErr),
          };
        }
      }
      return { ok: false, dryRun, message: patchMsg };
    }
  }

  async deleteGeneric(
    kind: string,
    namespace: string | undefined,
    name: string,
    dryRun: boolean,
  ): Promise<WriteResult> {
    this.ensureConnected();
    const entry = findKindEntry(kind);
    const dryRunOption = dryRun ? "All" : undefined;
    const spec: KubernetesObject = {
      apiVersion: entry.apiVersion,
      kind: entry.kind,
      metadata: { name, namespace: entry.namespaced ? (namespace ?? "default") : undefined },
    };
    try {
      await this.objectApi!.delete(spec, undefined, dryRunOption);
      return {
        ok: true,
        dryRun,
        message: `deleted ${kind}/${name}`,
      };
    } catch (err) {
      return {
        ok: false,
        dryRun,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async discoverCRDs(): Promise<
    Array<{ kind: string; apiVersion: string; namespaced: boolean; category: "Custom" }>
  > {
    this.ensureConnected();
    const res = await this.crdApi!.listCustomResourceDefinition();
    const list = res as unknown as { items: Array<Record<string, unknown>> };
    return list.items.map((crd) => {
      const spec = crd.spec as Record<string, unknown> | undefined;
      const names = spec?.names as Record<string, unknown> | undefined;
      const versions = spec?.versions as Array<Record<string, unknown>> | undefined;
      const servedVersion = versions?.find((v) => v.served === true) ?? versions?.[0];
      const group = spec?.group as string | undefined;
      const version = servedVersion?.name as string | undefined;
      return {
        kind: (names?.kind as string) ?? "Unknown",
        apiVersion: group && version ? `${group}/${version}` : "Unknown",
        namespaced: (spec?.scope as string) === "Namespaced",
        category: "Custom" as const,
      };
    });
  }

  async revealSecret(namespace: string, name: string): Promise<Record<string, string>> {
    this.ensureConnected();
    const spec = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, namespace },
    } as unknown as Parameters<KubernetesObjectApi["read"]>[0];
    const secret = await this.objectApi!.read(spec);
    const data = (secret as unknown as { data?: Record<string, string> }).data ?? {};
    const result: Record<string, string> = {};
    for (const [key, val] of Object.entries(data)) {
      try {
        result[key] = Buffer.from(val, "base64").toString("utf-8");
      } catch {
        result[key] = val;
      }
    }
    return result;
  }

  async disconnect(): Promise<void> {
    this.kc = undefined;
    this.coreApi = undefined;
    this.appsApi = undefined;
  }

  private ensureConnected(): void {
    if (!this.coreApi || !this.appsApi || !this.objectApi) {
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

interface GenericKindEntry {
  kind: string;
  apiVersion: string;
  namespaced: boolean;
  category: string;
}

function findKindEntry(kind: string): GenericKindEntry {
  const lower = kind.toLowerCase();
  const entry = GENERIC_KINDS.find((e) => e.kind.toLowerCase() === lower);
  if (!entry) {
    throw new Error(`unsupported kind: ${kind}`);
  }
  return entry;
}

export const GENERIC_KINDS: ReadonlyArray<GenericKindEntry> = [
  // Workloads
  { kind: "Pod", apiVersion: "v1", namespaced: true, category: "Workloads" },
  { kind: "Deployment", apiVersion: "apps/v1", namespaced: true, category: "Workloads" },
  { kind: "DaemonSet", apiVersion: "apps/v1", namespaced: true, category: "Workloads" },
  { kind: "StatefulSet", apiVersion: "apps/v1", namespaced: true, category: "Workloads" },
  { kind: "ReplicaSet", apiVersion: "apps/v1", namespaced: true, category: "Workloads" },
  { kind: "ReplicationController", apiVersion: "v1", namespaced: true, category: "Workloads" },
  { kind: "Job", apiVersion: "batch/v1", namespaced: true, category: "Workloads" },
  { kind: "CronJob", apiVersion: "batch/v1", namespaced: true, category: "Workloads" },
  // Config
  { kind: "ConfigMap", apiVersion: "v1", namespaced: true, category: "Config" },
  { kind: "Secret", apiVersion: "v1", namespaced: true, category: "Config" },
  { kind: "ResourceQuota", apiVersion: "v1", namespaced: true, category: "Config" },
  { kind: "LimitRange", apiVersion: "v1", namespaced: true, category: "Config" },
  {
    kind: "HorizontalPodAutoscaler",
    apiVersion: "autoscaling/v2",
    namespaced: true,
    category: "Config",
  },
  { kind: "PodDisruptionBudget", apiVersion: "policy/v1", namespaced: true, category: "Config" },
  {
    kind: "PriorityClass",
    apiVersion: "scheduling.k8s.io/v1",
    namespaced: false,
    category: "Config",
  },
  { kind: "RuntimeClass", apiVersion: "node.k8s.io/v1", namespaced: false, category: "Config" },
  // Network
  { kind: "Service", apiVersion: "v1", namespaced: true, category: "Network" },
  { kind: "Endpoints", apiVersion: "v1", namespaced: true, category: "Network" },
  { kind: "Ingress", apiVersion: "networking.k8s.io/v1", namespaced: true, category: "Network" },
  {
    kind: "IngressClass",
    apiVersion: "networking.k8s.io/v1",
    namespaced: false,
    category: "Network",
  },
  {
    kind: "NetworkPolicy",
    apiVersion: "networking.k8s.io/v1",
    namespaced: true,
    category: "Network",
  },
  // Storage
  { kind: "PersistentVolumeClaim", apiVersion: "v1", namespaced: true, category: "Storage" },
  { kind: "PersistentVolume", apiVersion: "v1", namespaced: false, category: "Storage" },
  { kind: "StorageClass", apiVersion: "storage.k8s.io/v1", namespaced: false, category: "Storage" },
  // Cluster
  { kind: "Namespace", apiVersion: "v1", namespaced: false, category: "Cluster" },
  { kind: "Node", apiVersion: "v1", namespaced: false, category: "Cluster" },
  { kind: "Event", apiVersion: "v1", namespaced: true, category: "Cluster" },
  // Access
  { kind: "ServiceAccount", apiVersion: "v1", namespaced: true, category: "Access" },
  {
    kind: "ClusterRole",
    apiVersion: "rbac.authorization.k8s.io/v1",
    namespaced: false,
    category: "Access",
  },
  {
    kind: "Role",
    apiVersion: "rbac.authorization.k8s.io/v1",
    namespaced: true,
    category: "Access",
  },
  {
    kind: "ClusterRoleBinding",
    apiVersion: "rbac.authorization.k8s.io/v1",
    namespaced: false,
    category: "Access",
  },
  {
    kind: "RoleBinding",
    apiVersion: "rbac.authorization.k8s.io/v1",
    namespaced: true,
    category: "Access",
  },
];
