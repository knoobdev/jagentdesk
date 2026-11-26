import { beforeEach, describe, expect, it, vi } from "vitest";

const signing = vi.hoisted(() => ({
  devicePublicKeyB64: "desktop-device-key",
  signNonce: async (nonce: string) => `signed:${nonce}`,
}));
vi.mock("@/utils/relay-device-signing", () => ({ getRelayDeviceSigning: () => signing }));

import { directTcpClientConfig } from "./direct-tcp-client-config";
import {
  rememberDesktopSignedLocalHost,
  resetDesktopSignedLocalHostsForTests,
} from "./desktop-signed-local-hosts";

const storage = {
  getItem: async () => null,
  setItem: async () => {},
};
const connection = {
  id: "direct:localhost:6811",
  type: "directTcp" as const,
  endpoint: "localhost:6811",
};

describe("directTcpClientConfig", () => {
  beforeEach(() => resetDesktopSignedLocalHostsForTests());

  it("signs the Local hello to a daemon this desktop started", async () => {
    await rememberDesktopSignedLocalHost("srv_bundled", storage);

    expect(directTcpClientConfig({ serverId: "srv_bundled", connection })).toEqual({
      url: "ws://localhost:6811/ws?paired=1",
      expectChallenge: true,
      deviceSigning: signing,
    });
  });

  it("keeps the plain hello for a daemon the desktop did not start", () => {
    expect(
      directTcpClientConfig({ serverId: "srv_cli", connection: { ...connection, password: "pw" } }),
    ).toEqual({ url: "ws://localhost:6811/ws", password: "pw" });
  });

  it("keeps the plain hello while the server id is still unknown", () => {
    expect(directTcpClientConfig({ serverId: undefined, connection })).toEqual({
      url: "ws://localhost:6811/ws",
    });
  });
});
