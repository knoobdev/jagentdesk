import { Client } from "ssh2";
import type { AcquireSshClient } from "../ssh-client-lease.js";

// The real sshd the S7/S8 e2e tests run against (lscr.io/linuxserver/openssh-server published on
// host port 2236, with the host Docker socket bind-mounted at /var/run/docker.sock):
//   docker run -d --name jad-sshd-envdocker -p 2236:2222 \
//     -v /var/run/docker.sock:/var/run/docker.sock \
//     -e PASSWORD_ACCESS=true -e USER_NAME=jad -e USER_PASSWORD=jadtest -e SUDO_ACCESS=true \
//     lscr.io/linuxserver/openssh-server
export const TEST_SSHD = {
  host: "127.0.0.1",
  port: 2236,
  username: "jad",
  password: "jadtest",
} as const;

export function connectTestClient(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => {
      // sshd reloads in the e2e tests drop live connections; a dead pooled client is expected.
      client.on("error", () => {});
      resolve(client);
    });
    client.once("error", reject);
    // Host-key verification belongs to S1; the test container's key is throwaway.
    client.connect({ ...TEST_SSHD, readyTimeout: 20_000, hostVerifier: () => true });
  });
}

export interface TestSshPool {
  acquire: AcquireSshClient;
  /** Connections opened so far, newest last. */
  clients: Client[];
  /** Drops the cached connection so the next acquire logs in again (fresh group membership). */
  reconnect(): void;
  close(): void;
}

/** One shared connection per pool, the way S1 hands out leases on one server connection. */
export function createTestSshPool(): TestSshPool {
  const clients: Client[] = [];
  let current: Promise<Client> | null = null;
  return {
    clients,
    async acquire() {
      current ??= connectTestClient().then((client) => {
        clients.push(client);
        return client;
      });
      const client = await current;
      return { client, release() {} };
    },
    reconnect() {
      current = null;
    },
    close() {
      for (const client of clients) client.end();
    },
  };
}
