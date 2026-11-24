import { randomBytes, randomUUID } from "node:crypto";
import { createHostTransportFactory, type HostDial } from "@jagentdesk/client/node";
import { parseHostTarget } from "@jagentdesk/protocol/host-target";
import { ephemeralKey, sasCode } from "../pairing/sas.js";
import {
  generateDeviceKeyPair,
  exportDevicePublicKey,
  exportDeviceSecretKey,
} from "../pairing/device-signature-crypto.js";

export interface HostCredential {
  publicKey: string;
  secretKey: string;
}
export async function pairHost(connection: string, label: string, dial?: HostDial) {
  const target = parseHostTarget(connection);
  const device = generateDeviceKeyPair();
  const credential = {
    publicKey: exportDevicePublicKey(device.publicKey),
    secretKey: exportDeviceSecretKey(device.secretKey),
  };
  const key = ephemeralKey();
  const pkClient = key.publicKey.toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const socket = createHostTransportFactory(connection, undefined, dial)({ url: target.url });
  let challenge!: (value: string) => void;
  let challengeError!: (error: Error) => void;
  let complete!: () => void;
  let failure!: (error: Error) => void;
  let finished = false;
  const ready = new Promise<string>((resolve, reject) => {
    challenge = resolve;
    challengeError = reject;
  });
  const done = new Promise<void>((resolve, reject) => {
    complete = resolve;
    failure = reject;
  });
  void done.catch(() => {});
  const fail = () => {
    if (finished) return;
    const error = new Error("Host pairing failed or expired");
    challengeError(error);
    failure(error);
  };
  const send = (message: Record<string, unknown>) => {
    try {
      void Promise.resolve(socket.send(JSON.stringify(message))).catch(fail);
    } catch {
      fail();
    }
  };
  const timer = setTimeout(() => {
    fail();
    socket.close();
  }, 120000);
  timer.unref();
  socket.onOpen(() => {
    send({
      type: "pair_hello",
      pk: target.pairing.pk,
      pk_client: pkClient,
      nonce_client: nonce,
      publicKeyEd25519: credential.publicKey,
      kind: "daemon",
      label: label.slice(0, 64),
    });
  });
  socket.onError(fail);
  socket.onClose(fail);
  socket.onMessage((data, binary) => {
    if (binary) {
      fail();
      return;
    }
    try {
      const message = JSON.parse(String(data));
      if (message.type === "pair_challenge") {
        if (message.pk !== target.pairing.pk) throw new Error("Pairing key changed");
        challenge(
          sasCode(
            key.privateKey,
            target.pairing.pk,
            nonce,
            message.nonce_host,
            pkClient,
            target.pairing.pk,
          ),
        );
      } else if (message.type === "pair_done") {
        finished = true;
        clearTimeout(timer);
        complete();
      } else if (message.type === "pair_error") {
        fail();
        socket.close();
      }
    } catch {
      fail();
      socket.close();
    }
  });
  try {
    const code = await ready;
    return {
      transactionId: randomUUID(),
      code,
      expiresAt: Date.now() + 120000,
      credential,
      cancel() {
        clearTimeout(timer);
        fail();
        socket.close();
      },
      async confirm(accepted: boolean) {
        if (!accepted) {
          clearTimeout(timer);
          socket.close();
          throw new Error("Pairing cancelled");
        }
        send({ type: "pair_confirm", pk: target.pairing.pk, accepted: true });
        try {
          await done;
        } finally {
          clearTimeout(timer);
          socket.close();
        }
      },
    };
  } catch (error) {
    clearTimeout(timer);
    socket.close();
    throw error;
  }
}
