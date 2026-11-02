import { Client, type ConnectConfig } from "ssh2";
import type { AcquireSshClient, SshClientLease } from "../ssh-client-lease.js";

// Real-sshd fixture for the SSH S5/S6 integration tests. Start the server with
//   docker run -d --name jad-sshd-snippets -p 2237:2222 -e PASSWORD_ACCESS=true \
//     -e USER_NAME=jad -e USER_PASSWORD=jadtest lscr.io/linuxserver/openssh-server
// and run the tests with JAD_SSH_E2E=1 (JAD_SSH_E2E_PORT overrides 2237).

export const SSHD_E2E_ENABLED = process.env.JAD_SSH_E2E === "1";

export const SSHD_PASSWORD_CONFIG: ConnectConfig = {
  host: "127.0.0.1",
  port: Number(process.env.JAD_SSH_E2E_PORT ?? "2237"),
  username: "jad",
  password: "jadtest",
  readyTimeout: 15_000,
};

export function connectSshClient(config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect(config);
  });
}

export interface TestSshClients {
  acquire: AcquireSshClient;
  /** Number of leases handed out and not yet released. */
  outstanding(): number;
  closeAll(): void;
}

/**
 * Test-only `AcquireSshClient`: one ssh2 connection per server id, opened with
 * `new Client().connect(...)`, standing in for S1's connection manager.
 */
export function createTestSshClients(servers: Record<string, ConnectConfig>): TestSshClients {
  const clients = new Map<string, Promise<Client>>();
  let outstanding = 0;
  async function acquire(serverId: string): Promise<SshClientLease> {
    const config = servers[serverId];
    if (!config) throw new Error(`Unknown server ${serverId}`);
    let pending = clients.get(serverId);
    if (!pending) {
      pending = connectSshClient(config);
      clients.set(serverId, pending);
      pending.catch(() => clients.delete(serverId));
    }
    const client = await pending;
    outstanding += 1;
    let released = false;
    return {
      client,
      release() {
        if (released) return;
        released = true;
        outstanding -= 1;
      },
    };
  }
  return {
    acquire,
    outstanding: () => outstanding,
    closeAll() {
      for (const pending of clients.values()) {
        void pending.then((client) => client.end()).catch(() => undefined);
      }
      clients.clear();
    },
  };
}
