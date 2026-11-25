import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type { Logger } from "pino";
import * as binaryFrames from "@jagentdesk/protocol/binary-frames/index";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { FileSecretStore } from "../../database/secret-store.js";
import { DockerService } from "../../docker/docker-service.js";
import { DockerStreams } from "../../docker/docker-streams.js";
import { routeDockerMessage, disposeRemoteDocker } from "../../ssh/remote-docker/route.js";
import type { ClusterRegistry } from "../../cluster/cluster-registry.js";
import type { DatabaseRegistry } from "../../database/database-registry.js";

/** Daemon-wide registries shared with core consumers (SSH remote access, agent tools). */
export interface BuiltinSharedRegistries {
  clusters: ClusterRegistry;
  databases: DatabaseRegistry;
}

const secretStores = new WeakMap<DaemonConfigStore, FileSecretStore>();

/** Core owns persistence and transports; features own their lifecycle and registrations. */
export function createBuiltinCoreServices(
  home: string,
  logger: Logger,
  config: DaemonConfigStore,
  registries: BuiltinSharedRegistries,
) {
  let secrets = secretStores.get(config);
  if (!secrets) {
    secrets = new FileSecretStore(path.join(home, "builtin-plugins"));
    secretStores.set(config, secrets);
  }
  return {
    home,
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
  };
}
export type BuiltinCoreServices = ReturnType<typeof createBuiltinCoreServices>;
