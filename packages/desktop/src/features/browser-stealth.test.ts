import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { generateFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";

vi.mock("electron", () => ({
  app: {
    userAgentFallback:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) JAgentDesk/0.9.44 Chrome/146.0.7680.179 Electron/41.2.0 Safari/537.36",
    getPreferredSystemLanguages: () => ["en-US", "vi-VN"],
  },
}));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const {
  acceptLanguageList,
  applyStealthToWebContents,
  setActiveFingerprintProfile,
  alignProfileWithEngine,
  browserUserAgentFromElectron,
  hostUserAgentMetadata,
  navigationClientHintHeaders,
  identityRequestHeaders,
  currentIdentityRequestHeaders,
} = await import("./browser-stealth.js");

const profile = generateFingerprintProfile({
  id: "bfp_a1b2c3",
  name: "work",
  os: "windows",
  nowMs: 1_790_000_000_000,
});

describe("browser identity helpers", () => {
  it("drops the app and Electron tokens and reduces the Chrome version", () => {
    expect(
      browserUserAgentFromElectron(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) JAgentDesk/0.9.44 Chrome/146.0.7680.179 Electron/41.2.0 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    );
  });

  it("drops the development package name from the UA too", () => {
    expect(
      browserUserAgentFromElectron(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @jagentdesk/desktop/0.9.45 Chrome/146.0.7680.179 Electron/41.2.0 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    );
  });

  it("presents the engine's Chrome version in the UA and Client Hints", () => {
    const aligned = alignProfileWithEngine(profile, "146.0.7680.179");
    expect(aligned.userAgent).toContain("Chrome/146.0.0.0");
    expect(aligned.userAgent).toContain("Windows NT 10.0");
    const chrome = aligned.uaClientHints.fullVersionList.find(
      (entry) => entry.brand === "Google Chrome",
    );
    expect(chrome?.version).toBe("146.0.7680.179");
    expect(aligned.uaClientHints.brands.find((entry) => entry.brand === "Chromium")?.version).toBe(
      "146",
    );
    // The GREASE brand keeps its own version.
    expect(
      aligned.uaClientHints.brands.find((entry) => entry.brand === "Not=A?Brand")?.version,
    ).toBe("24");
  });

  it("passes the language list without q-values", () => {
    expect(acceptLanguageList("en-US,en;q=0.9")).toBe("en-US,en");
    expect(acceptLanguageList("vi-VN, vi;q=0.9, en;q=0.8")).toBe("vi-VN,vi,en");
  });

  it("builds the low-entropy Client Hints a real Chrome sends on navigations", () => {
    expect(navigationClientHintHeaders(hostUserAgentMetadata("146.0.7680.179", "14.1.0"))).toEqual({
      "Sec-CH-UA": '"Chromium";v="146", "Google Chrome";v="146", "Not=A?Brand";v="24"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": expect.stringMatching(/^"(macOS|Windows|Linux)"$/),
    });
  });
});

describe("identity headers for requests main makes for a tab (favicons)", () => {
  const ELECTRON_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) JAgentDesk/0.9.44 Chrome/146.0.7680.179 Electron/41.2.0 Safari/537.36";
  const plainUa = browserUserAgentFromElectron(ELECTRON_UA);

  it("sends the profile's UA, Accept-Language and Client Hints on a secure origin", () => {
    const headers = identityRequestHeaders("https://shop.test/favicon.ico", profile, plainUa);
    expect(headers["User-Agent"]).toBe(profile.userAgent);
    expect(headers["Accept-Language"]).toBe(profile.acceptLanguage);
    expect(headers["Sec-CH-UA-Platform"]).toBe('"Windows"');
    expect(headers["Sec-CH-UA-Mobile"]).toBe("?0");
    expect(headers["Sec-CH-UA"]).toContain('"Google Chrome"');
  });

  it("treats localhost as secure and plain http as not, like Chrome", () => {
    expect(
      identityRequestHeaders("http://127.0.0.1:6974/favicon.ico", profile, plainUa)["Sec-CH-UA"],
    ).toBeDefined();
    const insecure = identityRequestHeaders("http://shop.test/favicon.ico", profile, plainUa);
    expect(Object.keys(insecure).some((name) => name.startsWith("Sec-CH-"))).toBe(false);
    expect(insecure["User-Agent"]).toBe(profile.userAgent);
  });

  it("sends the plain Chrome UA without a profile, never the app's Electron UA", () => {
    const headers = identityRequestHeaders("https://shop.test/favicon.ico", null, plainUa);
    expect(headers["User-Agent"]).toBe(plainUa);
    expect(headers["Accept-Language"]).toBeUndefined();
    for (const value of Object.values(headers)) {
      expect(value).not.toMatch(/Electron|JAgentDesk/);
    }
  });

  it("follows the active profile, aligned with the engine", () => {
    setActiveFingerprintProfile({ ...profile, stealthEnabled: true });
    const headers = currentIdentityRequestHeaders("https://shop.test/favicon.ico");
    expect(headers["User-Agent"]).toContain("Windows NT 10.0");
    expect(headers["User-Agent"]).not.toMatch(/Electron|JAgentDesk|Macintosh/);
    expect(headers["Accept-Language"]).toBe(profile.acceptLanguage);
    setActiveFingerprintProfile(null);
    expect(currentIdentityRequestHeaders("https://shop.test/favicon.ico")["User-Agent"]).toBe(
      plainUa,
    );
  });
});

