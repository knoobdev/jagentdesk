import {
  normalizeHostPort,
  normalizeLoopbackToLocalhost,
} from "@jagentdesk/protocol/daemon-endpoints";
import {
  DirectTcpHostConnectionSchema,
  type DirectTcpHostConnection,
} from "@jagentdesk/protocol/host-connection-schema";
import {
  type HostAppearance,
  defaultHostAppearance,
  normalizeStoredHostAppearance,
} from "@/hosts/appearance";

export { DirectTcpHostConnectionSchema, type DirectTcpHostConnection };

export interface DirectSocketHostConnection {
  id: string;
  type: "directSocket";
  path: string;
}

export interface DirectPipeHostConnection {
  id: string;
  type: "directPipe";
  path: string;
}

export interface TailnetHostConnection {
  id: string;
  type: "tailnet";
  tailnetAddress: string; // host:port on the tailnet, e.g. "100.x.y.z:6768" or a MagicDNS name
  useTls?: boolean;
  daemonPublicKeyB64: string;
  pairingCode?: string;
}

export type HostConnection =
  | DirectTcpHostConnection
  | DirectSocketHostConnection
  | DirectPipeHostConnection
  | TailnetHostConnection;

export type HostLifecycle = Record<string, never>;

export interface HostProfile {
  serverId: string;
  label: string;
  appearance: HostAppearance;
  lifecycle: HostLifecycle;
  connections: HostConnection[];
  preferredConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function defaultLifecycle(): HostLifecycle {
  return {};
}

export function normalizeHostLabel(value: string | null | undefined, serverId: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : serverId;
}

/**
 * A short, human-readable hint for which connection a host uses, so two hosts
 * that happen to share a hostname (e.g. the same machine reachable both over
 * the tailnet and over localhost, both labelled "workstation.local") can be told
 * apart. Prefers the host's preferred connection, falling back to the first.
 */
export function hostConnectionHint(host: HostProfile): string {
  const conn =
    host.connections.find((c) => c.id === host.preferredConnectionId) ?? host.connections[0];
  if (!conn) return host.serverId.slice(0, 8);
  switch (conn.type) {
    case "directTcp":
      return conn.endpoint;
    case "tailnet":
      return conn.tailnetAddress;
    case "directSocket":
    case "directPipe":
      return conn.path;
    default:
      return host.serverId.slice(0, 8);
  }
}

/**
 * Return the hosts with display labels made unique: any label shared by more
 * than one host gets its connection hint appended (e.g. "workstation.local
 * (localhost:6796)" vs "workstation.local (node-1.example.ts.net:6768)"). Hosts
 * whose label is already unique are returned unchanged. Pure and idempotent
 * when fed the raw (un-disambiguated) labels; callers should memoize on the
 * source array so the result reference stays stable.
 */
export function disambiguateHostLabels(hosts: readonly HostProfile[]): HostProfile[] {
  const labelCounts = new Map<string, number>();
  for (const host of hosts) {
    labelCounts.set(host.label, (labelCounts.get(host.label) ?? 0) + 1);
  }
  return hosts.map((host) =>
    (labelCounts.get(host.label) ?? 0) > 1
      ? { ...host, label: `${host.label} (${hostConnectionHint(host)})` }
      : host,
  );
}

export function orderHostsLocalFirst<T extends { serverId: string }>(
  hosts: T[],
  localServerId: string | null,
): T[] {
  if (!localServerId) {
    return hosts;
  }
  const localIndex = hosts.findIndex((host) => host.serverId === localServerId);
  if (localIndex <= 0) {
    return hosts;
  }
  const ordered = hosts.slice();
  const [local] = ordered.splice(localIndex, 1);
  if (local) {
    ordered.unshift(local);
  }
  return ordered;
}

/**
 * Resolves which host a settings host section should target: the picker
 * selection, else the local daemon, else the first connected host.
 *
 * Only a serverId that names a currently connected host is used. Both the
 * selection and the local daemon can name a host that isn't connected (a stale
 * selection, or a local daemon whose id persists in storage while it's stopped);
 * using one would resolve the section to an unknown id and render "host not found".
 */
export function resolveActiveHostServerId(params: {
  selectedServerId: string | null;
  localServerId: string | null;
  hosts: readonly { serverId: string }[];
  orderedHosts: readonly { serverId: string }[];
}): string | null {
  const { selectedServerId, localServerId, hosts, orderedHosts } = params;
  const connected = (serverId: string | null): string | null =>
    serverId && hosts.some((host) => host.serverId === serverId) ? serverId : null;
  return (
    connected(selectedServerId) ?? connected(localServerId) ?? orderedHosts[0]?.serverId ?? null
  );
}

function hostConnectionEquals(left: HostConnection, right: HostConnection): boolean {
  if (left.type !== right.type || left.id !== right.id) {
    return false;
  }

  if (left.type === "directTcp" && right.type === "directTcp") {
    return (
      left.endpoint === right.endpoint &&
      (left.useTls ?? false) === (right.useTls ?? false) &&
      left.password === right.password
    );
  }
  if (left.type === "directSocket" && right.type === "directSocket") {
    return left.path === right.path;
  }
  if (left.type === "directPipe" && right.type === "directPipe") {
    return left.path === right.path;
  }
  if (left.type === "tailnet" && right.type === "tailnet") {
    return (
      left.tailnetAddress === right.tailnetAddress &&
      (left.useTls ?? false) === (right.useTls ?? false) &&
      left.daemonPublicKeyB64 === right.daemonPublicKeyB64
    );
  }

  return false;
}

function hostLifecycleEquals(left: HostLifecycle, right: HostLifecycle): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dedupeHostConnections(connections: HostConnection[]): HostConnection[] {
  const next: HostConnection[] = [];
  for (const connection of connections) {
    if (next.some((existing) => hostConnectionEquals(existing, connection))) {
      continue;
    }
    next.push(connection);
  }
  return next;
}

export function upsertHostConnectionInProfiles(input: {
  profiles: HostProfile[];
  serverId: string;
  label?: string;
  connection: HostConnection;
  now?: string;
}): HostProfile[] {
  const serverId = input.serverId.trim();
  if (!serverId) {
    throw new Error("serverId is required");
  }

  const now = input.now ?? new Date().toISOString();
  const labelTrimmed = input.label?.trim() ?? "";
  const derivedLabel = labelTrimmed || serverId;
  const existing = input.profiles;
  const matchingIndexes = existing.reduce<number[]>((matches, daemon, index) => {
    if (
      daemon.serverId === serverId ||
      daemon.connections.some((connection) => hostConnectionEquals(connection, input.connection))
    ) {
      matches.push(index);
    }
    return matches;
  }, []);

  if (matchingIndexes.length === 0) {
    const profile: HostProfile = {
      serverId,
      label: derivedLabel,
      appearance: defaultHostAppearance(),
      lifecycle: defaultLifecycle(),
      connections: [input.connection],
      preferredConnectionId: input.connection.id,
      createdAt: now,
      updatedAt: now,
    };
    return [...existing, profile];
  }

  const matchedProfiles = matchingIndexes.map((index) => existing[index]);
  const prev = matchedProfiles.find((daemon) => daemon.serverId === serverId) ?? matchedProfiles[0];
  const nextConnections = dedupeHostConnections([
    ...matchedProfiles.flatMap((daemon) => daemon.connections),
    input.connection,
  ]);
  const nextLifecycle = prev.lifecycle;
  const nextLabel = prev.label === prev.serverId ? derivedLabel : prev.label;
  const nextPreferredConnectionId =
    prev.preferredConnectionId &&
    nextConnections.some((connection) => connection.id === prev.preferredConnectionId)
      ? prev.preferredConnectionId
      : input.connection.id;
  const nextCreatedAt = matchedProfiles.reduce(
    (earliest, daemon) => (daemon.createdAt < earliest ? daemon.createdAt : earliest),
    prev.createdAt,
  );
  const changed =
    matchingIndexes.length > 1 ||
    prev.serverId !== serverId ||
    nextCreatedAt !== prev.createdAt ||
    nextLabel !== prev.label ||
    nextPreferredConnectionId !== prev.preferredConnectionId ||
    !hostLifecycleEquals(prev.lifecycle, nextLifecycle) ||
    nextConnections.length !== prev.connections.length ||
    nextConnections.some((connection, index) => {
      const previousConnection = prev.connections[index];
      return !previousConnection || !hostConnectionEquals(connection, previousConnection);
    });

  if (!changed) {
    return existing;
  }

  const nextProfile: HostProfile = {
    ...prev,
    serverId,
    label: nextLabel,
    lifecycle: nextLifecycle,
    connections: nextConnections,
    preferredConnectionId: nextPreferredConnectionId,
    createdAt: nextCreatedAt,
    updatedAt: now,
  };

  const firstIndex = matchingIndexes[0];
  const matchingIndexSet = new Set(matchingIndexes);
  const next = existing.filter((_daemon, index) => !matchingIndexSet.has(index));
  next.splice(firstIndex, 0, nextProfile);
  return next;
}

export function connectionFromListen(listen: string): HostConnection | null {
  const normalizedListen = listen.trim();
  if (!normalizedListen) {
    return null;
  }

  if (normalizedListen.startsWith("pipe://")) {
    const path = normalizedListen.slice("pipe://".length).trim();
    return path ? { id: `pipe:${path}`, type: "directPipe", path } : null;
  }

  if (normalizedListen.startsWith("unix://")) {
    const path = normalizedListen.slice("unix://".length).trim();
    return path ? { id: `socket:${path}`, type: "directSocket", path } : null;
  }

  if (normalizedListen.startsWith("\\\\.\\pipe\\")) {
    return {
      id: `pipe:${normalizedListen}`,
      type: "directPipe",
      path: normalizedListen,
    };
  }

  if (normalizedListen.startsWith("/")) {
    return {
      id: `socket:${normalizedListen}`,
      type: "directSocket",
      path: normalizedListen,
    };
  }

  try {
    const endpoint = normalizeLoopbackToLocalhost(normalizeHostPort(normalizedListen));
    return {
      id: `direct:${endpoint}`,
      type: "directTcp",
      endpoint,
    };
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function normalizeStoredDirectTcp(record: Record<string, unknown>): HostConnection | null {
  try {
    const endpoint = normalizeLoopbackToLocalhost(
      normalizeHostPort(typeof record.endpoint === "string" ? record.endpoint : ""),
    );
    return DirectTcpHostConnectionSchema.parse({
      id: `direct:${endpoint}`,
      type: "directTcp",
      endpoint,
      useTls: record.useTls,
      ...(typeof record.password === "string" ? { password: record.password } : {}),
    });
  } catch {
    return null;
  }
}

function normalizeStoredTailnet(record: Record<string, unknown>): HostConnection | null {
  try {
    const tailnetAddress = normalizeHostPort(
      typeof record.tailnetAddress === "string" ? record.tailnetAddress : "",
    );
    const daemonPublicKeyB64 = (
      typeof record.daemonPublicKeyB64 === "string" ? record.daemonPublicKeyB64 : ""
    ).trim();
    if (!daemonPublicKeyB64) return null;
    const useTls = typeof record.useTls === "boolean" ? record.useTls : undefined;
    return {
      id: useTls === true ? `tailnet:wss:${tailnetAddress}` : `tailnet:${tailnetAddress}`,
      type: "tailnet",
      tailnetAddress,
      ...(useTls !== undefined ? { useTls } : {}),
      daemonPublicKeyB64,
      ...(typeof record.pairingCode === "string" && /^\d{6}$/.test(record.pairingCode)
        ? { pairingCode: record.pairingCode }
        : {}),
    };
  } catch {
    return null;
  }
}

function normalizeStoredConnection(connection: unknown): HostConnection | null {
  const record = toObjectRecord(connection);
  if (!record) {
    return null;
  }
  const type = record.type;
  if (type === "directTcp") {
    return normalizeStoredDirectTcp(record);
  }
  if (type === "directSocket") {
    const path = (typeof record.path === "string" ? record.path : "").trim();
    return path ? { id: `socket:${path}`, type: "directSocket", path } : null;
  }
  if (type === "directPipe") {
    const path = (typeof record.path === "string" ? record.path : "").trim();
    return path ? { id: `pipe:${path}`, type: "directPipe", path } : null;
  }
  if (type === "tailnet") {
    return normalizeStoredTailnet(record);
  }

  return null;
}

export function normalizeStoredHostProfile(entry: unknown): HostProfile | null {
  const record = toObjectRecord(entry);
  if (!record) {
    return null;
  }
  const serverId = typeof record.serverId === "string" ? record.serverId.trim() : "";
  if (!serverId) {
    return null;
  }

  const rawConnections = Array.isArray(record.connections) ? record.connections : [];
  const connections = rawConnections
    .map((connection) => normalizeStoredConnection(connection))
    .filter((connection): connection is HostConnection => connection !== null);
  if (connections.length === 0) {
    return null;
  }

  const now = new Date().toISOString();
  const label = normalizeHostLabel(
    typeof record.label === "string" ? record.label : null,
    serverId,
  );
  const preferredConnectionId =
    typeof record.preferredConnectionId === "string" &&
    connections.some((connection) => connection.id === record.preferredConnectionId)
      ? record.preferredConnectionId
      : (connections[0]?.id ?? null);

  return {
    serverId,
    label,
    appearance: normalizeStoredHostAppearance(record.appearance),
    lifecycle: defaultLifecycle(),
    connections,
    preferredConnectionId,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
  };
}

/**
 * True when the host has at least one connection that is reachable without
 * Tailscale (a direct TCP/socket/pipe endpoint). A host whose connections are
 * ALL `tailnet` cannot be reached in local connection mode, so the host list
 * hides it there (see `HostRuntimeStore.getHosts`).
 */
export function hostHasLocalConnection(host: HostProfile): boolean {
  return host.connections.some((connection) => connection.type !== "tailnet");
}

/** True when the host has at least one `tailnet` connection. */
export function hostHasTailnetConnection(host: HostProfile): boolean {
  return host.connections.some((connection) => connection.type === "tailnet");
}

export function hostHasConnection(host: HostProfile, connection: HostConnection): boolean {
  return host.connections.some((existing) => hostConnectionEquals(existing, connection));
}

export function registryHasConnection(hosts: HostProfile[], connection: HostConnection): boolean {
  return hosts.some((host) => hostHasConnection(host, connection));
}
