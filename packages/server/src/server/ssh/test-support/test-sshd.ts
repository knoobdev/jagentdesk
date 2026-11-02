import { Client } from "ssh2";
import type { AcquireSshClient, SshClientLease } from "../ssh-client-lease.js";

// The real sshd started by start-test-sshd.sh. Integration tests talk to it directly with ssh2,
// standing in for S1's connection layer behind the AcquireSshClient contract.
export const TEST_SSHD = {
  host: "127.0.0.1",
  port: Number(process.env.JAD_TEST_SSHD_PORT ?? 2231),
  username: "jad",
  password: "jadtest",
} as const;

export interface TestSshPool {
  acquire: AcquireSshClient;
  /** Number of leases currently held (acquired and not yet released). */
  heldLeases(): number;
  close(): void;
}

function connectClient(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect({
      host: TEST_SSHD.host,
      port: TEST_SSHD.port,
      username: TEST_SSHD.username,
      password: TEST_SSHD.password,
      readyTimeout: 15_000,
    });
  });
}

// One shared connection per serverId, like S1 keeps one connection for many users.
export function createTestSshPool(): TestSshPool {
  const clients = new Map<string, Promise<Client>>();
  let held = 0;
  async function acquire(serverId: string): Promise<SshClientLease> {
    let pending = clients.get(serverId);
    if (!pending) {
      pending = connectClient();
      clients.set(serverId, pending);
      const created = pending;
      void created.then((client) =>
        client.once("close", () => {
          if (clients.get(serverId) === created) clients.delete(serverId);
        }),
      );
    }
    const client = await pending;
    held += 1;
    let released = false;
    return {
      client,
      release() {
        if (released) return;
        released = true;
        held -= 1;
      },
    };
  }
  return {
    acquire,
    heldLeases: () => held,
    close() {
      for (const pending of clients.values()) void pending.then((client) => client.end());
      clients.clear();
    },
  };
}
