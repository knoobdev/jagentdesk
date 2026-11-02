import { createHash } from "node:crypto";
import type {
  SshImportIssue,
  SshImportKnownHostDraft,
} from "@jagentdesk/protocol/ssh/logs-import-schemas";

// ~/.ssh/known_hosts import (spec 25.9). Each plain host name becomes one entry;
// hashed names (|1|…) cannot be recovered and @cert-authority / @revoked lines have no
// JAgentDesk equivalent, so both are reported as skipped.

export type KnownHostDraftBase = Omit<SshImportKnownHostDraft, "status">;

export interface ParsedKnownHosts {
  knownHosts: KnownHostDraftBase[];
  issues: SshImportIssue[];
}

/** OpenSSH-style `SHA256:<base64 without padding>` of a key blob. */
export function fingerprintSha256(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** The key type string embedded at the start of an SSH public key blob. */
function blobKeyType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length === 0 || 4 + length > blob.length) return null;
  return blob.subarray(4, 4 + length).toString("latin1");
}

function parseHostPattern(pattern: string): { host: string; port: number } | null {
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(pattern);
  if (bracketed) return { host: bracketed[1]!, port: Number(bracketed[2]) };
  if (pattern === "" || /[*?!]/.test(pattern)) return null;
  return { host: pattern, port: 22 };
}

export function parseKnownHosts(text: string, file: string): ParsedKnownHosts {
  const knownHosts: KnownHostDraftBase[] = [];
  const issues: SshImportIssue[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.trim();
    const location = { file, line: index + 1 };
    if (raw === "" || raw.startsWith("#")) continue;
    const fields = raw.split(/\s+/);
    if (fields[0]!.startsWith("@")) {
      issues.push({
        location,
        severity: "skipped",
        code: "known_host_marker",
        message: `${fields[0]} entries are not imported`,
      });
      continue;
    }
    const [hostField, keyType, keyBase64] = fields;
    if (!hostField || !keyType || !keyBase64) {
      issues.push({
        location,
        severity: "error",
        code: "invalid_line",
        message: "Expected hosts, key type and key",
      });
      continue;
    }
    if (hostField.startsWith("|")) {
      issues.push({
        location,
        severity: "skipped",
        code: "hashed_host",
        message: "Hashed host names cannot be read back",
      });
      continue;
    }
    const blob = Buffer.from(keyBase64, "base64");
    if (blobKeyType(blob) !== keyType) {
      issues.push({
        location,
        severity: "error",
        code: "invalid_line",
        message: `Invalid ${keyType} key`,
      });
      continue;
    }
    const fingerprint = fingerprintSha256(blob);
    for (const pattern of hostField.split(",")) {
      const parsed = parseHostPattern(pattern);
      if (!parsed) continue;
      knownHosts.push({
        host: parsed.host,
        port: parsed.port,
        keyType,
        publicKey: keyBase64,
        fingerprintSha256: fingerprint,
        location,
      });
    }
  }
  return { knownHosts, issues };
}
