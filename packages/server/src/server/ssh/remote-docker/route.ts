import type { DockerService } from "../../docker/docker-service.js";
import type { DockerStreams } from "../../docker/docker-streams.js";
import { RemoteDockerService, RemoteDockerStreams } from "./cockpit.js";
import type { RemoteDockerHosts } from "./hosts.js";

/** What a session's docker/* handlers call: the host's Docker today, a server's when routed. */
export interface DockerBackend {
  service: DockerService;
  streams: DockerStreams;
}

export interface RoutedDocker extends DockerBackend {
  /** null for the local Docker. */
  serverId: string | null;
  /**
   * Gives back the forwarded socket. Call when a one-shot request finished, or on the matching
   * docker/*unsubscribe for a subscription. A no-op for the local Docker.
   */
  release(): void;
}

// Remote backends are kept per session (keyed by the session's own local backend), so a
// session's `disposeRemoteDocker` stops only its own `docker events/logs/stats` children.
const remoteBySession = new WeakMap<DockerBackend, Map<string, DockerBackend>>();

function remoteBackend(local: DockerBackend, dockerHost: string): DockerBackend {
  let byHost = remoteBySession.get(local);
  if (!byHost) {
    byHost = new Map();
    remoteBySession.set(local, byHost);
  }
  const existing = byHost.get(dockerHost);
  if (existing) return existing;
  const service = new RemoteDockerService(dockerHost);
  const backend = { service, streams: new RemoteDockerStreams(service) };
  byHost.set(dockerHost, backend);
  return backend;
}

/**
 * Picks the Docker a docker/* request targets (its optional `serverId`, spec 25.10): absent →
 * `local`, exactly as before; present → that server's Docker over its forwarded socket, attached
 * for the caller until `release()`. Rejects with RemoteDockerError (connect_failed,
 * docker_not_found, docker_socket_denied, forwarding_refused) when the server cannot be reached.
 */
export async function routeDockerMessage(
  message: { serverId?: string },
  local: DockerBackend,
  remoteHosts: RemoteDockerHosts,
): Promise<RoutedDocker> {
  const serverId = message.serverId;
  if (serverId === undefined) return { ...local, serverId: null, release() {} };
  const attachment = await remoteHosts.attach(serverId);
  let released = false;
  return {
    ...remoteBackend(local, attachment.dockerHost),
    serverId,
    release() {
      if (released) return;
      released = true;
      remoteHosts.detach(serverId);
    },
  };
}

/** Call when the session closes, next to `local.streams.disposeAll()`. */
export function disposeRemoteDocker(local: DockerBackend): void {
  const byHost = remoteBySession.get(local);
  if (!byHost) return;
  for (const backend of byHost.values()) backend.streams.disposeAll();
  remoteBySession.delete(local);
}
