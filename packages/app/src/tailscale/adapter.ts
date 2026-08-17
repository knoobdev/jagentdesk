import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { isWeb } from "@/constants/platform";
import { getDesktopTailscaleStatus } from "@/desktop/daemon/desktop-daemon";
import type { DesktopTailscaleStatus } from "@/desktop/daemon/desktop-daemon";
import { getDesktopHost } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { TailscaleLoginResult, TailscaleLoginStatus } from "./types";

// ---------------------------------------------------------------------------
// Tailscale login adapter — the platform contract.
//
//   - startInteractiveLogin(): open the OS-level Tailscale login (the official
//     app or the OS VPN configuration) and resolve once the user finishes.
//   - loginWithAuthKey(authKey): pass the key to the native join path. The key
//     is a secret — never log it, never persist it, hold it in memory only for
//     the duration of the call and drop it.
//   - getStatus(): return the real tailnet state reported by the OS.
//
// Web/desktop assume Tailscale at the OS level and never show the gate. On
// native the adapter is a thin wrapper over the optional `JAgentDeskTailscale`
// native module; a build without the module reports `isSupported === false`
// and every call resolves to an explicit unavailable/error state. There is no
// simulated success path in production code — the fake only exists in tests.
// ---------------------------------------------------------------------------

export interface TailscaleLoginAdapter {
  platform: "web" | "desktop" | "ios" | "android";
  isSupported: boolean;
  getStatus(): Promise<TailscaleLoginStatus>;
  startInteractiveLogin(): Promise<TailscaleLoginResult>;
  prepareInteractiveLogin?(): TailscaleLoginResult;
  /** Returns the auth URL produced by the embedded tsnet node, if ready. */
  getInteractiveLoginUrl?(): string | null;
  loginWithAuthKey(authKey: string): Promise<TailscaleLoginResult>;
  getDeviceSigningMaterial?(): {
    devicePublicKeyB64: string;
    signNonce(nonce: string): string | Promise<string>;
  } | null;
  getProxyAddress?(target: string): string | null;
  getDevicePublicKeyB64?(): string | null;
  signNonce?(nonce: string): string;
}

const AUTH_KEY_REQUIRED_ERROR = "An auth key is required.";
const TAILSCALE_IOS_UNAVAILABLE_ERROR = "Tailscale is not available on this device.";
const TAILSCALE_ANDROID_UNAVAILABLE_ERROR =
  "Tailscale support is not included in this Android build. Choose Local or use the iOS build.";
const TAILSCALE_LOGIN_FAILED_ERROR = "Tailscale login failed.";

// Electron's public device key is learned from the same real IPC health
// response that gates the desktop connection. Keeping only the public key in
// the renderer lets the client build a tailnet config while the private key
// remains in the Electron main process.
let desktopDevicePublicKeyB64: string | null = null;
let desktopTailnetProxyAddress: string | null = null;
const DEFAULT_DESKTOP_TAILNET_PROXY_ADDRESS = "127.0.0.1:55750";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function mapDesktopTailscaleStatusToLoginStatus(
  result: Pick<DesktopTailscaleStatus, "connected" | "daemonStatus">,
): TailscaleLoginStatus {
  // A persisted Tailscale mode is restored before the managed daemon has
  // finished its cold start. Treat that short interval as connecting so the
  // desktop does not redirect to the login screen and make the user wait for
  // a second health probe.
  if (result.daemonStatus === "starting" || result.daemonStatus === "stopped") {
    return { kind: "connecting" };
  }
  return result.connected === true ? { kind: "connected" } : { kind: "needs-login" };
}

export class WebTailscaleLoginAdapter implements TailscaleLoginAdapter {
  platform = (getDesktopHost() ? "desktop" : "web") as "desktop" | "web";
  isSupported = true;

