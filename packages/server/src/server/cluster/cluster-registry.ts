import { randomBytes } from "node:crypto";
import { KubeClient } from "./kube-client.js";
import { contextsFromKubeconfigString } from "./kube-config-source.js";
import type { ClusterInfo, ClusterConnectionState } from "./cluster-dto.js";

interface StoredCluster {
  id: string;
  contextName: string;
  displayName: string;
  state: ClusterConnectionState;
  nodeCount?: number;
  podCount?: number;
  lastError?: string;
  lastSeen_ms?: number;
}

export class ClusterRegistry {
  private clusters: Map<string, StoredCluster> = new Map();
  private clients: Map<string, KubeClient> = new Map();

  importContext(contextName: string, displayName?: string): ClusterInfo {
    const id = "clu_" + randomBytes(6).toString("hex");
    const entry: StoredCluster = {
      id,
      contextName,
      displayName: displayName ?? contextName,
      state: "saved",
    };
    this.clusters.set(id, entry);
    return toClusterInfo(entry);
  }

  importKubeconfigString(yaml: string, displayName?: string): ClusterInfo[] {
    const contexts = contextsFromKubeconfigString(yaml);
    return contexts.map((ctx) => this.importContext(ctx.name, displayName));
  }

  list(): ClusterInfo[] {
    return Array.from(this.clusters.values()).map(toClusterInfo);
  }

  async connect(id: string): Promise<ClusterInfo> {
    const entry = this.clusters.get(id);
    if (!entry) {
      throw new Error(`cluster not found: ${id}`);
    }

    entry.state = "connecting";
    const client = new KubeClient(entry.contextName);

    try {
      await client.connect();
      entry.state = "connected";
      this.clients.set(id, client);

      // Update nodeCount/podCount
      try {
        const nodes = await client.listNodes();
        entry.nodeCount = nodes.length;
      } catch {
        // non-fatal
      }
      try {
        const pods = await client.listPods();
        entry.podCount = pods.length;
      } catch {
        // non-fatal
      }

      entry.lastSeen_ms = Date.now();
    } catch (err) {
      entry.state = "error";
      entry.lastError = err instanceof Error ? err.message : String(err);
    }

    return toClusterInfo(entry);
  }

  async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (client) {
      await client.disconnect();
      this.clients.delete(id);
    }
    const entry = this.clusters.get(id);
    if (entry) {
      entry.state = "saved";
    }
  }

  getClient(id: string): KubeClient | undefined {
    return this.clients.get(id);
  }

  // TODO: persist cluster list (contextName + displayName + id only, no credentials)
  // via daemon-config-store when available. Currently in-memory only.
} // ClusterRegistry

function toClusterInfo(entry: StoredCluster): ClusterInfo {
  return {
    id: entry.id,
    contextName: entry.contextName,
    displayName: entry.displayName,
    state: entry.state,
    nodeCount: entry.nodeCount,
    podCount: entry.podCount,
    lastError: entry.lastError,
    lastSeen_ms: entry.lastSeen_ms,
  };
}
