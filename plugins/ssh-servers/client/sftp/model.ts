import type {
  SftpConflictPolicy,
  SftpEndpoint,
  SshTransfer,
} from "@jagentdesk/protocol/ssh/sftp-schemas";

export function endpointKey(endpoint: SftpEndpoint): string {
  return endpoint.kind === "daemon" ? "daemon" : `server:${endpoint.serverId}`;
}

export function sameEndpoint(a: SftpEndpoint, b: SftpEndpoint): boolean {
  return endpointKey(a) === endpointKey(b);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** Daemon paths may be Windows paths; server paths are always POSIX. */
export function joinEndpointPath(dir: string, name: string): string {
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(separator) ? `${dir}${name}` : `${dir}${separator}${name}`;
}

export function isOctalMode(value: string): boolean {
  return /^[0-7]{3,4}$/.test(value);
}

export function octalMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/** Validates a file or folder name typed by the user; returns an error key or null. */
export function invalidNameReason(name: string): "empty" | "separator" | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return "empty";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "separator";
  return null;
}

export type TransferAction =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "cancel" }
  | { kind: "retry" }
  | { kind: "dismiss" }
  | { kind: "resolve"; policy: SftpConflictPolicy };

const RESOLVE_ACTIONS: TransferAction[] = [
  { kind: "resolve", policy: "replace" },
  { kind: "resolve", policy: "keep-both" },
  { kind: "resolve", policy: "skip" },
];

/** What the transfer row offers in each status (spec 25.5: pause, resume, retry, conflicts). */
export function transferActions(transfer: SshTransfer): TransferAction[] {
  switch (transfer.status) {
    case "queued":
    case "running":
      return [{ kind: "pause" }, { kind: "cancel" }];
    case "paused":
      return [{ kind: "resume" }, { kind: "cancel" }];
    case "conflict":
      return [...RESOLVE_ACTIONS, { kind: "cancel" }];
    case "failed":
    case "cancelled":
      return [{ kind: "retry" }, { kind: "dismiss" }];
    case "completed":
    case "skipped":
      return [{ kind: "dismiss" }];
  }
}

export function transferFraction(transfer: SshTransfer): number {
  if (transfer.bytesTotal === 0) return transfer.status === "completed" ? 1 : 0;
  return Math.min(1, transfer.bytesTransferred / transfer.bytesTotal);
}

export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

export interface TransferListState {
  status: "loading" | "ready" | "error";
  transfers: SshTransfer[];
  error: string | null;
}

/** Applies a pushed transfer to the list: newer `updatedAtMs` wins, order by creation. */
export function applyTransfer(list: SshTransfer[], transfer: SshTransfer): SshTransfer[] {
  const index = list.findIndex((item) => item.id === transfer.id);
  if (index === -1) {
    return [...list, transfer].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
  if (list[index].updatedAtMs > transfer.updatedAtMs) return list;
  const next = list.slice();
  next[index] = transfer;
  return next;
}

export function removeTransfer(list: SshTransfer[], transferId: string): SshTransfer[] {
  return list.filter((item) => item.id !== transferId);
}
