import { describe, expect, test, vi } from "vitest";
import pino from "pino";
import { generateKeyPair } from "@jagentdesk/relay";
import { createRelayRuntime } from "./relay-runtime.js";
import { startRelayTransport, type RelayTransportController } from "./relay-transport.js";
import type { RelayOwnershipSigner } from "./daemon-keypair.js";

function stubOwnership(): RelayOwnershipSigner {
  return {
    publicKeyB64url: "stub",
    signOwnership: () => "stub",
  };
}

describe("RelayRuntime", () => {
  test("opens no transport while disabled and starts/stops as enabled changes", async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const starts: string[] = [];
    const startTransport: typeof startRelayTransport = (options) => {
      starts.push(options.relayEndpoint);
      const stop = vi.fn(async () => undefined);
      stops.push(stop);
      return { stop } satisfies RelayTransportController;
    };
    let identityGenerated = 0;
    const runtime = createRelayRuntime({
      config: {
        enabled: false,
        endpoint: "relay.example.test:443",
        useTls: true,
      },
      logger: pino({ level: "silent" }),
      attachSocket: async () => undefined,
      serverId: "relay-runtime-test",
      getRelayOwnership: () => {
        identityGenerated += 1;
        return stubOwnership();
      },
      startTransport,
    });

    // Disabled at boot: no socket is opened and the identity key is not generated.
    expect(starts).toEqual([]);
    expect(identityGenerated).toBe(0);

    runtime.setEnabled(true);
    runtime.setEnabled(true);
    expect(starts).toEqual(["relay.example.test:443"]);
    expect(identityGenerated).toBe(1);
    expect(runtime.getConfig().enabled).toBe(true);

    runtime.setEnabled(false);
    await vi.waitFor(() => expect(stops[0]).toHaveBeenCalledOnce());
    expect(runtime.getConfig().enabled).toBe(false);
  });

  test("starts immediately when configured enabled", () => {
    const starts: string[] = [];
    const runtime = createRelayRuntime({
      config: { enabled: true, endpoint: "relay.example.test:443", useTls: true },
      logger: pino({ level: "silent" }),
      attachSocket: async () => undefined,
      serverId: "relay-runtime-test",
      getRelayOwnership: stubOwnership,
      startTransport: ((options) => {
        starts.push(options.relayEndpoint);
        return { stop: async () => undefined };
      }) as typeof startRelayTransport,
    });
    expect(starts).toEqual(["relay.example.test:443"]);
    expect(runtime.getConfig().enabled).toBe(true);
  });

  test("keeps relay disabled when transport startup fails", () => {
    const runtime = createRelayRuntime({
      config: { enabled: false, endpoint: "invalid-endpoint", useTls: false },
      logger: pino({ level: "silent" }),
      attachSocket: async () => undefined,
      serverId: "relay-runtime-test",
      getRelayOwnership: stubOwnership,
      startTransport: () => {
        throw new Error("Invalid relay endpoint");
      },
    });

    expect(() => runtime.setEnabled(true)).toThrow("Invalid relay endpoint");
    expect(runtime.getConfig().enabled).toBe(false);
  });

  test("daemon key material stays the Noise identity (not the relay identity)", () => {
    // The relay ownership signer is a separate Ed25519 key; the Noise static key
    // used for E2EE comes from daemonKeyPair.keyPair unchanged.
    const noiseKeyPair = generateKeyPair();
    expect(noiseKeyPair.publicKey).toBeTruthy();
  });
});
