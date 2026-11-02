import type { SFTPWrapper } from "ssh2";
import type { AcquireSshClient, SshClientLease } from "../ssh-client-lease.js";
import { SftpError } from "./file-system.js";
import { SftpFileSystem, toRemoteSftpError } from "./remote-file-system.js";

interface OpenChannel {
  lease: SshClientLease;
  sftp: SFTPWrapper;
  fs: SftpFileSystem;
}

interface PoolEntry {
  channel: Promise<OpenChannel>;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface SftpChannelHandle {
  fs: SftpFileSystem;
  release(): void;
}

// One SFTP channel per server, opened on the server's existing connection (spec 25.5: "mở riêng
// nếu chưa có phiên terminal" — S1 opens the connection if needed when we acquire a lease).
// The channel and the lease are given back after `idleMs` with no users.
export class SftpChannelPool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(
    private readonly acquire: AcquireSshClient,
    private readonly idleMs = 30_000,
  ) {}

  async open(serverId: string): Promise<SftpChannelHandle> {
    let entry = this.entries.get(serverId);
    if (!entry) {
      entry = { channel: this.connect(serverId), refs: 0, idleTimer: null };
      this.entries.set(serverId, entry);
      const created = entry;
      created.channel.catch(() => {
        if (this.entries.get(serverId) === created) this.entries.delete(serverId);
      });
    }
    entry.refs += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    const held = entry;
    let channel: OpenChannel;
    try {
      channel = await held.channel;
    } catch (error) {
      held.refs -= 1;
      throw error;
    }
    let released = false;
    return {
      fs: channel.fs,
      release: () => {
        if (released) return;
        released = true;
        held.refs -= 1;
        if (held.refs === 0 && this.entries.get(serverId) === held) {
          held.idleTimer = setTimeout(() => this.close(serverId, held), this.idleMs);
        }
      },
    };
  }

  private async connect(serverId: string): Promise<OpenChannel> {
    const lease = await this.acquire(serverId);
    let sftp: SFTPWrapper;
    try {
      sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        lease.client.sftp((error, wrapper) => {
          if (error) reject(error);
          else resolve(wrapper);
        });
      });
    } catch (error) {
      lease.release();
      const mapped = toRemoteSftpError(error);
      throw new SftpError(mapped.code, `SFTP is not available on this server: ${mapped.message}`, {
        cause: error,
      });
    }
    const channel: OpenChannel = { lease, sftp, fs: new SftpFileSystem(sftp) };
    const drop = () => {
      const entry = this.entries.get(serverId);
      if (entry)
        void entry.channel.then((open) => open === channel && this.forget(serverId, entry));
    };
    sftp.once("close", drop);
    lease.client.once("close", drop);
    return channel;
  }

  private forget(serverId: string, entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.entries.get(serverId) === entry) this.entries.delete(serverId);
    void entry.channel.then((open) => open.lease.release());
  }

  private close(serverId: string, entry: PoolEntry): void {
    this.forget(serverId, entry);
    void entry.channel.then((open) => open.sftp.end());
  }

  dispose(): void {
    for (const [serverId, entry] of Array.from(this.entries)) this.close(serverId, entry);
  }
}
