import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";

// Small SFTP reads/writes for the server chat agent (spec 25.11). Full SFTP browsing and the
// transfer queue are milestone S2; these open one SFTP channel per call and close it after.

export type RemoteEntryType = "file" | "directory" | "symlink" | "other";

export interface RemoteDirEntry {
  name: string;
  type: RemoteEntryType;
  sizeBytes: number;
  modifiedAtMs: number;
  mode: string; // permission bits in octal, e.g. "755"
}

export interface RemoteDirListing {
  path: string;
  entries: RemoteDirEntry[];
  truncated: boolean;
}

export interface RemoteFileRead {
  path: string;
  sizeBytes: number;
  /** null when the file holds NUL bytes (binary); the agent gets the size only. */
  content: string | null;
  truncated: boolean;
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

async function withSftp<T>(client: Client, run: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const sftp = await openSftp(client);
  try {
    return await run(sftp);
  } finally {
    sftp.end();
  }
}

function stat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) reject(error);
      else resolve(stats);
    });
  });
}

function open(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, "r", (error, handle) => {
      if (error) reject(error);
      else resolve(handle);
    });
  });
}

function close(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function readChunk(
  sftp: SFTPWrapper,
  handle: Buffer,
  target: Buffer,
  offset: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.read(handle, target, offset, target.length - offset, offset, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(bytesRead);
    });
  });
}

async function readPrefix(sftp: SFTPWrapper, remotePath: string, length: number): Promise<Buffer> {
  const handle = await open(sftp, remotePath);
  try {
    const target = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const bytesRead = await readChunk(sftp, handle, target, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return target.subarray(0, filled);
  } finally {
    await close(sftp, handle);
  }
}

export async function readRemoteFile(
  client: Client,
  input: { path: string; maxBytes: number },
): Promise<RemoteFileRead> {
  return withSftp(client, async (sftp) => {
    const stats = await stat(sftp, input.path);
    if (stats.isDirectory()) throw new Error(`${input.path} is a directory`);
    const bytes = await readPrefix(sftp, input.path, Math.min(stats.size, input.maxBytes));
    const isBinary = bytes.includes(0);
    return {
      path: input.path,
      sizeBytes: stats.size,
      content: isBinary ? null : bytes.toString("utf8"),
      truncated: stats.size > bytes.length,
    };
  });
}

export async function writeRemoteFile(
  client: Client,
  input: { path: string; content: string },
): Promise<void> {
  await withSftp(
    client,
    (sftp) =>
      new Promise<void>((resolve, reject) => {
        sftp.writeFile(input.path, input.content, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  );
}

function entryType(stats: Stats): RemoteEntryType {
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "file";
  return "other";
}

function toEntry(entry: FileEntryWithStats): RemoteDirEntry {
  return {
    name: entry.filename,
    type: entryType(entry.attrs),
    sizeBytes: entry.attrs.size,
    modifiedAtMs: entry.attrs.mtime * 1000,
    mode: (entry.attrs.mode & 0o7777).toString(8),
  };
}

function compareEntries(a: RemoteDirEntry, b: RemoteDirEntry): number {
  const aIsDir = a.type === "directory";
  const bIsDir = b.type === "directory";
  if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export async function listRemoteDir(
  client: Client,
  input: { path: string; maxEntries: number },
): Promise<RemoteDirListing> {
  const list = await withSftp(
    client,
    (sftp) =>
      new Promise<FileEntryWithStats[]>((resolve, reject) => {
        sftp.readdir(input.path, (error, entries) => {
          if (error) reject(error);
          else resolve(entries);
        });
      }),
  );
  const entries = list
    .filter((entry) => entry.filename !== "." && entry.filename !== "..")
    .map(toEntry)
    .sort(compareEntries);
  return {
    path: input.path,
    entries: entries.slice(0, input.maxEntries),
    truncated: entries.length > input.maxEntries,
  };
}