  // Electron uses the host's real Tailscale installation and daemon settings.
  // A normal browser cannot own a Tailscale node, so it remains OS-connected.
  async getStatus(): Promise<TailscaleLoginStatus> {
    if (this.platform === "desktop") {
      try {
        const result = await getDesktopTailscaleStatus();
        desktopDevicePublicKeyB64 = result.devicePublicKeyB64 ?? null;
        desktopTailnetProxyAddress = result.tailnetProxyAddress ?? null;
        return mapDesktopTailscaleStatusToLoginStatus(result);
      } catch {
        return { kind: "unavailable" };
      }
    }
    return { kind: "connected" };
  }

  async startInteractiveLogin(): Promise<TailscaleLoginResult> {
    if (this.platform === "desktop") {
      try {
        await invokeDesktopCommand("start_tailscale_login");
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error, TAILSCALE_LOGIN_FAILED_ERROR) };
      }
    }
    return { ok: false, error: "Interactive Tailscale login is unavailable in a browser." };
  }

  async loginWithAuthKey(authKey: string): Promise<TailscaleLoginResult> {
    const key = authKey.trim();
    if (!key) return { ok: false, error: AUTH_KEY_REQUIRED_ERROR };
    if (this.platform !== "desktop") {
      return {
        ok: false,
        error: "Use the native mobile app or desktop app to join with an auth key.",
      };
    }
    try {
      await invokeDesktopCommand("patch_desktop_settings", { tailscale: { authKey: key } });
      await invokeDesktopCommand("restart_desktop_daemon", {
        reason: "tailscale_login",
        enableTailscale: true,
        // The renderer owns the bounded readiness poll. Do not make the IPC
        // request wait for daemon bootstrap or a Tailscale browser flow.
        waitForReady: false,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error, TAILSCALE_LOGIN_FAILED_ERROR) };
    }
  }

  getDeviceSigningMaterial(): DeviceSigningMaterial | null {
    if (this.platform !== "desktop" || !desktopDevicePublicKeyB64) {
      return null;
    }
    return {
      devicePublicKeyB64: desktopDevicePublicKeyB64,
      // The private key stays in Electron's main process. The renderer only
      // asks the IPC handler to sign the one-use daemon challenge nonce.
      signNonce: (nonce) => invokeDesktopCommand<string>("desktop_tailscale_sign_nonce", { nonce }),
    };
  }

  getProxyAddress(_target: string): string | null {
    if (this.platform !== "desktop") return null;
    // The daemon publishes the actual port in its health response. Keep a
    // deterministic fallback for the first probe so the desktop never waits
    // on a MagicDNS name that only the embedded tsnet node can resolve.
    return desktopTailnetProxyAddress ?? DEFAULT_DESKTOP_TAILNET_PROXY_ADDRESS;
  }
}

export interface JAgentDeskTailscaleNativeModule {
  getStatus(): Promise<"unknown" | "connecting" | "needs-login" | "connected">;
  /** Starts the native login worker without waiting on tsnet initialization. */
  beginInteractiveLogin?: () => { ok: boolean; error?: string };
  prepareInteractiveLogin?: () => { ok: boolean; error?: string };
  getAuthURL?: () => string | null;
  startInteractiveLogin(): Promise<{ ok: boolean; error?: string }>;
  loginWithAuthKey(authKey: string): Promise<{ ok: boolean; error?: string }>;
  /** Returns the device key held by the native key store; never export the private key. */
  getDeviceSigningMaterial?: () => {
    devicePublicKeyB64: string;
    signNonce(nonce: string): string;
  } | null;
  getDevicePublicKeyB64?: () => string | null;
  signNonce?: (nonce: string) => string;
  getProxyAddress?: (target: string) => string | null;
}

export interface DeviceSigningMaterial {
  devicePublicKeyB64: string;
  signNonce(nonce: string): string | Promise<string>;
}

export class NativeTailscaleLoginAdapter implements TailscaleLoginAdapter {
  readonly platform: "ios" | "android";
  readonly isSupported: boolean;
  private readonly module: JAgentDeskTailscaleNativeModule | null;

