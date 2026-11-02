import { promises as fs } from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import { fingerprintSha256 } from "./known-hosts.js";

// ssh2 is CommonJS: Node ESM cannot bind its named exports, so read them off the default.
const { utils } = ssh2;

// Private key files in ~/.ssh (spec 25.9 "file khoá trong ~/.ssh/"). The daemon reads
// them itself; only public metadata goes to the app. Encrypted keys need a passphrase
// at apply time; their fingerprint comes from the matching `.pub` file when present.

const MAX_KEY_FILE_BYTES = 64 * 1024;
const NOT_KEY_FILES = new Set([
  "config",
  "known_hosts",
  "known_hosts.old",
  "authorized_keys",
  "authorized_keys2",
  "environment",
  "rc",
]);

export interface KeyFileCandidate {
  path: string;
  label: string;
  keyType: string;
  fingerprintSha256: string | null;
  encrypted: boolean;
}

export type KeyFileInspection =
  | { kind: "plain"; keyType: string; fingerprintSha256: string }
  | { kind: "encrypted" }
  | { kind: "not_a_key" };

const ENCRYPTED_PATTERN = /encrypted|passphrase/i;

/** Classifies a file's contents as an unencrypted private key, an encrypted one, or neither. */
export function inspectPrivateKey(data: Buffer, passphrase?: string): KeyFileInspection {
  const parsed = utils.parseKey(data, passphrase);
  if (parsed instanceof Error) {
    return ENCRYPTED_PATTERN.test(parsed.message) ? { kind: "encrypted" } : { kind: "not_a_key" };
  }
  if (!parsed.isPrivateKey()) return { kind: "not_a_key" };
  return {
    kind: "plain",
    keyType: parsed.type,
    fingerprintSha256: fingerprintSha256(parsed.getPublicSSH()),
  };
}

interface PublicKeyInfo {
  keyType: string;
  fingerprintSha256: string;
}

async function readPublicKey(privatePath: string): Promise<PublicKeyInfo | null> {
  let text: string;
  try {
    text = await fs.readFile(`${privatePath}.pub`, "utf8");
  } catch {
    return null;
  }
  const parsed = utils.parseKey(text.trim());
  if (parsed instanceof Error) return null;
  return { keyType: parsed.type, fingerprintSha256: fingerprintSha256(parsed.getPublicSSH()) };
}

export async function scanKeyFiles(sshDir: string): Promise<KeyFileCandidate[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(sshDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const candidates: KeyFileCandidate[] = [];
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith(".pub") && !name.startsWith(".") && !NOT_KEY_FILES.has(name))
    .sort();
  for (const name of names) {
    const filePath = path.join(sshDir, name);
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_KEY_FILE_BYTES) continue;
    const inspection = inspectPrivateKey(await fs.readFile(filePath));
    if (inspection.kind === "not_a_key") continue;
    if (inspection.kind === "plain") {
      candidates.push({
        path: filePath,
        label: name,
        keyType: inspection.keyType,
        fingerprintSha256: inspection.fingerprintSha256,
        encrypted: false,
      });
      continue;
    }
    const pub = await readPublicKey(filePath);
    candidates.push({
      path: filePath,
      label: name,
      keyType: pub?.keyType ?? "",
      fingerprintSha256: pub?.fingerprintSha256 ?? null,
      encrypted: true,
    });
  }
  return candidates;
}
