import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import {
  ServerEnvironmentSchema,
  type ServerEnvironment,
} from "@jagentdesk/protocol/ssh/environment-schemas";
import type { SshServer } from "@jagentdesk/protocol/ssh/rpc-schemas";
import { SshEnvironmentService } from "./environment/service.js";
import type { EnvironmentStore } from "./environment/store.js";
import { SshImporter, type SshImportSink } from "./logs-import/importer.js";
import { KeyInstallService } from "./logs-import/install-key.js";
import { SessionLogService } from "./logs-import/session-log.js";
import { RemoteDockerHosts } from "./remote-docker/hosts.js";
import { ForwardingService } from "./forwarding/service.js";
import { RemoteDbTunnels } from "./remote-db/service.js";
import { RemoteK8sClusters } from "./remote-k8s/service.js";
import { FileSecretStore } from "../database/secret-store.js";
import type { SshService, SshTerminalCreatedEvent } from "./ssh-service.js";
import type { SshStorage } from "./ssh-storage.js";

// Wires milestones S6 (logs, import, install key), S7 (environment, server-chat tools) and S8
// (Docker on the server) into S1's SshService: storage-backed adapters, connection and terminal
// hooks. The ssh-servers built-in owns the session RPC handlers and the server-chat agent tools.

/** spec 25.10: the detected environment lives on the server record in servers.json. */
function serversJsonEnvironmentStore(storage: SshStorage): EnvironmentStore {
  return {
    read(serverId) {
      const parsed = ServerEnvironmentSchema.safeParse(storage.getServer(serverId)?.environment);
      return parsed.success ? parsed.data : null;
    },
    write(environment: ServerEnvironment) {
      storage.patchServerExtras(environment.serverId, { environment });
    },
    remove(serverId) {
      storage.patchServerExtras(serverId, { environment: undefined });
    },
  };
}

async function ensureGroup(service: SshService, groupPath: readonly string[]): Promise<string> {
  let parentId: string | undefined;
  for (const label of groupPath) {
    const existing = service.storage
      .listGroups()
      .find((group) => group.label === label && group.parentId === parentId);
    const group = existing ?? (await service.saveGroup({ id: "", label, parentId }));
    parentId = group.id;
  }
  if (!parentId) throw new Error("A group path needs at least one label");
  return parentId;
}

function importSink(service: SshService): SshImportSink {
  const { storage } = service;
  return {
    async listServers() {
      return storage.listServers().map((server) => ({
        id: server.id,
        label: server.label,
        address: server.address,
        port: server.port,
        username: server.username,
      }));
    },
    ensureGroup: (groupPath) => ensureGroup(service, groupPath),
    async saveServer(input) {
      let identityId: string | undefined;
      if (input.keyId) {
        const identity = await service.saveIdentity({
          id: "",
          label: input.label,
          ...(input.username ? { username: input.username } : {}),
          keyId: input.keyId,
        });
        identityId = identity.id;
      }
      const server: SshServer = {
        id: "",
        label: input.label,
        address: input.address,
        tags: input.tags,
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.username ? { username: input.username } : {}),
        ...(input.groupId ? { groupId: input.groupId } : {}),
        ...(identityId ? { identityId, authMethods: ["key", "password"] } : {}),
        ...(input.jumpChain.length > 0 ? { jumpChain: input.jumpChain } : {}),
      };
      return (await service.saveServer(server)).id;
    },
    async listKnownHosts() {
      return storage.listKnownHosts();
    },
    async addKnownHost(entry) {
      storage.addKnownHost({ ...entry, addedAtMs: Date.now() });
    },
    async listKeys() {
      return storage
        .listKeys()
        .map((key) => ({ id: key.id, fingerprintSha256: key.fingerprintSha256 }));
    },
    async importKey(input) {
      return (await service.importKey(input)).id;
    },
  };
}

