import ssh2 from "ssh2";
import type { ParsedKey } from "ssh2";
import type { Duplex } from "node:stream";

// ssh2 is CommonJS: Node ESM cannot bind its named exports, so read them off the default.
const { AgentProtocol, BaseAgent } = ssh2;

// Spec 25.3 step 7: agent forwarding uses the daemon's own in-memory agent holding
// only the key of the identity in use — never the system SSH_AUTH_SOCK. The same
// agent also serves the `agent` auth method. Keys are parsed (decrypted) in memory
// and never written anywhere.

type SignCallback = (err: Error | undefined, signature?: Buffer) => void;
type IdentitiesCallback = (err: Error | undefined, keys?: ParsedKey[]) => void;

function samePublicKey(a: ParsedKey, b: ParsedKey): boolean {
  return a.getPublicSSH().equals(b.getPublicSSH());
}

function hashForFlags(key: ParsedKey, hash: string | undefined): string | undefined {
  // RSA keys sign with SHA-2 when the server asks for rsa-sha2-256/512.
  if (key.type !== "ssh-rsa") return undefined;
  return hash;
}

export class DaemonSshAgent extends BaseAgent {
  constructor(private readonly keys: readonly ParsedKey[]) {
    super();
  }

  hasKeys(): boolean {
    return this.keys.length > 0;
  }

  override getIdentities(cb: IdentitiesCallback): void {
    cb(undefined, [...this.keys]);
  }

  override sign(
    pubKey: ParsedKey | Buffer | string,
    data: Buffer,
    options: { hash?: string } | SignCallback,
    cb?: SignCallback,
  ): void {
    const callback = (typeof options === "function" ? options : cb) as SignCallback;
    const hash = typeof options === "object" ? options.hash : undefined;
    const key = this.findKey(pubKey);
    if (!key) {
      callback(new Error("Key not held by the daemon agent."));
      return;
    }
    const signature = key.sign(data, hashForFlags(key, hash));
    if (signature instanceof Error) {
      callback(signature);
      return;
    }
    callback(undefined, signature);
  }

  /** Called by ssh2 for each `auth-agent@openssh.com` channel the server opens. */
  getStream(cb: (err: Error | undefined, stream?: Duplex) => void): void {
    const protocol = new AgentProtocol(false);
    protocol.on("identities", (req: unknown) => {
      protocol.getIdentitiesReply(req as never, [...this.keys]);
    });
    protocol.on(
      "sign",
      (req: unknown, pubKey: ParsedKey, data: Buffer, flags: { hash?: string }) => {
        const key = this.findKey(pubKey);
        if (!key) {
          protocol.failureReply(req as never);
          return;
        }
        const signature = key.sign(data, hashForFlags(key, flags?.hash));
        if (signature instanceof Error) {
          protocol.failureReply(req as never);
          return;
        }
        protocol.signReply(req as never, signature);
      },
    );
    cb(undefined, protocol as unknown as Duplex);
  }

  private findKey(pubKey: ParsedKey | Buffer | string): ParsedKey | undefined {
    if (typeof pubKey === "object" && "getPublicSSH" in pubKey) {
      return this.keys.find((key) => samePublicKey(key, pubKey));
    }
    const blob = Buffer.isBuffer(pubKey) ? pubKey : Buffer.from(pubKey);
    return this.keys.find((key) => key.getPublicSSH().equals(blob));
  }
}
