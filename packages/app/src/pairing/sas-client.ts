import { createPairingEphemeral, derivePairingSas, pairingBase64Url } from "@jagentdesk/relay/e2ee";
import type { DaemonTransport } from "@jagentdesk/client/internal/daemon-client-transport";

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
  let comparing = false;
  let approved = false;
  const subscriptions: Array<() => void> = [];
  let cancel: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (message: string) => reject(new Error(message));
      cancel = () => fail("Pairing cancelled");
      input.signal.addEventListener("abort", cancel, { once: true });
      if (input.signal.aborted) {
        cancel();
        return;
      }
      subscriptions.push(
        transport.onOpen(() => {
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
          ).catch(() => fail("Unable to start pairing"));
        }),
      );
      subscriptions.push(transport.onClose(() => fail("Pairing closed or expired")));
      subscriptions.push(transport.onError(() => fail("Pairing connection failed")));
      subscriptions.push(
        transport.onMessage(async (data, binary) => {
          if (binary) {
            fail("Invalid pairing response");
            return;
          }
          try {
            const message = JSON.parse(String(data));
            if (message.type === "pair_challenge") {
              if (comparing || message.pk !== pk) throw new Error("Pairing key changed");
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
              await transport.send(
                JSON.stringify({ type: "pair_confirm", pk, accepted: approved }),
              );
              if (!approved) fail("Pairing cancelled");
            } else if (message.type === "pair_done") {
              if (!approved) throw new Error("Pairing completed without approval");
              resolve();
            } else if (message.type === "pair_error")
              fail("Pairing failed. Generate a new link on the host.");
            // The signed-hello nonce arrives first and is used only after enrollment.
          } catch (error) {
            fail(error instanceof Error ? error.message : "Pairing failed");
          }
        }),
      );
    });
  } finally {
    input.signal.removeEventListener("abort", cancel);
    key.secretKey.fill(0);
    for (const unsubscribe of subscriptions) unsubscribe();
    transport.close();
  }
}