describe("alignProfileWithHost", () => {
  it("reports the real GPU when the profile's OS is the host's", async () => {
    const { alignProfileWithHost } = await import("./browser-stealth.js");
    const mac = generateFingerprintProfile({ id: "bfp_mac", os: "macos", nowMs: 1 });
    expect(alignProfileWithHost(mac, "darwin")).toMatchObject({
      webglVendor: "",
      webglRenderer: "",
    });
    const windows = generateFingerprintProfile({ id: "bfp_win", os: "windows", nowMs: 1 });
    expect(alignProfileWithHost(windows, "darwin").webglRenderer).toBe(windows.webglRenderer);
  });
});

/** Electron's debugger as the stealth code sees it, with commands that can be held. */
class FakeGuestDebugger extends EventEmitter {
  public readonly commands: string[] = [];
  public readonly held = new Set<string>();
  public readonly failing = new Map<string, string>();
  private attached = false;
  private closed = false;
  private pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  public isAttached(): boolean {
    return this.attached;
  }

  public attach(): void {
    this.attached = true;
  }

  public async sendCommand(method: string): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new Error("No target available");
    }
    this.commands.push(method);
    const failure = this.failing.get(method);
    if (failure) {
      throw new Error(failure);
    }
    if (this.held.has(method)) {
      await new Promise<void>((resolve, reject) => this.pending.push({ resolve, reject }));
    }
    return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "1" } : {};
  }

  /** What Electron does when the guest's target goes away. */
  public closeTarget(): void {
    this.closed = true;
    this.attached = false;
    this.rejectPending("target closed while handling command");
    this.emit("detach", {}, "target closed");
  }

  public rejectPending(message: string): void {
    const pending = this.pending;
    this.pending = [];
    for (const command of pending) command.reject(new Error(message));
  }

  /** Commands that waited for a renderer get their answer once one exists. */
  public answerPending(): void {
    const pending = this.pending;
    this.pending = [];
    for (const command of pending) command.resolve();
  }
}

class FakeGuestContents extends EventEmitter {
  public readonly id = 2;
  public readonly debugger = new FakeGuestDebugger();
  public readonly loads: string[] = [];
  public readonly webRtcPolicies: string[] = [];
  public crashed = false;
  /** No live renderer frame yet (a hidden tab): CDP commands wait until something navigates it. */
  public frameless = false;
  /** Errors the next loads fail with, without starting a renderer. */
  public readonly failingLoads: string[] = [];

  public isDestroyed(): boolean {
    return false;
  }

  public isCrashed(): boolean {
    return this.crashed;
  }

  public getURL(): string {
    return this.loads.at(-1) ?? "";
  }

  public async loadURL(url: string): Promise<void> {
    this.loads.push(url);
    const failure = this.failingLoads.shift();
    if (failure) {
      throw new Error(`${failure} loading '${url}'`);
    }
    if (this.frameless) {
      // A navigation gives the guest a live renderer; the commands waiting for it run.
      this.frameless = false;
      this.debugger.held.clear();
      this.debugger.answerPending();
    }
    if (this.crashed) {
      // A new renderer: commands sent to the dead one fail.
      this.crashed = false;
      this.debugger.held.clear();
      this.debugger.rejectPending("Target crashed");
    }
  }

  public setWebRTCIPHandlingPolicy(policy: string): void {
    this.webRtcPolicies.push(policy);
  }

  public exitRenderer(): void {
    this.crashed = true;
    this.emit("render-process-gone", {}, { reason: "killed", exitCode: 15 });
  }
}

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

function applyTo(guest: FakeGuestContents, options: { firstLoadHeld?: boolean } = {}) {
  setActiveFingerprintProfile(null);
  return applyStealthToWebContents(guest as unknown as Electron.WebContents, options);
}

