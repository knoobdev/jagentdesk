import type {
  SshAuthMethod,
  SshGroup,
  SshIdentity,
  SshProtocol,
  SshProxy,
  SshServer,
} from "@jagentdesk/protocol/ssh/rpc-schemas";

// Spec 25.2: a server's effective config is nearest-ancestor-per-field — each
// inheritable field independently walks server → parent group → grandparent group.
// A field that is empty ("" / [] / {}) counts as unset and keeps walking. Defaults
// apply only when nothing in the chain sets the field. Pure functions so the
// resolution order is unit-testable without storage or networking.

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_TELNET_PORT = 23;
export const DEFAULT_KEEPALIVE_INTERVAL_S = 30;
export const DEFAULT_SSH_AUTH_METHODS: readonly SshAuthMethod[] = [
  "password",
  "key",
  "keyboard-interactive",
];

export interface InheritableFields {
  port?: number;
  username?: string;
  identityId?: string;
  authMethods?: SshAuthMethod[];
  jumpChain?: string[];
  proxy?: SshProxy;
  env?: Record<string, string>;
  startupSnippetId?: string;
  agentForwarding?: boolean;
  keepaliveIntervalS?: number;
  autoReconnect?: boolean;
  theme?: string;
  fontSize?: number;
}

type InheritableKey = keyof InheritableFields;

export interface ResolvedSshConfig {
  serverId: string;
  host: string;
  port: number;
  protocol: SshProtocol;
  /**
   * How the daemon reaches this host (spec 33.2): "direct" TCP (default) or
   * through the tsnet node's loopback SOCKS5. Server-only: groups never set it.
   */
  via?: "direct" | "tailnet";
  username?: string;
  identityId?: string;
  /** Present when the resolved identity references a key. */
  keyId?: string;
  authMethods: SshAuthMethod[];
  jumpChain: string[];
  proxy?: SshProxy;
  /** The server or group that defines `proxy`: its secret is `ssh.proxy.<proxyOwnerId>`. */
  proxyOwnerId?: string;
  env: Record<string, string>;
  startupSnippetId?: string;
  agentForwarding: boolean;
  keepaliveIntervalS: number;
  autoReconnect: boolean;
  theme?: string;
  fontSize?: number;
}

export interface ResolveSshConfigInput {
  server: SshServer;
  groups: ReadonlyMap<string, SshGroup>;
  identities: ReadonlyMap<string, SshIdentity>;
}

/** The groups the server inherits from, nearest first. A cycle stops at the repeat. */
export function inheritanceChain(
  server: Pick<SshServer, "id" | "groupId">,
  groups: ReadonlyMap<string, SshGroup>,
): SshGroup[] {
  const chain: SshGroup[] = [];
  const seen = new Set<string>([server.id]);
  let currentId = server.groupId;
  while (currentId !== undefined && !seen.has(currentId)) {
    const group = groups.get(currentId);
    if (!group) break;
    chain.push(group);
    seen.add(group.id);
    currentId = group.parentId;
  }
  return chain;
}

export function isFieldSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

interface NearestHit<T> {
  value: T;
  ownerId: string;
}

/** Nearest node (the server itself first) that sets the field, with its id. */
export function pickNearestWithOwner<K extends InheritableKey>(
  server: Pick<SshServer, "id" | K>,
  chain: readonly Pick<SshGroup, "id" | K>[],
  field: K,
): NearestHit<NonNullable<InheritableFields[K]>> | undefined {
  const nodes: Pick<SshGroup, "id" | K>[] = [server as Pick<SshGroup, "id" | K>, ...chain];
  for (const node of nodes) {
    const value = node[field] as InheritableFields[K];
    if (isFieldSet(value)) {
      return { value: value as NonNullable<InheritableFields[K]>, ownerId: node.id };
    }
  }
  return undefined;
}

export function pickNearest<K extends InheritableKey>(
  server: Pick<SshServer, "id" | K>,
  chain: readonly Pick<SshGroup, "id" | K>[],
  field: K,
): NonNullable<InheritableFields[K]> | undefined {
  return pickNearestWithOwner(server, chain, field)?.value;
}

/** Copy only the fields that are set, so absent values stay absent (not `undefined`). */
function definedFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function resolveSshConfig(input: ResolveSshConfigInput): ResolvedSshConfig {
  const { server, groups, identities } = input;
  const chain = inheritanceChain(server, groups);
  const nearest = <K extends InheritableKey>(field: K) => pickNearest(server, chain, field);

  const identityId = nearest("identityId");
  const identity = identityId ? identities.get(identityId) : undefined;
  const protocol: SshProtocol = server.protocol ?? "ssh";
  const proxyHit = pickNearestWithOwner(server, chain, "proxy");
  const defaultPort = protocol === "telnet" ? DEFAULT_TELNET_PORT : DEFAULT_SSH_PORT;

  return {
    serverId: server.id,
    host: server.address,
    port: nearest("port") ?? defaultPort,
    protocol,
    ...definedFields({
      via: server.via === "tailnet" ? server.via : undefined,
      username: nearest("username") ?? (identity?.username || undefined),
      identityId,
      keyId: identity?.keyId,
      proxy: proxyHit?.value,
      proxyOwnerId: proxyHit?.ownerId,
      startupSnippetId: nearest("startupSnippetId"),
      theme: nearest("theme"),
      fontSize: nearest("fontSize"),
    }),
    authMethods: [...(nearest("authMethods") ?? DEFAULT_SSH_AUTH_METHODS)],
    jumpChain: [...(nearest("jumpChain") ?? [])],
    env: { ...nearest("env") },
    agentForwarding: nearest("agentForwarding") ?? false,
    keepaliveIntervalS: server.keepaliveIntervalS ?? nearestNumber(chain, "keepaliveIntervalS"),
    autoReconnect: nearest("autoReconnect") ?? true,
  };
}

// keepaliveIntervalS = 0 is a real value ("off"), so it uses `undefined` as unset.
function nearestNumber(chain: readonly SshGroup[], field: "keepaliveIntervalS"): number {
  for (const group of chain) {
    if (group[field] !== undefined) return group[field];
  }
  return DEFAULT_KEEPALIVE_INTERVAL_S;
}

/** Env names allowed by OpenSSH SendEnv rules: a portable shell identifier. */
export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Detect a jump chain that would loop (the target in its own chain, a repeated
 * hop, or a hop that is unknown). Returns an error message or null.
 */
export function validateJumpChain(
  targetId: string,
  jumpChain: readonly string[],
  serverExists: (id: string) => boolean,
): string | null {
  const seen = new Set<string>([targetId]);
  for (const hopId of jumpChain) {
    if (seen.has(hopId)) return `Jump chain repeats server ${hopId}.`;
    if (!serverExists(hopId)) return `Jump host ${hopId} does not exist.`;
    seen.add(hopId);
  }
  return null;
}
