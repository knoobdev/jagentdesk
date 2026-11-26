import { createPairingEphemeral, derivePairingSas, pairingBase64Url } from "@jagentdesk/relay/e2ee";
import type { DaemonTransport } from "@jagentdesk/client/internal/daemon-client-transport";
import { PAIRING_END_REASONS, type PairingEndReason } from "@jagentdesk/protocol/host-pairing";

/** Why pairing failed on this device: a daemon reason, or what the device saw itself. */
export type PairingFailure =
  | PairingEndReason
  | "connection_failed"
  | "rejected"
  | "cancelled"
  | "invalid_response";

const PAIRING_FAILURE_MESSAGES: Record<PairingFailure, string> = {
  expired: "Pairing code expired. Generate a new code on the host and scan it within two minutes.",
  replaced:
    "The host made a newer pairing link, so this one no longer works. Scan the code the host shows now.",
  host_cancelled: "Pairing was cancelled on the host. Generate a new code and try again.",
  client_cancelled: "Pairing cancelled. No device was added.",
  in_use: "Another device is pairing with this link. Finish or cancel that pairing first.",
  connection_lost:
    "The connection to the host dropped before pairing finished. No device was added. Generate a new code on the host and try again.",
  unknown_link:
    "The host does not recognize this link. It may have restarted. Generate a new code on the host.",
  completed: "This link was already used to pair a device. Generate a new code on the host.",
  bad_key: "Pairing failed. Generate a new code and try again.",
  node_changed: "This device changed tailnet identity. Generate a new code and try again.",
  daemon_stopped: "JAgentDesk stopped on the host. Start it again and generate a new code.",
  connection_failed:
    "Could not reach the host. Check this device's network connection and try again.",
  rejected: "Pairing failed. Generate a new link on the host.",
  cancelled: "Pairing cancelled.",
  invalid_response:
    "The host sent an unexpected pairing response. Update JAgentDesk on both devices.",
};

export class PairingError extends Error {
  constructor(readonly failure: PairingFailure) {
    super(PAIRING_FAILURE_MESSAGES[failure]);
    this.name = "PairingError";
  }
}

const KNOWN_REASONS: ReadonlySet<string> = new Set(PAIRING_END_REASONS);

/** Maps a daemon `pair_error`; daemons before 0.10.2 send no reason. */
export function pairingFailureFromError(message: { reason?: unknown }): PairingFailure {
  return typeof message.reason === "string" && KNOWN_REASONS.has(message.reason)
    ? (message.reason as PairingEndReason)
    : "rejected";
}

/** Same cadence as the daemon client heartbeat; the daemon answers `ping` before hello. */
const PAIRING_KEEPALIVE_MS = 10_000;
/** Two missed pongs plus slack: the connection is gone (suspended app, lost network). */
const PAIRING_LIVENESS_TIMEOUT_MS = 25_000;

/** Keeps both approvals on the same socket; closing or aborting discards the exchange. */
export async function pairAppDevice(input: {
  transport: DaemonTransport;
  pk: string;
  publicKey: string;
  label: string;
  kind: "desktop" | "mobile";
  signal: AbortSignal;
  compare(code: string): Promise<boolean>;
}): Promise<void> {
  const { transport, pk } = input;
  const key = createPairingEphemeral();
  const nonce = pairingBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  let opened = false;
  let comparing = false;
  let approved = false;
  let lastHeardAt = Date.now();
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const subscriptions: Array<() => void> = [];
  let cancel: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (failure: PairingFailure) => reject(new PairingError(failure));
      cancel = () => fail("cancelled");
      input.signal.addEventListener("abort", cancel, { once: true });
      if (input.signal.aborted) {
        cancel();
        return;
      }
      subscriptions.push(
        transport.onOpen(() => {
          // One hello per exchange. A transport that reopens is a new socket the
          // daemon has never seen; the attempt it joined ended with the old one.
          if (opened) return;
          opened = true;
          lastHeardAt = Date.now();
          void Promise.resolve(
            transport.send(
              JSON.stringify({
                type: "pair_hello",
                pk,
                pk_client: key.publicKey,
                nonce_client: nonce,
                publicKeyEd25519: input.publicKey,
                label: input.label.slice(0, 64),
                kind: input.kind,
              }),
            ),
          ).catch(() => fail("connection_lost"));
          // Silent sockets are dropped by mobile networks and suspended apps
          // while the user compares codes; the ping keeps the path warm and the
          // pong proves it is still there.
          keepalive = setInterval(() => {
            if (Date.now() - lastHeardAt > PAIRING_LIVENESS_TIMEOUT_MS) {
              fail("connection_lost");
              return;
            }
            try {
              void Promise.resolve(transport.send(JSON.stringify({ type: "ping" }))).catch(() =>
                fail("connection_lost"),
              );
            } catch {
              fail("connection_lost");
            }
          }, PAIRING_KEEPALIVE_MS);
        }),
      );
      subscriptions.push(
        transport.onClose(() => fail(opened ? "connection_lost" : "connection_failed")),
      );
      subscriptions.push(
        transport.onError(() => fail(opened ? "connection_lost" : "connection_failed")),
      );
      subscriptions.push(
        transport.onMessage(async (data, binary) => {
          lastHeardAt = Date.now();
          if (binary) {
            fail("invalid_response");
            return;
          }
          try {
            const message = JSON.parse(String(data));
            if (message.type === "pair_challenge") {
              if (comparing || message.pk !== pk) {
                fail("invalid_response");
                return;
              }
              comparing = true;
              const code = derivePairingSas(
                key.secretKey,
                pk,
                nonce,
                message.nonce_host,
                key.publicKey,
                pk,
              );
              key.secretKey.fill(0);
              approved = await input.compare(code);
              if (input.signal.aborted) return;
              try {
                await transport.send(
                  JSON.stringify({ type: "pair_confirm", pk, accepted: approved }),
                );
              } catch {
                fail("connection_lost");
                return;
              }
              if (!approved) fail("client_cancelled");
            } else if (message.type === "pair_done") {
              if (!approved) {
                fail("invalid_response");
                return;
              }
              resolve();
            } else if (message.type === "pair_error") fail(pairingFailureFromError(message));
            // `pong` only refreshes liveness. The signed-hello nonce arrives first
            // and is used only after enrollment.
          } catch {
            fail("invalid_response");
          }
        }),
      );
    });
  } finally {
    if (keepalive) clearInterval(keepalive);
    input.signal.removeEventListener("abort", cancel);
    key.secretKey.fill(0);
    for (const unsubscribe of subscriptions) unsubscribe();
    transport.close();
  }
}
