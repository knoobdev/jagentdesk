import { isIP } from "node:net";
import { KubeConfig, type Cluster, type Context, type User } from "@kubernetes/client-node";

// Pure kubeconfig work for Kubernetes through an SSH server (spec 25.10): pick one context of
// the server's kubeconfig and rewrite its API server to a local forward while TLS keeps
// validating the certificate against the ORIGINAL host name (`tls-server-name`).

export class ContextNotFoundError extends Error {
  constructor(readonly context: string) {
    super(`the kubeconfig has no context "${context}"`);
    this.name = "ContextNotFoundError";
  }
}

export interface SelectedContext {
  context: Context;
  cluster: Cluster;
  user: User;
}

export interface ApiServerTarget {
  host: string;
  port: number;
}

/** "ssh-<serverId>-<context>": the Clusters context name of an imported remote context. */
export function remoteContextName(serverId: string, context: string): string {
  return `ssh-${serverId}-${context}`;
}

/** The server a Clusters context was imported from, or null for ordinary contexts. */
export function serverIdOfContext(contextName: string): string | null {
  const match = /^ssh-(srv_[A-Za-z0-9]+)-/.exec(contextName);
  return match ? match[1] : null;
}

export function selectContext(source: KubeConfig, contextName: string): SelectedContext {
  const context = source.getContextObject(contextName);
  if (!context) throw new ContextNotFoundError(contextName);
  const cluster = source.getCluster(context.cluster);
  const user = source.getUser(context.user);
  if (!cluster || !user) throw new ContextNotFoundError(contextName);
  return { context, cluster, user };
}

function unbracket(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1");
}

export function apiServerTarget(cluster: Cluster): ApiServerTarget {
  const url = new URL(cluster.server);
  const defaultPort = url.protocol === "http:" ? 80 : 443;
  return { host: unbracket(url.hostname), port: url.port ? Number(url.port) : defaultPort };
}

/** The original host the API certificate is checked against; IPs cannot be TLS server names. */
export function tlsServerNameFor(cluster: Cluster): string | null {
  if (cluster.tlsServerName) return cluster.tlsServerName;
  const host = apiServerTarget(cluster).host;
  return isIP(host) ? null : host;
}

/** Single-context kubeconfig (JSON, valid YAML) holding `selected` with every file inlined. */
export function singleContextKubeconfig(selected: SelectedContext): string {
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [selected.cluster],
    users: [selected.user],
    contexts: [selected.context],
    currentContext: selected.context.name,
  });
  return config.exportConfig();
}

/**
 * What KubeClient loads: the context renamed to `remoteContextName`, its API server replaced by
 * https://127.0.0.1:<localPort>, TLS still verifying the original host name.
 */
export function forwardedKubeconfig(input: {
  selected: SelectedContext;
  serverId: string;
  localPort: number;
}): string {
  const { cluster, user, context } = input.selected;
  const name = remoteContextName(input.serverId, context.name);
  const url = new URL(cluster.server);
  const tlsServerName = tlsServerNameFor(cluster);
  const forwardedCluster: Cluster = {
    name: `${name}-cluster`,
    server: `${url.protocol}//127.0.0.1:${input.localPort}${url.pathname.replace(/\/$/, "")}`,
    skipTLSVerify: cluster.skipTLSVerify,
    ...(cluster.caData ? { caData: cluster.caData } : {}),
    ...(tlsServerName ? { tlsServerName } : {}),
  };
  const forwardedUser: User = { ...user, name: `${name}-user` };
  const forwardedContext: Context = {
    name,
    cluster: forwardedCluster.name,
    user: forwardedUser.name,
    ...(context.namespace ? { namespace: context.namespace } : {}),
  };
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [forwardedCluster],
    users: [forwardedUser],
    contexts: [forwardedContext],
    currentContext: name,
  });
  return config.exportConfig();
}
