/// <reference lib="dom" />
import type pino from "pino";
import { parseRelayChallenge } from "@jagentdesk/relay/ownership";
import { type RelayOwnershipSigner } from "./daemon-keypair.js";
import type { RelaySocketLike } from "./relay-transport.js";

/** Ownership preflight is mandatory on both control and data sockets. */
type GuardState = "awaiting-challenge" | "awaiting-auth-ok" | "authenticated" | "closed";

interface GuardListeners {
  message: Array<(...args: unknown[]) => void>;
  close: Array<(...args: unknown[]) => void>;
  error: Array<(...args: unknown[]) => void>;
}

function tryParseAuthFrame(raw: unknown): Record<string, unknown> | null {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString("utf8");
  } else if (ArrayBuffer.isView(raw)) {
    text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  } else {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createRelayOwnershipGuard(
  socket: RelaySocketLike,
  signer: RelayOwnershipSigner,
  logger: pino.Logger,
  serverId: string,
): RelaySocketLike {
  const relayLogger = logger.child({ module: "relay-ownership" });
  const listeners: GuardListeners = { message: [], close: [], error: [] };
  let state: GuardState = "awaiting-challenge";

  const emitMessage = (args: unknown[]) => {
    for (const listener of listeners.message.slice()) {
      listener(...args);
    }
  };

  const rejectPreflight = () => {
    state = "closed";
    socket.close(4401, "Relay ownership preflight failed");
  };

  socket.on("message", (...args: unknown[]) => {
    if (state === "authenticated") {
      emitMessage(args);
      return;
    }
    if (state === "closed") return;
    const frame = tryParseAuthFrame(args[0]);
    if (state === "awaiting-challenge") {
      const challenge = frame && parseRelayChallenge(JSON.stringify(frame));
      if (!challenge) {
        rejectPreflight();
        return;
      }
      try {
        state = "awaiting-auth-ok";
        socket.send(
          JSON.stringify({
            type: "relay_auth",
            publicKey: signer.publicKeyB64url,
            signature: signer.signOwnership(serverId, challenge.nonce),
          }),
        );
      } catch (error) {
        relayLogger.warn({ err: error }, "relay_ownership_answer_failed");
        rejectPreflight();
      }
      return;
    }
    if (frame?.type !== "relay_auth_ok") {
      rejectPreflight();
      return;
    }
    state = "authenticated";
    relayLogger.debug("relay_ownership_confirmed");
  });
  socket.on("close", (...args: unknown[]) => {
    state = "closed";
    for (const listener of listeners.close.slice()) {
      listener(...args);
    }
  });
  socket.on("error", (...args: unknown[]) => {
    for (const listener of listeners.error.slice()) {
      listener(...args);
    }
  });

  return {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    send: (data, callback) => {
      if (state !== "authenticated") throw new Error("Relay ownership is not authenticated");
      socket.send(data, callback);
    },
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
    on: (event, listener) => {
      listeners[event].push(listener);
    },
    once: (event, listener) => {
      const wrapped = (...args: unknown[]) => {
        const index = listeners[event].indexOf(wrapped);
        if (index >= 0) listeners[event].splice(index, 1);
        listener(...args);
      };
      listeners[event].push(wrapped);
    },
  };
}
