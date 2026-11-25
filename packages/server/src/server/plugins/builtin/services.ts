import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type { Logger } from "pino";
import * as binaryFrames from "@jagentdesk/protocol/binary-frames/index";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import type { AgentManagerEvent } from "../../agent/agent-manager.js";
import type { SessionOutboundMessage } from "../../messages.js";
import { FileSecretStore } from "../../database/secret-store.js";
import { DockerService } from "../../docker/docker-service.js";
import { DockerStreams } from "../../docker/docker-streams.js";
import { routeDockerMessage, disposeRemoteDocker } from "../../ssh/remote-docker/route.js";
import type { ClusterRegistry } from "../../cluster/cluster-registry.js";
import type { DatabaseRegistry } from "../../database/database-registry.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { SshService } from "../../ssh/ssh-service.js";
import type { CustomProviderService } from "../../custom-providers/types.js";

/** Daemon-wide registries shared with core consumers (SSH remote access, agent tools). */
export interface BuiltinSharedRegistries {
  clusters: ClusterRegistry;
  databases: DatabaseRegistry;
}

/** Agent facts a feature may read for its callers; permission cards stay in core. */
export interface BuiltinAgentAccess {
  labels(agentId: string): Record<string, string> | null;
  cwd(agentId: string): string | null;
  requestHostToolPermission: AgentManager["requestHostToolPermission"];
}
/**
 * Daemon-wide shared libraries. Bootstrap supplies them; a session receives the daemon's
 * instances. They stay in core because several features and core subsystems consume them.
 */
export interface BuiltinPlatformServices {
  /** SSH pool, storage and the S1–S8 modules (remote Docker, databases, clusters, forwarding). */
  ssh?: SshService;
  agents?: BuiltinAgentAccess;
  /** Closes connections that ride on the SSH pool (custom provider forwarders) before it stops. */
  beforeSshStop?: () => void | Promise<void>;
  /** Custom API providers: config, secrets and the materializers agent providers spawn with. */
  customProviders?: CustomProviderService;
  /** Closes the custom providers' SSH forwarders (daemon-wide). */
  closeCustomProviderForwards?: () => void;
  /** This daemon's server id. */
  daemonId?: string;
  /** Pushes to every trusted session; each session's emit gate still applies its scopes. */
  broadcastToTrustedSessions?: (message: SessionOutboundMessage) => void;
}

const secretStores = new WeakMap<DaemonConfigStore, FileSecretStore>();

/** Core owns persistence and transports; features own their lifecycle and registrations. */
/** Daemon-wide hooks only the bootstrap can supply; absent for per-session services in tests. */
export interface BuiltinDaemonHooks {
  /** Agent lifecycle events, as AgentManager.subscribe delivers them (no replay). */
  subscribeAgentEvents?: (callback: (event: AgentManagerEvent) => void) => () => void;
  /** Sends a session message to every connected client. */
  broadcast?: (message: SessionOutboundMessage) => void;
  /** Sends an OS notification to paired phones that are not connected. */
  pushNotification?: (notice: { title: string; body: string }) => void;
}

export function createBuiltinCoreServices(
  home: string,
  logger: Logger,
  config: DaemonConfigStore,
  registries: BuiltinSharedRegistries,
  platform: BuiltinPlatformServices = {},
  daemon: BuiltinDaemonHooks = {},
) {
  let secrets = secretStores.get(config);
  if (!secrets) {
    secrets = new FileSecretStore(path.join(home, "builtin-plugins"));
    secretStores.set(config, secrets);
  }
  return {
    /** The daemon home. Preserve a migrated feature's existing storage paths under it. */
    home,
    daemon,
    logger,
    config,
    secrets,
    clusters: registries.clusters,
    databases: registries.databases,
    sqlite: {
      open(relativePath: string): Database.Database {
        const directory = path.resolve(home, "builtin-plugins");
        const file = path.resolve(directory, relativePath);
        if (!file.startsWith(directory + path.sep))
          throw new Error("Database path must be inside built-in storage");
        mkdirSync(path.dirname(file), { recursive: true });
        return new Database(file);
      },
    },
    docker: {
      createService: () => new DockerService(),
      DockerStreams,
      route: routeDockerMessage,
      disposeRemote: disposeRemoteDocker,
    },
    binaryFrames,
    ...platform,
  };
}
export type BuiltinCoreServices = ReturnType<typeof createBuiltinCoreServices>;
