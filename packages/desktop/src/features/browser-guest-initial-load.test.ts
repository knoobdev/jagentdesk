import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { IdentityOutcome } from "./browser-stealth.js";
import { watchGuestTeardown } from "./guest-teardown.js";

vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { IDENTITY_LOAD_TIMEOUT_MS, loadHeldGuestUrlAfterIdentity } =
  await import("./browser-guest-initial-load.js");

const URL = "https://example.com/";

class FakeGuest extends EventEmitter {
  public readonly id = 7;
  public readonly debugger = new EventEmitter();
  public readonly loads: string[] = [];
  public destroyed = false;

  public constructor() {
    super();
    watchGuestTeardown(this);
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public async loadURL(url: string): Promise<void> {
    this.loads.push(url);
  }

  /** Electron's navigationHistory, fed by loadURL (every load adds an entry here). */
  public readonly navigationHistory = {
    length: () => this.loads.length,
    getEntryAtIndex: (index: number) => ({ url: this.loads[index] ?? "" }),
    removeEntryAtIndex: (index: number) => {
      if (index >= this.loads.length - 1) return false;
      this.loads.splice(index, 1);
      return true;
    },
  };

  public closeTarget(): void {
    this.debugger.emit("detach", {}, "target closed");
  }
}

function deferred(): {
  promise: Promise<IdentityOutcome>;
  resolve: (outcome: IdentityOutcome) => void;
} {
  let resolve: (outcome: IdentityOutcome) => void = () => undefined;
  const promise = new Promise<IdentityOutcome>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = async (ms = 0) => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

function hold(
  guest: FakeGuest,
  identity: Promise<IdentityOutcome>,
  options: { protectedIdentity?: boolean; timeoutMs?: number } = {},
): void {
  loadHeldGuestUrlAfterIdentity({
    contents: guest,
    initialUrl: URL,
    identity,
    identityProtected: () => options.protectedIdentity ?? true,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

describe("loadHeldGuestUrlAfterIdentity", () => {
  it("loads the held URL once the identity is applied", async () => {
    const guest = new FakeGuest();
    const identity = deferred();
    hold(guest, identity.promise);
    await settle();
    expect(guest.loads).toEqual([]);

    identity.resolve("applied");
    await settle();

    expect(guest.loads).toEqual([URL]);
  });

  it("never touches a guest whose target closed while the identity was pending", async () => {
    const guest = new FakeGuest();
    const identity = deferred();
    hold(guest, identity.promise);

    // The user's crash: the target closes, the apply settles in the same microtask
    // checkpoint, and isDestroyed() is still false.
    guest.closeTarget();
    identity.resolve("failed");
    await settle();

    expect(guest.isDestroyed()).toBe(false);
    expect(guest.loads).toEqual([]);
  });

  it("does not load a closed guest", async () => {
    const guest = new FakeGuest();
    hold(guest, Promise.resolve("closed"));
    await settle();
    expect(guest.loads).toEqual([]);
  });

  it("keeps the URL held when a protected identity could not be applied", async () => {
    const guest = new FakeGuest();
    hold(guest, Promise.resolve("unavailable"));
    await settle();
    expect(guest.loads).toEqual([]);
  });

  it("loads with the session identity when no profile is active", async () => {
    const guest = new FakeGuest();
    hold(guest, Promise.resolve("unavailable"), { protectedIdentity: false });
    await settle();
    expect(guest.loads).toEqual([URL]);
  });

  it("loads after the timeout without a profile, once", async () => {
    const guest = new FakeGuest();
    const identity = deferred();
    hold(guest, identity.promise, { protectedIdentity: false, timeoutMs: 5 });
    await settle(20);
    expect(guest.loads).toEqual([URL]);

    identity.resolve("applied");
    await settle();
    expect(guest.loads).toEqual([URL]);
  });

  it("holds past the timeout with a profile and loads when the identity lands", async () => {
    const guest = new FakeGuest();
    const identity = deferred();
    hold(guest, identity.promise, { timeoutMs: 5 });
    await settle(20);
    expect(guest.loads).toEqual([]);

    identity.resolve("applied");
    await settle();
    expect(guest.loads).toEqual([URL]);
  });

  it("marks the tab not responding at the timeout and clears it when the identity lands", async () => {
    const guest = new FakeGuest();
    const identity = deferred();
    const states: boolean[] = [];
    loadHeldGuestUrlAfterIdentity({
      contents: guest,
      initialUrl: URL,
      identity: identity.promise,
      identityProtected: () => true,
      setNotResponding: (notResponding) => states.push(notResponding),
      timeoutMs: 5,
    });
    await settle(20);
    expect(states).toEqual([true]);
    expect(guest.loads).toEqual([]);

    identity.resolve("applied");
    await settle();
    expect(states).toEqual([true, false]);
    expect(guest.loads).toEqual([URL]);
  });

  it("drops the blank page that started the guest's renderer from its history", async () => {
    const guest = new FakeGuest();
    // browser-stealth.ts loaded about:blank to give the held guest a renderer.
    await guest.loadURL("about:blank");
    hold(guest, Promise.resolve("applied"));
    await settle();
    await settle();
    expect(guest.loads).toEqual([URL]);
  });

  it("keeps a history that does not start with that blank page", async () => {
    const guest = new FakeGuest();
    hold(guest, Promise.resolve("applied"));
    await settle();
    await settle();
    expect(guest.loads).toEqual([URL]);
  });

  it("waits 10 s by default (spec 04 §27d.3)", () => {
    expect(IDENTITY_LOAD_TIMEOUT_MS).toBe(10_000);
  });
});
