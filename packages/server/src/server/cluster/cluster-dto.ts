export interface KubeContextInfo {
  name: string;
  cluster: string;
  server: string;
  user: string;
  namespace?: string;
  current: boolean;
}

export type ClusterConnectionState = "saved" | "connecting" | "connected" | "error";

export interface ContainerDTO {
  name: string;
  image: string;
  ready: boolean;
  restartCount: number;
  state: string /* Running|Waiting:<reason>|Terminated:<reason> */;
  memoryLimit?: string;
  memoryRequest?: string;
  lastExitCode?: number;
}

export interface PodDTO {
  name: string;
  namespace: string;
  phase: string;
  ready: string /* "1/1" */;
  restarts: number;
  node?: string;
  containers: ContainerDTO[];
  labels: Record<string, string>;
  createdAt_ms: number;
  statusReason?: string /* CrashLoopBackOff... */;
}

export interface DeploymentDTO {
  name: string;
  namespace: string;
  ready: string;
  available: number;
  desired: number;
  updatedAt_ms: number;
  labels: Record<string, string>;
}

export interface NodeDTO {
  name: string;
  ready: boolean;
  roles: string[];
  version: string;
  cpuCapacity?: string;
  memoryCapacity?: string;
}

export interface EventDTO {
  type: string /* Normal|Warning */;
  reason: string;
  message: string;
  involvedKind: string;
  involvedName: string;
  namespace?: string;
  lastSeen_ms: number;
}

export interface ClusterInfo {
  id: string /* clu_<hex> */;
  contextName: string;
  displayName: string;
  distro?: string;
  state: ClusterConnectionState;
  nodeCount?: number;
  podCount?: number;
  lastError?: string;
  lastSeen_ms?: number;
}

export interface WriteResult {
  ok: boolean;
  dryRun: boolean;
  message: string;
}
