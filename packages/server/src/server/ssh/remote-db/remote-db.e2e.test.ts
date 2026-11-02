import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseRegistry } from "../../database/database-registry.js";
import { MemorySecretStore } from "../../database/secret-store.js";
import { execCommand } from "../../../utils/spawn.js";
import { createTestSshPool, type TestSshPool } from "../environment/test-sshd.js";
import { setSshdOption } from "../remote-docker/test-remote-docker.js";
import { handleSshRemoteDbMessage } from "./rpc.js";
import { localPortOfTarget, RemoteDbTunnels } from "./service.js";

// A PostgreSQL that only the server can reach: it shares the test sshd container's network
// namespace, so it listens on the server's 127.0.0.1:5432 and is not published on this machine.
const POSTGRES = "jad-envdocker-pg";

async function hostDocker(args: string[]): Promise<string> {
  return (await execCommand("docker", args, { timeout: 120_000 })).stdout.trim();
}

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ready = await hostDocker(["exec", POSTGRES, "pg_isready", "-h", "127.0.0.1"]).then(
      () => true,
      () => false,
    );
    if (ready) return;
    if (Date.now() > deadline) throw new Error("postgres did not start");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Opt-in: needs the Docker-enabled test sshd (jad-sshd-envdocker) and JAD_SSH_DOCKER_E2E=1.
describe.runIf(process.env.JAD_SSH_DOCKER_E2E === "1")("databases through an SSH server", () => {
  let pool: TestSshPool;
  let home: string;

  beforeAll(async () => {
    await hostDocker(["rm", "-f", POSTGRES]).catch(() => "");
    await hostDocker([
      "run",
      "-d",
      "--name",
      POSTGRES,
      "--network",
      "container:jad-sshd-envdocker",
      "-e",
      "POSTGRES_PASSWORD=jadtest",
      "postgres:16-alpine",
    ]);
    await waitForPostgres();
    // The image default refuses TCP forwarding.
    await setSshdOption("AllowTcpForwarding", "no");
    pool = createTestSshPool();
    home = mkdtempSync(path.join(tmpdir(), "jad-rdb-"));
  });

  afterAll(async () => {
    pool.close();
    await setSshdOption("AllowTcpForwarding", "no");
    await hostDocker(["rm", "-f", POSTGRES]);
    rmSync(home, { recursive: true, force: true });
  });

  it("answers forwarding_refused while sshd forbids TCP forwarding", async () => {
    const tunnels = new RemoteDbTunnels({ acquire: pool.acquire, jagentdeskHome: home });
    const emitted: unknown[] = [];
    const request = {
      type: "ssh.remote_db.prepare.request",
      requestId: "req_1",
      serverId: "srv_e2e",
      kind: "postgres",
      remoteHost: "127.0.0.1",
      remotePort: 5432,
    };

    await handleSshRemoteDbMessage(tunnels, request, (message) => emitted.push(message));

    expect(emitted).toEqual([
      {
        type: "ssh.remote_db.prepare.response",
        payload: expect.objectContaining({
          requestId: "req_1",
          localPort: null,
          connection: null,
          errorCode: "forwarding_refused",
        }),
      },
    ]);
    await setSshdOption("AllowTcpForwarding", "yes");
    pool.reconnect();
  });

  it("answers remote_unreachable when nothing listens on the server", async () => {
    const tunnels = new RemoteDbTunnels({ acquire: pool.acquire, jagentdeskHome: home });

    await expect(
      tunnels.prepare({
        serverId: "srv_e2e",
        kind: "postgres",
        remoteHost: "127.0.0.1",
        remotePort: 1,
      }),
    ).rejects.toMatchObject({ code: "remote_unreachable" });
    expect(tunnels.isOpen(1)).toBe(false);
  });

  it("gives the Databases feature a connection that reaches the server-only database", async () => {
    const tunnels = new RemoteDbTunnels({ acquire: pool.acquire, jagentdeskHome: home });
    const registry = new DatabaseRegistry({ secretStore: new MemorySecretStore() });

    const prepared = await tunnels.prepare({
      serverId: "srv_e2e",
      kind: "postgres",
      remoteHost: "127.0.0.1",
      remotePort: 5432,
    });
    const info = await registry.addConnection({
      engine: prepared.connection.engine,
      config: {
        ...prepared.connection.config,
        user: "postgres",
        password: "jadtest",
        database: "postgres",
      },
    });
    const connected = await registry.connect(info.id);
    const result = await registry.getClient(info.id)!.runQuery("select 40 + 2 as answer");
    await registry.disconnect(info.id);
    await tunnels.closeAll();

    expect(prepared.connection).toEqual({
      engine: "postgres",
      config: { host: "127.0.0.1", port: prepared.localPort },
    });
    expect(connected.state).toBe("connected");
    expect(connected.serverVersion).toMatch(/^PostgreSQL 16\./);
    expect(result.rows).toEqual([[42]]);
    expect(localPortOfTarget(connected.target)).toBe(prepared.localPort);
  });

  it("keeps one local port per target, closes when idle and reopens for a saved connection", async () => {
    const tunnels = new RemoteDbTunnels({
      acquire: pool.acquire,
      jagentdeskHome: home,
      idleTimeoutMs: 150,
    });
    const registry = new DatabaseRegistry({ secretStore: new MemorySecretStore() });
    const target = {
      serverId: "srv_e2e",
      kind: "postgres" as const,
      remoteHost: "127.0.0.1",
      remotePort: 5432,
    };

    const first = await tunnels.prepare(target);
    const info = await registry.addConnection({
      engine: "postgres",
      config: {
        ...first.connection.config,
        user: "postgres",
        password: "jadtest",
        database: "postgres",
      },
    });
    await registry.connect(info.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const openWhileConnected = tunnels.isOpen(first.localPort);
    await registry.disconnect(info.id);
    await waitFor(() => !tunnels.isOpen(first.localPort), 3_000);

    const restarted = new RemoteDbTunnels({ acquire: pool.acquire, jagentdeskHome: home });
    const isRemote = restarted.isRemotePort(first.localPort);
    await restarted.reopenForLocalPort(first.localPort);
    const reconnected = await registry.connect(info.id);
    const again = await restarted.prepare(target);
    await registry.disconnect(info.id);
    await restarted.closeAll();
    await tunnels.closeAll();

    expect(openWhileConnected).toBe(true);
    expect(isRemote).toBe(true);
    expect(reconnected.state).toBe("connected");
    expect(again.localPort).toBe(first.localPort);
    expect(statSync(path.join(home, "ssh", "remote-db.json")).mode & 0o777).toBe(0o600);
  });
});
