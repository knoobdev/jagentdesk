import crypto from "node:crypto";
import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  KubernetesObjectApi,
  ApiextensionsV1Api,
  Metrics,
  Log,
  Exec,
  PortForward,
  loadYaml,
  dumpYaml,
  PatchStrategy,
} from "@kubernetes/client-node";
import type { KubernetesObject } from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
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

  get context(): string {
    return this.contextName;
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
      // Every other kind (StatefulSet, DaemonSet, Secret, Ingress, PVC, Job,
      // CronJob, HPA, ServiceAccount, CRDs, …) is read through the dynamic
      // object API so the detail view works for the full discovered kind set,
      // not just the six hand-wired kinds above.
      return this.getGeneric(kind, namespace, name);
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

  async streamPodLogs(
    namespace: string,
    pod: string,
    container: string | undefined,
    onChunk: (text: string) => void,
  ): Promise<() => void> {
    this.ensureConnected();
    const stream = new PassThrough();
    const log = new Log(this.kc!);
    const controller = await log.log(namespace, pod, container ?? "", stream, {
      follow: true,
      tailLines: 100,
      pretty: false,
    });
    stream.on("data", (d: Buffer) => onChunk(d.toString()));
    return () => {
      controller.abort();
      stream.destroy();
    };
  }

  async execInPod(
    namespace: string,
    pod: string,
    container: string | undefined,
    command: string[],
    onData: (text: string) => void,
  ): Promise<{ write: (data: string) => void; close: () => void }> {
    this.ensureConnected();
    const cmd = command.length > 0 ? command : ["/bin/sh"];

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const stdinStream = new PassThrough();

    const exec = new Exec(this.kc!);
    let ws: import("ws").WebSocket | null = null;

    const dataHandler = (d: Buffer) => onData(d.toString());
    stdoutStream.on("data", dataHandler);
    stderrStream.on("data", dataHandler);

    ws = await exec.exec(
      namespace,
      pod,
      container ?? "",
      cmd,
      stdoutStream,
      stderrStream,
      stdinStream,
      true, // tty
      // Surface the exec error channel (channel 3). Without this, a pod whose
      // image has no shell (distroless) — or a wrong container — leaves the
      // terminal blank forever; now it prints why the shell could not start.
      (status) => {
        if (status.status === "Failure") {
          const reason = status.message ?? status.reason ?? "exec failed";
          onData(`\r\n\x1b[31m[shell unavailable] ${reason}\x1b[0m\r\n`);
        }
      },
    );

    return {
      write(data: string): void {
        stdinStream.write(data);
      },
      close(): void {
        ws?.close();
        stdinStream.destroy();
        stdoutStream.destroy();
        stderrStream.destroy();
      },
    };
  }

  async startPortForward(
    namespace: string,
    pod: string,
    podPort: number,
    onData: (chunk: Buffer) => void,
  ): Promise<{ write: (d: Buffer) => void; close: () => void }> {
    this.ensureConnected();
    const outStream = new PassThrough();
    const inStream = new PassThrough();
    const pf = new PortForward(this.kc!);
    outStream.on("data", (d: Buffer) => onData(d));
    const conn = await pf.portForward(namespace, pod, [podPort], outStream, null, inStream);
    return {
      write(d: Buffer): void {
        inStream.write(d);
      },
      close(): void {
        inStream.destroy();
        outStream.destroy();
        if (typeof conn === "function") {
          conn();
        } else {
          conn.close();
        }
      },
    };
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
          const scalable = ["deployment", "statefulset", "replicaset", "replicationcontroller"];
          if (!scalable.includes(kindLower)) {
            return {
              ok: false,
              dryRun: op.dryRun,
              message: `scale not supported for kind: ${op.kind}`,
            };
          }
          const entry = findKindEntry(op.kind);
          // Merge-patch spec.replicas. The typed patchNamespaced* helpers default
          // to a JSON-patch content type (which expects an array of ops) and
          // reject our object body with a 400; the generic object API lets us
          // pick the correct merge-patch strategy.
          await this.objectApi!.patch(
            {
              apiVersion: entry.apiVersion,
              kind: entry.kind,
              metadata: { name: op.name, namespace: op.namespace ?? "default" },
              spec: { replicas: op.replicas },
            } as KubernetesObject,
            undefined,
            dryRunOption,
            undefined,
            undefined,
            PatchStrategy.MergePatch,
          );
          break;
        }
        case "delete": {
          return this.deleteGeneric(op.kind, op.namespace, op.name, op.dryRun);
        }
        case "restart": {
          const kindLower = op.kind.toLowerCase();
          const restartable = ["deployment", "statefulset", "daemonset"];
          if (!restartable.includes(kindLower)) {
            return {
              ok: false,
              dryRun: op.dryRun,
              message: `restart not supported for kind: ${op.kind}`,
            };
          }
          const entry = findKindEntry(op.kind);
          await this.objectApi!.patch(
            {
              apiVersion: entry.apiVersion,
              kind: entry.kind,
              metadata: { name: op.name, namespace: op.namespace ?? "default" },
              spec: {
                template: {
                  metadata: {
                    annotations: {
                      "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
                    },
                  },
                },
              },
            } as KubernetesObject,
            undefined,
            dryRunOption,
            undefined,
            undefined,
            PatchStrategy.StrategicMergePatch,
          );
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

  async cordonNode(name: string, unschedulable: boolean): Promise<WriteResult> {
    this.ensureConnected();
    try {
      const body = {
        apiVersion: "v1",
        kind: "Node",
        metadata: { name },
        spec: { unschedulable },
      } as unknown as KubernetesObject;
      await this.objectApi!.patch(
        body,
        undefined,
        undefined,
        "jagentdesk",
        true,
        PatchStrategy.ServerSideApply,
      );
      const action = unschedulable ? "cordoned" : "uncordoned";
      return { ok: true, dryRun: false, message: `node ${name} ${action}` };
    } catch (err) {
      return {
        ok: false,
        dryRun: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async triggerCronJob(namespace: string, name: string): Promise<WriteResult> {
    this.ensureConnected();
    try {
      const yaml = await this.getGeneric("CronJob", namespace, name);
      const cronJob = loadYaml<Record<string, unknown>>(yaml);
      const jobTemplate = (cronJob.spec as Record<string, unknown> | undefined)?.jobTemplate as
        | Record<string, unknown>
        | undefined;
      if (!jobTemplate) {
        return {
          ok: false,
          dryRun: false,
          message: `CronJob ${name} has no spec.jobTemplate`,
        };
      }
      const suffix = crypto.randomBytes(5).toString("hex");
      const jobName = `${name}-manual-${suffix}`;
      const job: Record<string, unknown> = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: jobName,
          namespace,
          ownerReferences: [
            {
              apiVersion: "batch/v1",
              kind: "CronJob",
              name,
              uid: (cronJob.metadata as Record<string, unknown> | undefined)?.uid as
                | string
                | undefined,
            },
          ],
        },
        spec: jobTemplate.spec,
      };
      await this.objectApi!.create(
        job as unknown as KubernetesObject,
        undefined,
        undefined,
        "jagentdesk",
      );
      return {
        ok: true,
        dryRun: false,
        message: `created Job ${jobName} from CronJob ${name}`,
      };
    } catch (err) {
      return {
        ok: false,
        dryRun: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async setCronJobSuspend(namespace: string, name: string, suspend: boolean): Promise<WriteResult> {
    this.ensureConnected();
    try {
      const body = {
        apiVersion: "batch/v1",
        kind: "CronJob",
        metadata: { name, namespace },
        spec: { suspend },
      } as unknown as KubernetesObject;
      await this.objectApi!.patch(
        body,
        undefined,
        undefined,
        "jagentdesk",
        true,
        PatchStrategy.ServerSideApply,
      );
      const action = suspend ? "suspended" : "resumed";
      return { ok: true, dryRun: false, message: `CronJob ${name} ${action}` };
    } catch (err) {
      return {
        ok: false,
        dryRun: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getNodeMetrics(): Promise<Array<{ name: string; cpuNano: number; memoryBytes: number }>> {
    this.ensureConnected();
    const metrics = new Metrics(this.kc!);
    try {
      const list = await metrics.getNodeMetrics();
      return list.items.map((item) => ({
        name: item.metadata.name,
        cpuNano: parseCpuToNano(item.usage.cpu),
        memoryBytes: parseMemToBytes(item.usage.memory),
      }));
    } catch {
      // Metrics are best-effort: many clusters have no metrics-server (or a
      // broken metrics.k8s.io APIService that 500s with a non-JSON body). Treat
      // any failure as "no metrics" so the CPU/MEM columns simply stay empty
      // instead of surfacing an error over an otherwise-working resource list.
      return [];
    }
  }

  async getPodMetrics(
    namespace?: string,
  ): Promise<Array<{ name: string; namespace: string; cpuNano: number; memoryBytes: number }>> {
    this.ensureConnected();
    const metrics = new Metrics(this.kc!);
    try {
      const list = await metrics.getPodMetrics(namespace);
      return list.items.map((item) => {
        const totalCpu = item.containers.reduce((sum, c) => sum + parseCpuToNano(c.usage.cpu), 0);
        const totalMem = item.containers.reduce(
          (sum, c) => sum + parseMemToBytes(c.usage.memory),
          0,
        );
        return {
          name: item.metadata.name,
          namespace: item.metadata.namespace,
          cpuNano: totalCpu,
          memoryBytes: totalMem,
        };
      });
    } catch {
      // Best-effort: see getNodeMetrics — no metrics-server means empty columns,
      // not an error.
      return [];
    }
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

export function parseCpuToNano(s: string): number {
  const trimmed = s.trim();
  if (trimmed.endsWith("n")) {
    return parseInt(trimmed.slice(0, -1), 10) || 0;
  }
  if (trimmed.endsWith("m")) {
    return (parseFloat(trimmed.slice(0, -1)) || 0) * 1_000_000;
  }
  if (trimmed.endsWith("u")) {
    return (parseFloat(trimmed.slice(0, -1)) || 0) * 1000;
  }
  return (parseFloat(trimmed) || 0) * 1_000_000_000;
}

export function parseMemToBytes(s: string): number {
  const trimmed = s.trim();
  const match = trimmed.match(/^([\d.]+)\s*(K|M|G|T|Ki|Mi|Gi|Ti)?i?$/);
  if (!match) return parseInt(trimmed, 10) || 0;
  const val = parseFloat(match[1]) || 0;
  const suffix = match[2] ?? "";
  switch (suffix) {
    case "K":
      return val * 1000;
    case "M":
      return val * 1_000_000;
    case "G":
      return val * 1_000_000_000;
    case "T":
      return val * 1_000_000_000_000;
    case "Ki":
      return val * 1024;
    case "Mi":
      return val * 1024 * 1024;
    case "Gi":
      return val * 1024 * 1024 * 1024;
    case "Ti":
      return val * 1024 * 1024 * 1024 * 1024;
    default:
      return val;
  }
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
