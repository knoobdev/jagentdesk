import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

/** rjb_<12 hex> (spec 33.6). */
export function newJobId(): string {
  return `rjb_${randomBytes(6).toString("hex")}`;
}

/** wsk_<12 hex of SHA-256(daemonId + "\0" + absolute workspacePath)> (spec 33.5). */
export function computeWorkspaceKey(daemonId: string, workspacePath: string): string {
  const digest = createHash("sha256")
    .update(`${daemonId}\0${path.resolve(workspacePath)}`)
    .digest("hex");
  return `wsk_${digest.slice(0, 12)}`;
}

/** snp_<12 hex of SHA-256 over the sorted (path, mode, hash) lines> (spec 33.4). */
export function computeSnapshotId(
  entries: readonly { path: string; mode: number; hash: string }[],
): string {
  const lines = entries
    .toSorted((a, b) => {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      return 0;
    })
    .map((entry) => `${entry.path}\0${entry.mode.toString(8)}\0${entry.hash}`);
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  return `snp_${digest.slice(0, 12)}`;
}