describe("applyStealthToWebContents", () => {
  it("applies the identity before resolving", async () => {
    const guest = new FakeGuestContents();
    await expect(applyTo(guest)).resolves.toBe("applied");
    expect(guest.debugger.commands.slice(0, 2)).toEqual([
      "Network.enable",
      "Network.setUserAgentOverride",
    ]);
    expect(guest.debugger.commands).toContain("Target.setAutoAttach");
    expect(guest.webRtcPolicies).toEqual(["default"]);
    expect(guest.loads).toEqual([]);
  });

  // Spec 04 §27d.3: a tab that is not the focused tab of its pane sits under `display: none`;
  // its guest gets no renderer until something navigates it, and the held first URL waits for
  // the identity, so every CDP command waited forever and the tab stayed blank.
  it("starts a renderer for a held guest whose commands wait for one, then applies", async () => {
    const guest = new FakeGuestContents();
    guest.frameless = true;
    guest.debugger.held.add("Network.enable");
    const outcome = applyTo(guest, { firstLoadHeld: true });
    await nextMacrotask();
    await nextMacrotask();

    expect(guest.loads).toEqual(["about:blank"]);
    await expect(outcome).resolves.toBe("applied");
    expect(guest.debugger.commands).toContain("Target.setAutoAttach");
  });

  it("never navigates a guest whose first load is not held (a popup opening its page)", async () => {
    const guest = new FakeGuestContents();
    guest.debugger.held.add("Network.enable");
    const outcome = applyTo(guest);
    await nextMacrotask();
    await nextMacrotask();
    expect(guest.loads).toEqual([]);

    guest.debugger.held.clear();
    guest.debugger.answerPending();
    await expect(outcome).resolves.toBe("applied");
    expect(guest.loads).toEqual([]);
  });

  it("stops touching a guest whose target closes while a command is pending", async () => {
    const guest = new FakeGuestContents();
    guest.debugger.held.add("Network.enable");
    const outcome = applyTo(guest);
    await nextMacrotask();
    expect(guest.debugger.commands).toEqual(["Network.enable"]);

    guest.debugger.closeTarget();

    await expect(outcome).resolves.toBe("closed");
    expect(guest.debugger.commands).toEqual(["Network.enable"]);
    expect(guest.webRtcPolicies).toEqual([]);
    expect(guest.loads).toEqual([]);
  });

  it("starts a renderer for a held guest whose renderer exits mid-apply, then applies again", async () => {
    const guest = new FakeGuestContents();
    guest.debugger.held.add("Network.enable");
    const outcome = applyTo(guest);
    await nextMacrotask();

    guest.exitRenderer();
    await nextMacrotask();

    expect(guest.loads).toEqual(["about:blank"]);
    await expect(outcome).resolves.toBe("applied");
    // The interrupted attempt never reached the UA override; the retry sends everything.
    expect(guest.debugger.commands.slice(0, 3)).toEqual([
      "Network.enable",
      "Network.enable",
      "Network.setUserAgentOverride",
    ]);
  });

  // Seen live under CPU load: the blank page that restarts a killed renderer can fail while
  // Chromium is still tearing the dead one down; nothing then started a renderer again.
  it("tries again when the blank page that restarts the renderer fails", async () => {
    const guest = new FakeGuestContents();
    guest.debugger.held.add("Network.enable");
    const outcome = applyTo(guest);
    await nextMacrotask();

    guest.failingLoads.push("ERR_FAILED (-2)");
    guest.exitRenderer();
    await nextMacrotask();
    expect(guest.loads).toEqual(["about:blank"]);

    await expect(outcome).resolves.toBe("applied");
    expect(guest.loads).toEqual(["about:blank", "about:blank"]);
  });

  it("does not restart again when another navigation replaced the blank page", async () => {
    const guest = new FakeGuestContents();
    guest.debugger.held.add("Network.enable");
    const outcome = applyTo(guest);
    await nextMacrotask();

    guest.failingLoads.push("ERR_ABORTED (-3)");
    guest.exitRenderer();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(guest.loads).toEqual(["about:blank"]);

    guest.debugger.rejectPending("target closed while handling command");
    await expect(outcome).resolves.toBe("closed");
  });

  it("reports the identity unavailable when the renderer keeps exiting", async () => {
    const guest = new FakeGuestContents();
    guest.debugger.failing.set("Network.enable", "Target crashed");
    await expect(applyTo(guest)).resolves.toBe("unavailable");
    expect(guest.debugger.commands).toEqual(["Network.enable", "Network.enable", "Network.enable"]);
    expect(guest.webRtcPolicies).toEqual([]);
  });
});
