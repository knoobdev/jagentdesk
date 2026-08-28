import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { KubeClient } from "./kube-client.js";
import { contextsFromKubeconfigString } from "./kube-config-source.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
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

// Persisted shape: identity only, never credentials. The live connection +
// node/pod counts are re-established at runtime, so they aren't stored.
const PersistedClustersSchema = z.array(
  z.object({ id: z.string(), contextName: z.string(), displayName: z.string() }),
);

export class ClusterRegistry {
  private clusters: Map<string, StoredCluster> = new Map();
  private clients: Map<string, KubeClient> = new Map();
  private readonly storePath: string | null;
  private readonly logger: Logger | null;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options?: { jagentdeskHome?: string; logger?: Logger }) {
    this.storePath = options?.jagentdeskHome
      ? path.join(options.jagentdeskHome, "clusters", "clusters.json")
      : null;
    this.logger = options?.logger ?? null;
  }

  /**
   * Load the persisted cluster identities so saved clusters (and their stable
   * ids) survive a daemon restart. Without this the registry was in-memory only:
   * ids regenerated on every restart and every re-import, so the app's saved
   * cluster ids went stale and "cluster not connected"/"not found" errors
   * appeared until the user re-added the kubeconfig.
   */
  async initialize(): Promise<void> {
    if (!this.storePath) return;
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      for (const c of PersistedClustersSchema.parse(JSON.parse(raw))) {
        this.clusters.set(c.id, {
          id: c.id,
          contextName: c.contextName,
          displayName: c.displayName,
          state: "saved",
        });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger?.error({ err: error, storePath: this.storePath }, "Failed to load clusters");
      }
    }
  }

  importContext(contextName: string, displayName?: string): ClusterInfo {
    // Reuse an existing entry for the same context so ids stay stable across
    // restarts / re-imports (the app persists cluster ids), instead of minting a
    // new id and orphaning the one the app already holds.
    const existing = Array.from(this.clusters.values()).find((c) => c.contextName === contextName);
    if (existing) {
      if (displayName && existing.displayName !== displayName) {
        existing.displayName = displayName;
        this.schedulePersist();
      }
      return toClusterInfo(existing);
    }
    const id = "clu_" + randomBytes(6).toString("hex");
    const entry: StoredCluster = {
      id,
      contextName,
      displayName: displayName ?? contextName,
      state: "saved",
    };
    this.clusters.set(id, entry);
    this.schedulePersist();
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

  private schedulePersist(): void {
    if (!this.storePath) return;
    const storePath = this.storePath;
    const snapshot = Array.from(this.clusters.values()).map((c) => ({
      id: c.id,
      contextName: c.contextName,
      displayName: c.displayName,
    }));
    this.persistQueue = this.persistQueue
      .then(() => writeJsonFileAtomic(storePath, snapshot))
      .catch((error) => {
        this.logger?.error({ err: error, storePath }, "Failed to persist clusters");
      });
  }
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
