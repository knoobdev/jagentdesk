import type { Client } from "ssh2";
export interface SshClientLease {
  /** An authenticated ssh2 Client for the server (host key already verified by S1). */
  client: Client;
  /** Give the lease back; the connection may stay open for other users. */
  release(): void;
}
export type AcquireSshClient = (serverId: string) => Promise<SshClientLease>;