  constructor(platform: "ios" | "android", module: JAgentDeskTailscaleNativeModule | null) {
    this.platform = platform;
    this.module = module;
    this.isSupported = module !== null;
  }

  async getStatus(): Promise<TailscaleLoginStatus> {
    if (!this.module) {
      return { kind: "unavailable" };
    }
    try {
      const status = await this.module.getStatus();
      switch (status) {
        case "connected":
          return { kind: "connected" };
        case "connecting":
          return { kind: "connecting" };
        // Fail closed: never report "unknown" after hydration. If the OS can't
        // tell us the device is connected, it must pass through the gate.
        case "unknown":
        case "needs-login":
          return { kind: "needs-login" };
      }
    } catch {
      return { kind: "unavailable" };
    }
  }

  async startInteractiveLogin(): Promise<TailscaleLoginResult> {
    if (!this.module) {
      return {
        ok: false,
        error:
          this.platform === "android"
            ? TAILSCALE_ANDROID_UNAVAILABLE_ERROR
            : TAILSCALE_IOS_UNAVAILABLE_ERROR,
      };
    }
    try {
      if (this.module.beginInteractiveLogin) {
        return this.module.beginInteractiveLogin();
      }
      return await this.module.startInteractiveLogin();
    } catch (error) {
      return { ok: false, error: errorMessage(error, TAILSCALE_LOGIN_FAILED_ERROR) };
    }
  }

  prepareInteractiveLogin(): TailscaleLoginResult {
    if (!this.module) {
      return {
        ok: false,
        error:
          this.platform === "android"
            ? TAILSCALE_ANDROID_UNAVAILABLE_ERROR
            : TAILSCALE_IOS_UNAVAILABLE_ERROR,
      };
    }
    try {
      return this.module.prepareInteractiveLogin?.() ?? { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error, TAILSCALE_LOGIN_FAILED_ERROR) };
    }
  }

  getInteractiveLoginUrl(): string | null {
    try {
      const authUrl = this.module?.getAuthURL?.() ?? null;
      const normalized = authUrl?.trim() ?? "";
      return normalized.length > 0 ? normalized : null;
    } catch {
      return null;
    }
  }

  async loginWithAuthKey(authKey: string): Promise<TailscaleLoginResult> {
    if (!this.module) {
      return {
        ok: false,
        error:
          this.platform === "android"
            ? TAILSCALE_ANDROID_UNAVAILABLE_ERROR
            : TAILSCALE_IOS_UNAVAILABLE_ERROR,
      };
    }
    const key = authKey.trim();
    if (!key) {
      return { ok: false, error: AUTH_KEY_REQUIRED_ERROR };
    }
    // The key is a secret: it is never logged, never written to storage, and
    // never retained after this call — it is passed straight to the native
    // join path and dropped.
    try {
      return await this.module.loginWithAuthKey(key);
    } catch (error) {
      return { ok: false, error: errorMessage(error, TAILSCALE_LOGIN_FAILED_ERROR) };
    }
  }

  getDeviceSigningMaterial(): DeviceSigningMaterial | null {
    const legacy = this.module?.getDeviceSigningMaterial?.();
    if (legacy) return legacy;
    const publicKey = this.module?.getDevicePublicKeyB64?.() ?? null;
    const signNonce = this.module?.signNonce;
    if (!publicKey || !signNonce) return null;
    return {
      devicePublicKeyB64: publicKey,
      signNonce: (nonce) => signNonce.call(this.module, nonce),
    };
  }

  getProxyAddress(target: string): string | null {
    try {
      return this.module?.getProxyAddress?.(target) ?? null;
    } catch {
      return null;
    }
  }
}

export function getTailscaleLoginAdapter(): TailscaleLoginAdapter {
  if (isWeb) {
    return new WebTailscaleLoginAdapter();
  }
  const platform = Platform.OS === "android" ? "android" : "ios";
  const module =
    requireOptionalNativeModule<JAgentDeskTailscaleNativeModule>("JAgentDeskTailscale");
  return new NativeTailscaleLoginAdapter(platform, module);
}
