import {
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  PairHelloSchema,
  PairConfirmSchema,
  type PairError,
  type PairingEndReason,
} from "@jagentdesk/protocol/host-pairing";
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
/** Structured logger subset; pino satisfies it. Never pass keys, nonces, `pk`s or codes. */
export interface SasPairingLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}
const silentLogger: SasPairingLogger = { info() {}, warn() {} };
interface Attempt {
  /** Log correlation id. Public `pk`s stay out of the log. */
  id: string;
  pk: string;
  key?: KeyObject;
  nonce: string;
  deadline: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  socket?: Socket;
  log: SasPairingLogger;
  clientConfirmed: boolean;
  hostConfirmed: boolean;
  tailnetNodeId?: string;
  hello?: ReturnType<typeof PairHelloSchema.parse>;
}
const PAIRING_WINDOW_MS = 120000;
/** Enough to answer a phone holding a link from the last few panel openings. */
const RETIRED_LINKS_KEPT = 16;
class PairingRefusal extends Error {
  readonly reason: PairingEndReason;
  constructor(reason: PairingEndReason) {
    super(reason);
    this.name = "PairingRefusal";
    this.reason = reason;
  }
}
/** Spec 05 error code for a refusal; the reason carries the detail. */
function pairErrorCode(reason: PairingEndReason): string {
  if (reason === "in_use") return "pairing_in_use";
  if (reason === "bad_key") return "pairing_bad_key";
  if (reason === "node_changed") return "node_changed";
  return "pairing_expired";
}
function sendPairError(socket: Socket, reason: PairingEndReason): void {
  const payload: PairError = { type: "pair_error", code: pairErrorCode(reason), reason };
  // The encrypted relay socket sends asynchronously. Close after the error is
  // on the wire, or the close can overtake it and the device sees only a drop.
  let sent: unknown;
  try {
    sent = socket.send(JSON.stringify(payload));
  } catch {
    sent = undefined;
  }
  const close = () => socket.close(1008, "Pairing failed");
  if (sent && typeof (sent as Promise<void>).then === "function")
    (sent as Promise<void>).then(close, close);
  else close();
}
/** A single two-sided exchange. No trust record exists before both approvals. */
export class SasPairing {
  private attempt?: Attempt;
  private openings: number[] = [];
  /** `pk` -> why that link stopped working, newest last. */
  private retired = new Map<string, PairingEndReason>();
  constructor(
    private readonly devices: PairedDeviceStore,
    private readonly changed: (message: SessionOutboundMessage) => void,
    private readonly log: SasPairingLogger = silentLogger,
  ) {}
  begin(address: Omit<HostPairingLink, "v" | "pk">) {
    const now = performance.now();
    this.openings = this.openings.filter((t) => now - t < 600000);
    if (this.openings.length >= 5) {
      this.log.warn({ openings: this.openings.length }, "pairing_sas_begin_rate_limited");
      throw new Error("Too many pairing attempts. Try again in ten minutes.");
    }
    this.openings.push(now);
    const replaced = this.attempt?.id;
    this.end("replaced");
    const key = ephemeralKey();
    const pk = key.publicKey.toString("base64url");
    const expiresAt = Date.now() + PAIRING_WINDOW_MS;
    const timer = setTimeout(() => this.end("expired"), PAIRING_WINDOW_MS);
    timer.unref();
    const id = randomBytes(4).toString("hex");
    this.attempt = {
      id,
      pk,
      key: key.privateKey,
      nonce: randomBytes(32).toString("base64url"),
      deadline: now + PAIRING_WINDOW_MS,
      expiresAt,
      timer,
      log: this.log,
      clientConfirmed: false,
      hostConfirmed: false,
    };
    this.log.info(
      {
        attemptId: id,
        relay: address.relay !== undefined,
        tailnet: address.host !== "",
        ...(replaced ? { replacedAttemptId: replaced } : {}),
      },
      "pairing_sas_begin",
    );
    return {
      pk,
      expiresAt,
      link: `jagentdesk://pair#${Buffer.from(JSON.stringify({ v: 1, ...address, pk })).toString("base64url")}`,
    };
  }
  /**
   * Consumes `pair_hello` / `pair_confirm` from a socket that has not said hello.
   * Every refusal reaches the device as `pair_error` with a reason and is logged.
   */
  handle(
    socket: Socket,
    input: unknown,
    tailnetNodeId?: string,
    transport?: string,
    log: SasPairingLogger = this.log,
  ): boolean {
    const hello = PairHelloSchema.safeParse(input);
    const confirm = PairConfirmSchema.safeParse(input);
    if (!hello.success && !confirm.success) return false;
    const step = hello.success ? "hello" : "confirm";
    const attempt = this.attempt;
    try {
      const pk = hello.success ? hello.data.pk : confirm.data!.pk;
      if (!attempt || attempt.pk !== pk) throw new PairingRefusal(this.retiredReason(pk));
      if (performance.now() >= attempt.deadline) throw new PairingRefusal("expired");
      if (hello.success)
        this.acceptHello(attempt, socket, hello.data, tailnetNodeId, transport, log);
      else if (confirm.success) {
        if (attempt.socket !== socket) throw new PairingRefusal("in_use");
        attempt.log.info(
          { attemptId: attempt.id, side: "client", accepted: confirm.data.accepted },
          "pairing_sas_confirm",
        );
        if (!confirm.data.accepted) {
          this.end("client_cancelled");
          return true;
        }
        attempt.clientConfirmed = true;
        this.complete();
      }
    } catch (error) {
      const reason = error instanceof PairingRefusal ? error.reason : "bad_key";
      log.warn(
        {
          step,
          reason,
          transport,
          ...(attempt ? { attemptId: attempt.id } : {}),
          ...(error instanceof PairingRefusal ? {} : { err: String(error) }),
        },
        "pairing_sas_refused",
      );
      // A duplicate hello on the socket that owns the attempt must not tear it down.
      if (attempt?.socket === socket && reason === "in_use") return true;
      sendPairError(socket, reason);
    }
    return true;
  }
  private acceptHello(
    attempt: Attempt,
    socket: Socket,
    hello: ReturnType<typeof PairHelloSchema.parse>,
    tailnetNodeId: string | undefined,
    transport: string | undefined,
    log: SasPairingLogger,
  ): void {
    if (transport === "tailnet" && !tailnetNodeId) throw new PairingRefusal("node_changed");
    if (attempt.socket) throw new PairingRefusal("in_use");
    if (Buffer.from(hello.publicKeyEd25519, "base64").length !== 32)
      throw new PairingRefusal("bad_key");
    const code = sasCode(
      attempt.key!,
      hello.pk_client,
      hello.nonce_client,
      attempt.nonce,
      hello.pk_client,
      attempt.pk,
    );
    attempt.key = undefined;
    attempt.socket = socket;
    attempt.hello = hello;
    attempt.tailnetNodeId = tailnetNodeId;
    attempt.log = log;
    socket.send(
      JSON.stringify({ type: "pair_challenge", pk: attempt.pk, nonce_host: attempt.nonce }),
    );
    log.info(
      {
        attemptId: attempt.id,
        transport,
        kind: hello.kind,
        remainingMs: Math.max(0, Math.round(attempt.deadline - performance.now())),
      },
      "pairing_sas_hello_accepted",
    );
    this.changed({
      type: "pairing.sas.changed",
      payload: { pk: attempt.pk, code, label: hello.label, kind: hello.kind, state: "comparing" },
    });
  }
  confirm(pk: string, accepted: boolean): void {
    const attempt = this.attempt;
    if (!attempt || attempt.pk !== pk || performance.now() >= attempt.deadline) {
      this.log.warn(
        { side: "host", accepted, reason: attempt?.pk === pk ? "expired" : this.retiredReason(pk) },
        "pairing_sas_refused",
      );
      throw new Error("pairing_expired");
    }
    attempt.log.info({ attemptId: attempt.id, side: "host", accepted }, "pairing_sas_confirm");
    if (!accepted) {
      this.end("host_cancelled");
      return;
    }
    if (!attempt.hello) throw new Error("pairing_expired");
    attempt.hostConfirmed = true;
    this.complete();
  }
  private complete(): void {
    const a = this.attempt;
    if (!a?.clientConfirmed || !a.hostConfirmed || !a.hello || !a.socket) return;
    // Both sides approved this key just now. A device key is persistent, so a
    // phone that paired before (or whose earlier attempt completed only on this
    // side) comes back with the same key: renew its record instead of refusing.
    const { device, created } = this.devices.repair({
      devicePublicKeyB64: a.hello.publicKeyEd25519,
      deviceName: a.hello.label,
      kind: a.hello.kind,
      tailnetNodeId: a.tailnetNodeId,
    });
    const repaired = !created;
    a.socket.send(
      JSON.stringify({
        type: "pair_done",
        deviceId: device.deviceId,
        ...(repaired ? { repaired } : {}),
      }),
    );
    a.log.info({ attemptId: a.id, kind: a.hello.kind, repaired }, "pairing_sas_completed");
    this.changed({
      type: "pairing.sas.changed",
      payload: { pk: a.pk, state: "completed", ...(repaired ? { repaired } : {}) },
    });
    clearTimeout(a.timer);
    this.retire(a.pk, "completed");
    this.attempt = undefined;
  }
  /** The socket that joined the attempt closed before both approvals. */
  disconnected(socket: Socket, details?: { code?: number }): void {
    const a = this.attempt;
    if (!a || a.socket !== socket) return;
    a.log.warn(
      {
        attemptId: a.id,
        code: details?.code,
        clientConfirmed: a.clientConfirmed,
        hostConfirmed: a.hostConfirmed,
      },
      "pairing_sas_socket_closed",
    );
    this.end("connection_lost");
  }
  /** Ends the open attempt (host cancel, daemon shutdown). */
  cancel(reason: PairingEndReason = "host_cancelled"): void {
    this.end(reason);
  }
  private end(reason: PairingEndReason): void {
    const a = this.attempt;
    this.attempt = undefined;
    if (!a) return;
    clearTimeout(a.timer);
    a.key = undefined;
    this.retire(a.pk, reason);
    a.log.info(
      { attemptId: a.id, reason, joined: a.socket !== undefined },
      "pairing_sas_cancelled",
    );
    // Tell the device why before the socket goes: relays replace the daemon's
    // close code, so the close alone reads as a dropped connection.
    if (a.socket && reason !== "connection_lost") sendPairError(a.socket, reason);
    this.changed({
      type: "pairing.sas.changed",
      payload: { pk: a.pk, state: "cancelled", reason },
    });
  }
  private retire(pk: string, reason: PairingEndReason): void {
    this.retired.delete(pk);
    this.retired.set(pk, reason);
    while (this.retired.size > RETIRED_LINKS_KEPT)
      this.retired.delete(this.retired.keys().next().value!);
  }
  private retiredReason(pk: string): PairingEndReason {
    return this.retired.get(pk) ?? "unknown_link";
  }
}
