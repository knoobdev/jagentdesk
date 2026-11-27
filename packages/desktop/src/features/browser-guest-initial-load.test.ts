import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { IdentityOutcome } from "./browser-stealth.js";
import { watchGuestTeardown } from "./guest-teardown.js";

vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { loadHeldGuestUrlAfterIdentity } = await import("./browser-guest-initial-load.js");

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
});
