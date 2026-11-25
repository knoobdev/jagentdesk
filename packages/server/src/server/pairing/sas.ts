import {
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { performance } from "node:perf_hooks";
import { PairHelloSchema, PairConfirmSchema } from "@jagentdesk/protocol/host-pairing";
import type { HostPairingLink } from "@jagentdesk/protocol/host-target";
import type { SessionOutboundMessage } from "@jagentdesk/protocol/messages";
import type { PairedDeviceStore } from "./paired-devices.js";

interface Socket {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}
export function ephemeralKey() {
  const keys = generateKeyPairSync("x25519");
  const jwk = keys.publicKey.export({ format: "jwk" });
  return { privateKey: keys.privateKey, publicKey: Buffer.from(jwk.x!, "base64url") };
}
export function sasCode(
  key: KeyObject,
  peer: string,
  nonceClient: string,
  nonceHost: string,
  pkClient: string,
  pkHost: string,
): string {
  const peerBytes = Buffer.from(peer, "base64url");
  const clientNonce = Buffer.from(nonceClient, "base64url");
  const hostNonce = Buffer.from(nonceHost, "base64url");
  if ([peerBytes, clientNonce, hostNonce].some((b) => b.length !== 32))
    throw new Error("pairing_bad_key");
  const publicKey = createPublicKey({
    format: "jwk",
    key: { kty: "OKP", crv: "X25519", x: peerBytes.toString("base64url") },
  });
  const shared = diffieHellman({ privateKey: key, publicKey });
  if (shared.every((b) => b === 0)) throw new Error("pairing_bad_key");
  const info = Buffer.concat([
    Buffer.from("jagentdesk-pair-v1"),
    Buffer.from(pkClient, "base64url"),
    Buffer.from(pkHost, "base64url"),
  ]);
  const okm = Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([clientNonce, hostNonce]), info, 32),
  );
  const code = String(okm.readUInt32BE(0) % 1_000_000).padStart(6, "0");
  shared.fill(0);
  okm.fill(0);
  return code;
}
interface Attempt {
  pk: string;
  key?: KeyObject;
  nonce: string;
  deadline: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  socket?: Socket;
  clientConfirmed: boolean;
  hostConfirmed: boolean;
  tailnetNodeId?: string;
  hello?: ReturnType<typeof PairHelloSchema.parse>;
}
/** A single two-sided exchange. No trust record exists before both approvals. */
export class SasPairing {
  private attempt?: Attempt;
  private openings: number[] = [];
  constructor(
    private readonly devices: PairedDeviceStore,
    private readonly changed: (message: SessionOutboundMessage) => void,
  ) {}
  begin(address: Omit<HostPairingLink, "v" | "pk">) {
    const now = performance.now();
    this.openings = this.openings.filter((t) => now - t < 600000);
    if (this.openings.length >= 5)
      throw new Error("Too many pairing attempts. Try again in ten minutes.");
    this.openings.push(now);
    this.cancel();
    const key = ephemeralKey();
    const pk = key.publicKey.toString("base64url");
    const expiresAt = Date.now() + 120000;
    const timer = setTimeout(() => this.cancel(), 120000);
    timer.unref();
    this.attempt = {
      pk,
      key: key.privateKey,
      nonce: randomBytes(32).toString("base64url"),
      deadline: now + 120000,
      expiresAt,
      timer,
      clientConfirmed: false,
      hostConfirmed: false,
    };
    return {
      pk,
      expiresAt,
      link: `jagentdesk://pair#${Buffer.from(JSON.stringify({ v: 1, ...address, pk })).toString("base64url")}`,
    };
  }
  handle(socket: Socket, input: unknown, tailnetNodeId?: string, transport?: string): boolean {
    const hello = PairHelloSchema.safeParse(input);
    const confirm = PairConfirmSchema.safeParse(input);
    if (!hello.success && !confirm.success) return false;
    const attempt = this.attempt;
    try {
      if (!attempt || performance.now() >= attempt.deadline) throw new Error("pairing_expired");
      if (hello.success) {
        if (transport === "tailnet" && !tailnetNodeId) throw new Error("node_changed");
        if (hello.data.pk !== attempt.pk) throw new Error("pairing_expired");
        if (attempt.socket) throw new Error("pairing_in_use");
        if (Buffer.from(hello.data.publicKeyEd25519, "base64").length !== 32)
          throw new Error("pairing_bad_key");
        const code = sasCode(
          attempt.key!,
          hello.data.pk_client,
          hello.data.nonce_client,
          attempt.nonce,
          hello.data.pk_client,
          attempt.pk,
        );
        attempt.key = undefined;
        attempt.socket = socket;
        attempt.hello = hello.data;
        attempt.tailnetNodeId = tailnetNodeId;
        socket.send(
          JSON.stringify({ type: "pair_challenge", pk: attempt.pk, nonce_host: attempt.nonce }),
        );
        this.changed({
          type: "pairing.sas.changed",
          payload: {
            pk: attempt.pk,
            code,
            label: hello.data.label,
            kind: hello.data.kind,
            state: "comparing",
          },
        });
      } else if (confirm.success) {
        if (attempt.socket !== socket || confirm.data.pk !== attempt.pk)
          throw new Error("pairing_expired");
        if (!confirm.data.accepted) {
          this.cancel();
          return true;
        }
        attempt.clientConfirmed = true;
        this.complete();
      }
    } catch {
      socket.send(JSON.stringify({ type: "pair_error", code: "pairing_failed" }));
      socket.close(1008, "Pairing failed");
    }
    return true;
  }
  confirm(pk: string, accepted: boolean): void {
    const attempt = this.attempt;
    if (!attempt || attempt.pk !== pk || performance.now() >= attempt.deadline)
      throw new Error("pairing_expired");
    if (!accepted) {
      this.cancel();
      return;
    }
    if (!attempt.hello) throw new Error("pairing_expired");
    attempt.hostConfirmed = true;
    this.complete();
  }
  private complete(): void {
    const a = this.attempt;
    if (!a?.clientConfirmed || !a.hostConfirmed || !a.hello || !a.socket) return;
    const device = this.devices.register({
      devicePublicKeyB64: a.hello.publicKeyEd25519,
      deviceName: a.hello.label,
      kind: a.hello.kind,
      tailnetNodeId: a.tailnetNodeId,
    });
    a.socket.send(JSON.stringify({ type: "pair_done", deviceId: device.deviceId }));
    this.changed({ type: "pairing.sas.changed", payload: { pk: a.pk, state: "completed" } });
    clearTimeout(a.timer);
    this.attempt = undefined;
  }
  disconnected(socket: Socket): void {
    if (this.attempt?.socket === socket) this.cancel();
  }
  cancel(): void {
    const a = this.attempt;
    this.attempt = undefined;
    if (!a) return;
    clearTimeout(a.timer);
    a.key = undefined;
    a.socket?.close(1008, "Pairing cancelled");
    this.changed({ type: "pairing.sas.changed", payload: { pk: a.pk, state: "cancelled" } });
  }
}
