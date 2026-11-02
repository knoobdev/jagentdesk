import type { Client } from "ssh2";
import type { AcquireSshClient } from "../ssh-client-lease.js";

export class InstallKeyError extends Error {
  constructor(
    readonly code: "invalid_public_key" | "key_not_found" | "install_failed",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InstallKeyError";
  }
}

// An OpenSSH authorized_keys line: type, base64 blob, optional comment without line breaks.
const PUBLIC_KEY_LINE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)(?:-cert-v01@openssh\.com)? [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/;

export function assertPublicKeyLine(publicKey: string): string {
  const line = publicKey.trim();
  if (!PUBLIC_KEY_LINE.test(line)) {
    throw new InstallKeyError("invalid_public_key", "Not an OpenSSH public key line");
  }
  return line;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * POSIX sh script that adds the key once: ~/.ssh is 700, authorized_keys is 600, an existing
 * file without a trailing newline gets one first. Prints `present` or `added`.
 */
export interface InstallTarget {
  /** Directory relative to the remote home, or absolute; default ".ssh". */
  directory: string;
  /** Default "authorized_keys". */
  filename: string;
}

export const DEFAULT_INSTALL_TARGET: InstallTarget = {
  directory: ".ssh",
  filename: "authorized_keys",
};

/** Remote path as the response reports it, e.g. ".ssh/authorized_keys". */
export function installPath(target: InstallTarget): string {
  const directory = target.directory.replace(/^~\/?/, "").replace(/\/+$/, "") || ".";
  return `${directory}/${target.filename}`;
}

function assertTarget(target: InstallTarget): void {
  if (!target.filename || target.filename.includes("/") || target.filename.startsWith(".")) {
    throw new InstallKeyError(
      "install_failed",
      `Invalid authorized_keys file name ${target.filename}`,
    );
  }
}

export function installScript(
  publicKeyLine: string,
  target: InstallTarget = DEFAULT_INSTALL_TARGET,
): string {
  assertTarget(target);
  const key = shellQuote(publicKeyLine);
  const relative = target.directory.replace(/^~\/?/, "");
  const dir = relative.startsWith("/")
    ? shellQuote(relative)
    : `"$HOME"/${shellQuote(relative || ".")}`;
  return [
    "umask 077",
    `d=${dir}`,
    'mkdir -p "$d"',
    'chmod 700 "$d"',
    `f="$d"/${shellQuote(target.filename)}`,
    'touch "$f"',
    'chmod 600 "$f"',
    `if grep -qxF ${key} "$f"; then echo present; exit 0; fi`,
    'if [ -s "$f" ] && [ "$(tail -c 1 "$f" | od -An -c | tr -d " ")" != "\\n" ]; then echo >> "$f"; fi',
    `printf '%s\\n' ${key} >> "$f"`,
    "echo added",
  ].join("\n");
}

function run(
  client: Client,
  script: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(`sh -c ${shellQuote(script)}`, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      stream.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      stream.on("close", (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  });
}

export interface KeyInstallServiceOptions {
  acquire: AcquireSshClient;
  /** Public line of a keychain key (S1 keys.json), or null when the id is unknown. */
  getPublicKey(keyId: string): Promise<string | null>;
  /** Makes the server use this key next time (S1: identity / auth methods). */
  attachKey(serverId: string, keyId: string): Promise<void>;
}

// ssh.keys.install_to_server (spec 25.12, criterion 25.16.3). Only the public key leaves the
// daemon; it travels as an exec argument over the already-authenticated connection.
export class KeyInstallService {
  constructor(private readonly options: KeyInstallServiceOptions) {}

  async install(
    serverId: string,
    keyId: string,
    target: InstallTarget = DEFAULT_INSTALL_TARGET,
  ): Promise<{ outcome: "installed" | "already_present"; path: string }> {
    const publicKey = await this.options.getPublicKey(keyId);
    if (publicKey === null) throw new InstallKeyError("key_not_found", `Unknown key ${keyId}`);
    const line = assertPublicKeyLine(publicKey);
    const lease = await this.options.acquire(serverId);
    let outcome: { code: number; stdout: string; stderr: string };
    try {
      outcome = await run(lease.client, installScript(line, target));
    } finally {
      lease.release();
    }
    const status = outcome.stdout.trim().split("\n").at(-1);
    if (outcome.code !== 0 || (status !== "added" && status !== "present")) {
      throw new InstallKeyError(
        "install_failed",
        outcome.stderr.trim() || `authorized_keys update exited with ${outcome.code}`,
      );
    }
    await this.options.attachKey(serverId, keyId);
    return {
      outcome: status === "present" ? "already_present" : "installed",
      path: installPath(target),
    };
  }
}
