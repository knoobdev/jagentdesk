import type { DatabaseEngine } from "../../database/database-dto.js";
import type { DbConnectionConfig } from "../../database/db-client.js";

/** Engines this milestone produces connection params for (spec 25.10). */
export const REMOTE_DB_ENGINES = ["postgres", "mysql", "redis", "mongodb"] as const;
export type RemoteDbEngine = (typeof REMOTE_DB_ENGINES)[number];

/** Engines `DatabaseRegistry` can actually open today. `redis` params are built
 *  in the same shape, but the registry has no redis adapter yet. */
export type RegistryBackedEngine = Extract<DatabaseEngine, "postgres" | "mysql" | "mongodb">;

export function isRegistryBackedEngine(engine: RemoteDbEngine): engine is RegistryBackedEngine {
  return engine !== "redis";
}

/** Where the local end of the SSH forward binds — not "localhost", to avoid
 *  DNS/IPv6 resolution surprises in the engine drivers. */
export const FORWARD_LOCAL_HOST = "127.0.0.1";

/** Key under `DbConnectionConfig.options` carrying the tunnel descriptor, so it
 *  persists in databases.json and survives daemon restart. */
export const SSH_FORWARD_OPTION_KEY = "ssh";

/** The local forward the owner must keep open while the DB connection is live
 *  (spec 25.10: open on connect, close on disconnect). */
export interface SshDbForward {
  serverId: string;
  /** DB host as seen from the SSH server. */
  remoteHost: string;
  /** DB port as seen from the SSH server. */
  remotePort: number;
  /** Local port the forward listens on — the DB client connects here. */
  localPort: number;
}

export interface RemoteDbConnectionRequest {
  engine: RemoteDbEngine;
  /** S1 server id (srv_…); validated as non-empty only — S1 owns the registry. */
  serverId: string;
  /** Human server name, used by the derived displayName. */
  serverLabel?: string;
  remoteHost: string;
  remotePort: number;
  localPort: number;
  database?: string;
  user?: string;
  /** Overrides the derived displayName. */
  displayName?: string;
}

/**
 * Everything the Databases feature needs to create a through-the-server
 * connection: fields that drop straight into
 * `AddConnectionInput` (`engine`, `displayName`, `config`) plus the forward the
 * owner has to open. Never carries a secret — the password/DSN goes from the
 * caller's input straight to the SecretStore, as `addConnection` already does.
 */
export interface RemoteDbConnectionParams {
  engine: RemoteDbEngine;
  displayName: string;
  config: DbConnectionConfig;
  forward: SshDbForward;
}

/** Which field of a RemoteDbConnectionRequest was rejected, and why. */
export class InvalidRemoteDbRequestError extends Error {
  constructor(
    public readonly field: string,
    reason: string,
  ) {
    super(`invalid remote-db request: ${field} ${reason}`);
    this.name = "InvalidRemoteDbRequestError";
  }
}

/**
 * Build the connection params for a DB reachable only through an SSH server:
 * the client connects to the local forward (`127.0.0.1:localPort`), and the
 * tunnel coordinates ride in `config.options.ssh` for persistence and wiring.
 */
export function buildRemoteDbConnectionParams(
  request: RemoteDbConnectionRequest,
): RemoteDbConnectionParams {
  if (!REMOTE_DB_ENGINES.includes(request.engine)) {
    throw new InvalidRemoteDbRequestError(
      "engine",
      `must be one of ${REMOTE_DB_ENGINES.join(", ")}`,
    );
  }
  const serverId = requireNonBlank(request.serverId, "serverId");
  const remoteHost = requireHost(request.remoteHost);
  const remotePort = requirePort(request.remotePort, "remotePort");
  const localPort = requirePort(request.localPort, "localPort");
  const database = optionalText(request.database, "database");
  const user = optionalText(request.user, "user");
  const displayName =
    optionalText(request.displayName, "displayName") ??
    `${database ?? request.engine} via ${optionalText(request.serverLabel, "serverLabel") ?? serverId}`;

  const forward: SshDbForward = { serverId, remoteHost, remotePort, localPort };
  const config: DbConnectionConfig = {
    host: FORWARD_LOCAL_HOST,
    port: localPort,
    options: { [SSH_FORWARD_OPTION_KEY]: { ...forward } },
  };
  if (database !== undefined) config.database = database;
  if (user !== undefined) config.user = user;

  return { engine: request.engine, displayName, config, forward };
}

function requireNonBlank(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new InvalidRemoteDbRequestError(field, "must not be empty");
  return trimmed;
}

function requireHost(value: string): string {
  const host = requireNonBlank(value, "remoteHost");
  if (/\s/.test(host)) {
    throw new InvalidRemoteDbRequestError("remoteHost", "must not contain whitespace");
  }
  if (host.includes("://")) {
    throw new InvalidRemoteDbRequestError("remoteHost", "must be a bare host, not a URL");
  }
  return host;
}

function requirePort(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new InvalidRemoteDbRequestError(field, `must be an integer between 1 and 65535`);
  }
  return value;
}

function optionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonBlank(value, field);
}
