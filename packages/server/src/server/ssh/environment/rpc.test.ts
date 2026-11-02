import { describe, expect, it } from "vitest";
import type { ServerEnvironment } from "@jagentdesk/protocol/ssh/environment-schemas";
import { handleSshEnvironmentMessage, type SshEnvironmentOutboundMessage } from "./rpc.js";
import { SshEnvironmentService } from "./service.js";
import type { EnvironmentStore } from "./store.js";

function memoryStore(initial: ServerEnvironment[]): EnvironmentStore {
  const map = new Map(initial.map((environment) => [environment.serverId, environment]));
  return {
    read: (serverId) => map.get(serverId) ?? null,
    write: (environment) => void map.set(environment.serverId, environment),
    remove: (serverId) => void map.delete(serverId),
  };
}

const CACHED: ServerEnvironment = {
  serverId: "srv_cached",
  detectedAtMs: 42,
  hostname: null,
  os: {
    kernelName: "Linux",
    kernelRelease: "6.8.0",
    arch: "x86_64",
    distroId: null,
    distroName: null,
    distroVersion: null,
    prettyName: null,
  },
  cpuCores: null,
  cpuModel: null,
  memoryTotalBytes: null,
  memoryAvailableBytes: null,
  rootDisk: null,
  uptimeSeconds: null,
  shell: null,
  docker: null,
  podman: null,
  systemctl: null,
  kubectl: null,
  psql: null,
  mysql: null,
  redisCli: null,
  nginx: null,
  packageManagers: [],
  systemd: null,
};

function service(): SshEnvironmentService {
  return new SshEnvironmentService({
    async acquire(serverId) {
      throw new Error(`connection to ${serverId} refused`);
    },
    store: memoryStore([CACHED]),
    isAutoDetectEnabled: () => true,
  });
}

interface TestMessage {
  type: string;
  [field: string]: unknown;
}

async function send(message: TestMessage): Promise<{
  handled: boolean;
  emitted: SshEnvironmentOutboundMessage[];
}> {
  const emitted: SshEnvironmentOutboundMessage[] = [];
  const handled = await handleSshEnvironmentMessage(service(), message, (out) => emitted.push(out));
  return { handled, emitted };
}

describe("handleSshEnvironmentMessage", () => {
  it("ignores messages of other namespaces", async () => {
    expect(await send({ type: "ssh.sftp.list.request" })).toEqual({ handled: false, emitted: [] });
  });

  it("answers from the cache without connecting", async () => {
    const { emitted } = await send({
      type: "ssh.environment.detect.request",
      requestId: "req_1",
      serverId: "srv_cached",
    });

    expect(emitted).toEqual([
      {
        type: "ssh.environment.detect.response",
        payload: {
          requestId: "req_1",
          serverId: "srv_cached",
          environment: CACHED,
          error: null,
          errorCode: null,
        },
      },
    ]);
  });

  it("reports a failed connection with its code when forced", async () => {
    const { emitted } = await send({
      type: "ssh.environment.detect.request",
      requestId: "req_2",
      serverId: "srv_cached",
      force: true,
    });

    expect(emitted).toEqual([
      {
        type: "ssh.environment.detect.response",
        payload: {
          requestId: "req_2",
          serverId: "srv_cached",
          environment: null,
          error: "connection to srv_cached refused",
          errorCode: "connect_failed",
        },
      },
    ]);
  });
});
