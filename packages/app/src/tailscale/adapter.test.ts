import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeTailscaleLoginAdapter, WebTailscaleLoginAdapter } from "./adapter";
import type { JAgentDeskTailscaleNativeModule } from "./adapter";
import type { TailscaleLoginAdapter } from "./adapter";
import type { TailscaleLoginResult, TailscaleLoginStatus } from "./types";

// expo-modules-core's source references the bare `__DEV__` global, which the
// root vitest config (no setup file) never defines. These tests construct
// NativeTailscaleLoginAdapter directly, so the real module is never needed —
// stub it out rather than force a __DEV__ shim here.
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: vi.fn(() => null),
}));

// Test-only simulated adapter. Production code has no simulated Tailscale
// success path — this in-memory double exists purely to exercise the contract.
class TestTailscaleLoginAdapter implements TailscaleLoginAdapter {
  platform = "ios" as const;
  isSupported = true;
  private connected = false;

  async getStatus(): Promise<TailscaleLoginStatus> {
    return { kind: this.connected ? "connected" : "needs-login" };
  }

  async startInteractiveLogin(): Promise<TailscaleLoginResult> {
    this.connected = true;
    return { ok: true };
  }

  async loginWithAuthKey(authKey: string): Promise<TailscaleLoginResult> {
    const key = authKey.trim();
    if (!key) {
      return { ok: false, error: "An auth key is required." };
    }
    this.connected = true;
    return { ok: true };
  }
}

function argsContainSecret(args: unknown[], secret: string): boolean {
  return args.some((arg) => typeof arg === "string" && arg.includes(secret));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebTailscaleLoginAdapter", () => {
  it("does not fake interactive login in a browser", async () => {
    const adapter = new WebTailscaleLoginAdapter();

    expect(adapter.platform).toBe("web");
    expect(adapter.isSupported).toBe(true);
    expect(await adapter.getStatus()).toEqual({ kind: "connected" });
    expect(await adapter.startInteractiveLogin()).toEqual({
      ok: false,
      error: "Interactive Tailscale login is unavailable in a browser.",
    });
    expect(await adapter.loginWithAuthKey("tskey-anything")).toEqual({
      ok: false,
      error: "Use the native mobile app or desktop app to join with an auth key.",
    });
  });
});

describe("TestTailscaleLoginAdapter (test-only double)", () => {
  it("reports needs-login initially and flips to connected on interactive login", async () => {
    const adapter = new TestTailscaleLoginAdapter();

    expect(adapter.platform).toBe("ios");
    expect(adapter.isSupported).toBe(true);
    expect(await adapter.getStatus()).toEqual({ kind: "needs-login" });

    expect(await adapter.startInteractiveLogin()).toEqual({ ok: true });
    expect(await adapter.getStatus()).toEqual({ kind: "connected" });
  });

  it("connects with a valid auth key and rejects empty or whitespace keys", async () => {
    const adapter = new TestTailscaleLoginAdapter();

    expect(await adapter.loginWithAuthKey("tskey-auth-abc123")).toEqual({ ok: true });
    expect(await adapter.getStatus()).toEqual({ kind: "connected" });

    const empty = new TestTailscaleLoginAdapter();
    expect(await empty.loginWithAuthKey("")).toEqual({
      ok: false,
      error: "An auth key is required.",
    });
    expect(await empty.loginWithAuthKey("   ")).toEqual({
      ok: false,
      error: "An auth key is required.",
    });
    expect(await empty.getStatus()).toEqual({ kind: "needs-login" });
  });

  it("never logs the auth key", async () => {
    const adapter = new TestTailscaleLoginAdapter();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = "tskey-auth-SECRET-abc123";

    await adapter.loginWithAuthKey(secret);

    for (const spy of [logSpy, warnSpy, errorSpy]) {
      expect(spy.mock.calls.some((args) => argsContainSecret(args, secret))).toBe(false);
    }
  });
});

describe("NativeTailscaleLoginAdapter without a native module", () => {
  it("reports isSupported false, unavailable status, and explicit login errors", async () => {
    const adapter = new NativeTailscaleLoginAdapter("ios", null);
    const unavailableError = "Tailscale is not available on this device.";

    expect(adapter.platform).toBe("ios");
    expect(adapter.isSupported).toBe(false);
    expect(await adapter.getStatus()).toEqual({ kind: "unavailable" });
    expect(await adapter.startInteractiveLogin()).toEqual({
      ok: false,
      error: unavailableError,
    });
    expect(await adapter.loginWithAuthKey("tskey-x")).toEqual({
      ok: false,
      error: unavailableError,
    });
  });

  it("explains that Android needs the Local fallback when the native module is absent", async () => {
    const adapter = new NativeTailscaleLoginAdapter("android", null);
    const unavailableError =
      "Tailscale support is not included in this Android build. Choose Local or use the iOS build.";

    expect(adapter.platform).toBe("android");
    expect(adapter.isSupported).toBe(false);
    expect(await adapter.startInteractiveLogin()).toEqual({
      ok: false,
      error: unavailableError,
    });
    expect(await adapter.loginWithAuthKey("tskey-x")).toEqual({
      ok: false,
      error: unavailableError,
    });
  });
});

describe("NativeTailscaleLoginAdapter with a fake native module", () => {
  function fakeModule(): JAgentDeskTailscaleNativeModule {
    return {
      getStatus: vi.fn(async (): Promise<"unknown" | "needs-login" | "connected"> => "connected"),
      startInteractiveLogin: vi.fn(async () => ({ ok: true })),
      loginWithAuthKey: vi.fn(async (authKey: string) => ({
        ok: authKey.length > 0,
        error: authKey.length > 0 ? undefined : "boom",
      })),
    };
  }

  it("reports isSupported true and maps every native status", async () => {
    const module = fakeModule();
    const adapter = new NativeTailscaleLoginAdapter("android", module);

    expect(adapter.platform).toBe("android");
    expect(adapter.isSupported).toBe(true);

    vi.mocked(module.getStatus).mockResolvedValueOnce("unknown");
    expect(await adapter.getStatus()).toEqual({ kind: "needs-login" });
    vi.mocked(module.getStatus).mockResolvedValueOnce("needs-login");
    expect(await adapter.getStatus()).toEqual({ kind: "needs-login" });
    vi.mocked(module.getStatus).mockResolvedValueOnce("connected");
    expect(await adapter.getStatus()).toEqual({ kind: "connected" });
  });

  it("fails closed to unavailable when the module getStatus rejects", async () => {
    const module = fakeModule();
    const adapter = new NativeTailscaleLoginAdapter("ios", module);

    vi.mocked(module.getStatus).mockRejectedValueOnce(new Error("module exploded"));

    expect(await adapter.getStatus()).toEqual({ kind: "unavailable" });
  });

  it("passes the trimmed auth key to the module and returns its result verbatim", async () => {
    const module = fakeModule();
    const adapter = new NativeTailscaleLoginAdapter("ios", module);

    const result = await adapter.loginWithAuthKey("  tskey-trimmed-1  ");

    expect(vi.mocked(module.loginWithAuthKey)).toHaveBeenCalledWith("tskey-trimmed-1");
    expect(result).toEqual({ ok: true });
  });

  it("returns the module startInteractiveLogin result verbatim", async () => {
    const module = fakeModule();
    const adapter = new NativeTailscaleLoginAdapter("ios", module);

    vi.mocked(module.startInteractiveLogin).mockResolvedValueOnce({
      ok: false,
      error: "user cancelled",
    });

    expect(await adapter.startInteractiveLogin()).toEqual({
      ok: false,
      error: "user cancelled",
    });
  });
});
