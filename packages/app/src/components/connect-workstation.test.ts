import { describe, expect, it, vi } from "vitest";

vi.mock("@/constants/build-profile", () => ({ isFdroidBuild: false }));
vi.mock("@/constants/platform", () => ({ isNative: true, getIsElectron: () => false }));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (component: unknown) => component,
}));

import { resolveConnectWorkstationOptions } from "./connect-workstation";

describe("resolveConnectWorkstationOptions", () => {
  it("offers a phone exactly Scan QR (primary), Paste pairing link, Sign in to Tailscale", () => {
    expect(resolveConnectWorkstationOptions({ canScanQr: true, canSignInTailscale: true })).toEqual(
      [
        { key: "scan-qr", primary: true },
        { key: "paste-pairing-link", primary: false },
        { key: "sign-in-tailscale", primary: false },
      ],
    );
  });

  it("drops Scan QR on the desktop and makes Paste pairing link primary", () => {
    expect(
      resolveConnectWorkstationOptions({ canScanQr: false, canSignInTailscale: true }),
    ).toEqual([
      { key: "paste-pairing-link", primary: true },
      { key: "sign-in-tailscale", primary: false },
    ]);
  });

  it("drops Tailscale sign-in in a plain browser", () => {
    expect(
      resolveConnectWorkstationOptions({ canScanQr: false, canSignInTailscale: false }),
    ).toEqual([{ key: "paste-pairing-link", primary: true }]);
  });
});