/** After install_to_server: the server authenticates with the key first (spec 25.16 #3). */
async function attachKey(service: SshService, serverId: string, keyId: string): Promise<void> {
  const server = service.storage.getServer(serverId);
  const key = service.storage.getKey(keyId);
  if (!server || !key) throw new Error(`Unknown server ${serverId} or key ${keyId}`);
  const resolved = service.resolveConfig(serverId);
  const identity = await service.saveIdentity({
    id: "",
    label: `${key.label} · ${server.label}`,
    ...(resolved?.username ? { username: resolved.username } : {}),
    keyId,
  });
  const methods = (server.authMethods ?? resolved?.authMethods ?? ["password"]).filter(
    (method) => method !== "key",
  );
  await service.saveServer({
    ...server,
    identityId: identity.id,
    authMethods: ["key", ...methods],
  });
}

export interface SshModulesOptions {
  sshService: SshService;
  jagentdeskHome: string;
  logger: Logger;
}

export class SshModules {
  readonly logs: SessionLogService;
  readonly importer: SshImporter;
  readonly keys: KeyInstallService;
  readonly environment: SshEnvironmentService;
  readonly docker: RemoteDockerHosts;
  readonly remoteDb: RemoteDbTunnels;
  readonly remoteK8s: RemoteK8sClusters;
  /** S3 port forwarding; its ssh.forward.* RPCs are wired by the S1 owner on this instance. */
  readonly forwarding: ForwardingService;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(options: SshModulesOptions) {
    const { sshService: service, jagentdeskHome } = options;
    const sshHome = path.join(jagentdeskHome, "ssh");
    this.logs = new SessionLogService({ sshHome, now: Date.now });
    this.importer = new SshImporter({ sink: importSink(service), userHome: os.homedir() });
    this.keys = new KeyInstallService({
      acquire: service.acquireClient,
      getPublicKey: async (keyId) => service.storage.getKey(keyId)?.publicKey ?? null,
      attachKey: (serverId, keyId) => attachKey(service, serverId, keyId),
    });
    this.environment = new SshEnvironmentService({
      acquire: service.acquireClient,
      store: serversJsonEnvironmentStore(service.storage),
      // Off for servers that only allow one session or are network gear (spec 25.10).
      isAutoDetectEnabled: (serverId) =>
        service.storage.getServer(serverId)?.detectEnvironment !== false,
    });
    this.docker = new RemoteDockerHosts({
      acquire: service.acquireClient,
      runDirectory: path.join(sshHome, "run"),
    });
    this.forwarding = new ForwardingService({ acquire: service.acquireClient, sshDir: sshHome });
    this.remoteDb = new RemoteDbTunnels({ acquire: service.acquireClient, jagentdeskHome });
    this.remoteK8s = new RemoteK8sClusters({
      acquire: service.acquireClient,
      // Its own store: S1's FileSecretStore under ssh/ would race on the same secrets.json.
      secrets: new FileSecretStore(path.join(sshHome, "k8s")),
      runDirectory: path.join(sshHome, "run"),
    });
    this.unsubscribe.push(
      service.subscribeConnections((event) => {
        if (event.kind === "disconnected") {
          void this.remoteDb.onServerDisconnected(event.serverId);
          void this.remoteK8s.onServerDisconnected(event.serverId);
          return;
        }
        this.environment.onConnected(event.serverId).catch((error: unknown) => {
          options.logger.warn(
            { err: error, serverId: event.serverId },
            "ssh environment detection failed",
          );
        });
      }),
      service.subscribeTerminalCreated((event) => {
        void this.recordTerminal(event.serverId, event.session);
      }),
    );
  }

  /** spec 25.8: when logging is on for the server, every output chunk of the tab is recorded. */
  private async recordTerminal(
    serverId: string,
    session: SshTerminalCreatedEvent["session"],
  ): Promise<void> {
    const recorder = await this.logs.startRecording(serverId);
    if (!recorder) return;
    const untap = session.tapOutput((data) => recorder.write(data));
    session.onExit(() => {
      untap();
      void recorder.close();
    });
  }

  /** Loads persisted state (forwarding rules); call once before serving. */
  async initialize(): Promise<void> {
    await this.forwarding.initialize();
  }

  async dispose(): Promise<void> {
    for (const stop of this.unsubscribe.splice(0)) stop();
    await this.docker.stopAll();
    await this.remoteDb.closeAll();
    await this.forwarding.dispose();
  }
}
