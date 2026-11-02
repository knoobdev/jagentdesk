import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { KubeConfig, type Cluster, type User } from "@kubernetes/client-node";
import type {
  RemoteK8sClusterInput,
  RemoteK8sErrorCode,
} from "@jagentdesk/protocol/ssh/remote-k8s-schemas";
import type { SecretStore } from "../../database/secret-store.js";
import { writePrivateFileAtomicSync } from "../../private-files.js";
import { readRemoteFile } from "../environment/remote-files.js";
import type { AcquireSshClient, SshClientLease } from "../ssh-client-lease.js";
import {
  openTemporaryTunnel,
  probeForward,
  TunnelError,
  type TemporaryTunnel,
} from "../temporary-tunnel.js";
import {
  ContextNotFoundError,
  apiServerTarget,
  forwardedKubeconfig,
  remoteContextName,
  selectContext,
  serverIdOfContext,
  singleContextKubeconfig,
  type SelectedContext,
} from "./kubeconfig.js";

// Kubernetes through an SSH server (spec 25.10). The kubeconfig holds credentials, so it is kept
// only in the daemon secret store; the file KubeClient's loadFromDefault() reads lives in
// `ssh/run/` (0600, directory 0700) while the context is active and is put on KUBECONFIG.

const KUBECONFIG_MAX_BYTES = 1024 * 1024;
const SECRET_PREFIX = "ssh.kubeconfig.";

export class RemoteK8sError extends Error {
  constructor(
    readonly code: RemoteK8sErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RemoteK8sError";
  }
}

export interface ImportRemoteK8sInput {
  serverId: string;
  /** On the server; relative paths start at the user's home (".kube/config"). */
  kubeconfigPath: string;
  context: string;
}

interface ActiveContext {
  serverId: string;
  lease: SshClientLease;
  tunnel: TemporaryTunnel;
  file: string;
}

function includeInKubeconfigPath(file: string): void {
  const defaultConfig = path.join(homedir(), ".kube", "config");
  const current = process.env.KUBECONFIG
    ? process.env.KUBECONFIG.split(path.delimiter).filter(Boolean)
    : [defaultConfig].filter((candidate) => existsSync(candidate));
  if (current.includes(file)) return;
  process.env.KUBECONFIG = [...current, file].join(path.delimiter);
}

function excludeFromKubeconfigPath(file: string): void {
  const remaining = (process.env.KUBECONFIG ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && entry !== file);
  if (remaining.length === 0) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = remaining.join(path.delimiter);
}

function fileName(contextName: string): string {
  return `kube-${contextName.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readText(lease: SshClientLease, remotePath: string): Promise<string> {
  const file = await readRemoteFile(lease.client, {
    path: remotePath,
    maxBytes: KUBECONFIG_MAX_BYTES,
  }).catch((error: unknown) => {
    throw new RemoteK8sError("kubeconfig_unreadable", `${remotePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  });
  if (file.content === null) {
    throw new RemoteK8sError("kubeconfig_unreadable", `${remotePath} is not a text file`);
  }
  return file.content;
}

// File references in a server's kubeconfig point at the server's disk: inline them as data.
async function inlineFiles(
  lease: SshClientLease,
  selected: SelectedContext,
): Promise<SelectedContext> {
  async function data(remotePath: string): Promise<string> {
    return Buffer.from(await readText(lease, remotePath), "utf8").toString("base64");
  }
  const { caFile, ...clusterRest } = selected.cluster;
  const cluster: Cluster = caFile ? { ...clusterRest, caData: await data(caFile) } : clusterRest;
  const { certFile, keyFile, ...userRest } = selected.user;
  const user: User = {
    ...userRest,
    ...(certFile ? { certData: await data(certFile) } : {}),
    ...(keyFile ? { keyData: await data(keyFile) } : {}),
  };
  return { context: selected.context, cluster, user };
}

