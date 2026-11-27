import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  GuestGoneError,
  isGuestGone,
  isTargetClosedError,
  isTargetCrashedError,
  runWhenGuestSettled,
  watchGuestTeardown,
  whenGuestSettled,
} from "./guest-teardown.js";

class FakeGuest extends EventEmitter {
  public readonly debugger = new EventEmitter();
  public destroyed = false;

  public isDestroyed(): boolean {
    return this.destroyed;
  }
}

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("guest teardown", () => {
  it("marks the guest gone when its debugger loses the target, before isDestroyed() does", () => {
    const guest = new FakeGuest();
    watchGuestTeardown(guest);
    expect(isGuestGone(guest)).toBe(false);

    guest.debugger.emit("detach", {}, "target closed");

    expect(guest.isDestroyed()).toBe(false);
    expect(isGuestGone(guest)).toBe(true);
  });

  it("marks the guest gone when it is destroyed", () => {
    const guest = new FakeGuest();
    watchGuestTeardown(guest);
    guest.emit("destroyed");
    expect(isGuestGone(guest)).toBe(true);
  });

  it("watches a guest once", () => {
    const guest = new FakeGuest();
    watchGuestTeardown(guest);
    watchGuestTeardown(guest);
    expect(guest.debugger.listenerCount("detach")).toBe(1);
    expect(guest.listenerCount("destroyed")).toBe(1);
  });

  it("runs a task on a later macrotask only if the guest is still alive", async () => {
    const alive = new FakeGuest();
    const closing = new FakeGuest();
    watchGuestTeardown(closing);
    const ran: string[] = [];

    runWhenGuestSettled(alive, () => ran.push("alive"));
    runWhenGuestSettled(closing, () => ran.push("closing"));
    expect(ran).toEqual([]);
    closing.debugger.emit("detach", {}, "target closed");
    await nextMacrotask();

    expect(ran).toEqual(["alive"]);
  });

  it("rejects the promise form once the guest is gone", async () => {
    const guest = new FakeGuest();
    watchGuestTeardown(guest);
    const pending = whenGuestSettled(guest, () => "loaded");
    guest.debugger.emit("detach", {}, "target closed");

    await expect(pending).rejects.toBeInstanceOf(GuestGoneError);
    await expect(whenGuestSettled(new FakeGuest(), () => "loaded")).resolves.toBe("loaded");
  });

  it("recognises Electron's target errors", () => {
    expect(isTargetClosedError(new Error("target closed while handling command"))).toBe(true);
    expect(isTargetClosedError(new Error("No target available"))).toBe(true);
    expect(isTargetClosedError(new Error("Target crashed"))).toBe(false);
    expect(isTargetCrashedError(new Error("Target crashed"))).toBe(true);
    expect(isTargetCrashedError(new Error("Cannot find context"))).toBe(false);
  });
});
