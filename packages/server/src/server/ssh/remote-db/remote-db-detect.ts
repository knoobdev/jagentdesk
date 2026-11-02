import { REMOTE_DB_ENGINES, type RemoteDbEngine } from "./remote-db-params.js";

/** Default listening port per tunneled engine (spec 25.10 "DB through the server"). */
export const DEFAULT_DB_PORTS: Record<RemoteDbEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
  mongodb: 27017,
};

/** The loopback a service listens on when the detection script saw it locally. */
const SERVER_LOOPBACK_HOST = "127.0.0.1";

export function defaultDbPort(engine: RemoteDbEngine): number {
  if (!REMOTE_DB_ENGINES.includes(engine)) {
    throw new Error(`unknown remote-db engine: ${String(engine)}`);
  }
  return DEFAULT_DB_PORTS[engine];
}

/** The engine that listens on `port` by default, or null when no engine claims it. */
export function engineForDefaultPort(port: number): RemoteDbEngine | null {
  for (const engine of REMOTE_DB_ENGINES) {
    if (DEFAULT_DB_PORTS[engine] === port) return engine;
  }
  return null;
}

/**
 * Structural view of S7's `ServerEnvironment` (spec 25.10) that DB suggestions
 * need: the TCP ports listening on the server, as seen from the server. S7 owns
 * the full type; this view is what suggestion consumes, so mapping the stored
 * environment into it is the only wiring the owner does here.
 */
export interface DbDetectionEnvironment {
  listeningPorts: readonly number[];
}

/** A DB endpoint to offer the user when creating a through-the-server connection. */
export interface DbEndpointSuggestion {
  engine: RemoteDbEngine;
  /** DB host as seen from the server — feeds RemoteDbConnectionRequest.remoteHost. */
  remoteHost: string;
  /** DB port as seen from the server — feeds RemoteDbConnectionRequest.remotePort. */
  remotePort: number;
}

/**
 * Suggest DB endpoints from a detected environment: one suggestion per engine
 * whose default port is listening. Non-default ports are not suggestions (the
 * user types those). Output order is fixed by REMOTE_DB_ENGINES, not input order.
 */
export function suggestDbEndpoints(environment: DbDetectionEnvironment): DbEndpointSuggestion[] {
  const listening = new Set(environment.listeningPorts);
  const suggestions: DbEndpointSuggestion[] = [];
  for (const engine of REMOTE_DB_ENGINES) {
    const port = DEFAULT_DB_PORTS[engine];
    if (listening.has(port)) {
      suggestions.push({ engine, remoteHost: SERVER_LOOPBACK_HOST, remotePort: port });
    }
  }
  return suggestions;
}