function parseKubeconfig(yaml: string, remotePath: string): KubeConfig {
  const config = new KubeConfig();
  try {
    config.loadFromString(yaml);
  } catch (error) {
    throw new RemoteK8sError("kubeconfig_unreadable", `${remotePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return config;
}

export class RemoteK8sClusters {
  private readonly active = new Map<string, ActiveContext>();

  constructor(
    private readonly options: {
      acquire: AcquireSshClient;
      secrets: SecretStore;
      /** `$JAGENTDESK_HOME/ssh/run` */
      runDirectory: string;
    },
  ) {}

  /**
   * `ssh.remote_k8s.import`: reads the kubeconfig on the server, checks the API server is
   * reachable through it, activates the forwarded context and returns the `cluster/import` body.
   */
  async import(input: ImportRemoteK8sInput): Promise<RemoteK8sClusterInput> {
    const lease = await this.acquire(input.serverId);
    let selected: SelectedContext;
    try {
      const source = parseKubeconfig(
        await readText(lease, input.kubeconfigPath),
        input.kubeconfigPath,
      );
      selected = await inlineFiles(lease, selectContext(source, input.context));
      const target = apiServerTarget(selected.cluster);
      await probeForward(lease.client, target.host, target.port);
    } catch (error) {
      if (error instanceof ContextNotFoundError) {
        throw new RemoteK8sError("context_not_found", error.message, { cause: error });
      }
      if (error instanceof TunnelError && error.code !== "port_in_use") {
        throw new RemoteK8sError(error.code, error.message, { cause: error });
      }
      throw error;
    } finally {
      lease.release();
    }
    const contextName = remoteContextName(input.serverId, input.context);
    await this.options.secrets.set(
      `${SECRET_PREFIX}${contextName}`,
      singleContextKubeconfig(selected),
    );
    await this.deactivate(contextName);
    await this.activate(contextName);
    return { contextName, displayName: `${input.context} (${input.serverId})` };
  }

  /** True for contexts made by `import`; activate them before `cluster/connect`. */
  isRemoteContext(contextName: string): boolean {
    return serverIdOfContext(contextName) !== null;
  }

  /** Opens the forward and writes the kubeconfig KubeClient reads (idempotent). */
  async activate(contextName: string): Promise<void> {
    if (this.active.has(contextName)) return;
    const serverId = serverIdOfContext(contextName);
    const stored = await this.options.secrets.get(`${SECRET_PREFIX}${contextName}`);
    if (serverId === null || stored === null) {
      throw new Error(`no remote Kubernetes context ${contextName}`);
    }
    const source = new KubeConfig();
    source.loadFromString(stored);
    const selected = selectContext(source, source.getCurrentContext());
    const target = apiServerTarget(selected.cluster);
    const lease = await this.acquire(serverId);
    try {
      const tunnel = await openTemporaryTunnel({
        client: lease.client,
        bindHost: "127.0.0.1",
        bindPort: 0,
        destHost: target.host,
        destPort: target.port,
      });
      const file = path.join(this.options.runDirectory, fileName(contextName));
      writePrivateFileAtomicSync(
        file,
        forwardedKubeconfig({ selected, serverId, localPort: tunnel.port }),
      );
      includeInKubeconfigPath(file);
      this.active.set(contextName, { serverId, lease, tunnel, file });
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  /** Closes the forward and removes the runtime kubeconfig (cluster closed). */
  async deactivate(contextName: string): Promise<void> {
    const active = this.active.get(contextName);
    if (!active) return;
    this.active.delete(contextName);
    excludeFromKubeconfigPath(active.file);
    rmSync(active.file, { force: true });
    await active.tunnel.close();
    active.lease.release();
  }

  /** Call when S1 reports the server gone. */
  async onServerDisconnected(serverId: string): Promise<void> {
    const contexts = Array.from(this.active.entries())
      .filter(([, active]) => active.serverId === serverId)
      .map(([contextName]) => contextName);
    await Promise.all(contexts.map((contextName) => this.deactivate(contextName)));
  }

  /** Forget an imported context entirely (the cluster was removed from Clusters). */
  async remove(contextName: string): Promise<void> {
    await this.deactivate(contextName);
    await this.options.secrets.delete(`${SECRET_PREFIX}${contextName}`);
  }

  private async acquire(serverId: string): Promise<SshClientLease> {
    return this.options.acquire(serverId).catch((error: unknown) => {
      throw new RemoteK8sError("connect_failed", errorMessage(error), { cause: error });
    });
  }
}
