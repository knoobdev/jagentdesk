/**
 * Teardown safety for guest webContents (agentic-browser webviews and their popups).
 *
 * When a guest is destroyed (tab closed, webview remounted, the app window's renderer
 * reloading or dying), Electron's debugger rejects its pending `sendCommand` promises
 * ("target closed while handling command") and emits `detach`. The rejections' promise
 * continuations run in the microtask checkpoint that closes that native event, while the
 * guest is being torn down and `isDestroyed()` still returns false. A continuation that
 * calls back into the guest from there (`loadURL` did, in the user's crashes) hits a
 * CHECK in the main process: SIGTRAP on CrBrowserMain, and the whole app is gone.
 *
 * So: a `detach` with reason "target closed" or `destroyed` marks the guest gone, and
 * code that touches a guest after an await goes through {@link isGuestGone} or
 * {@link runWhenGuestSettled}.
 */

interface TeardownDebugger {
  on(event: "detach", listener: (event: unknown, reason: string) => void): unknown;
}

export interface TeardownWatchable {
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  readonly debugger: TeardownDebugger;
}

const goneGuests = new WeakSet<object>();
const watchedGuests = new WeakSet<object>();

/** Electron's reasons for a debugger losing its target for good. */
const TARGET_CLOSED_MESSAGES = ["target closed while handling command", "No target available"];

/** Watch a guest for teardown. Idempotent. */
export function watchGuestTeardown(contents: TeardownWatchable): void {
  if (watchedGuests.has(contents)) {
    return;
  }
  watchedGuests.add(contents);
  contents.debugger.on("detach", (_event, reason) => {
    // Electron's only reason is "target closed" (the guest is going away, or the
    // debugger was detached explicitly, which nothing here does).
    if (reason === "target closed") {
      goneGuests.add(contents);
    }
  });
  contents.once("destroyed", () => {
    goneGuests.add(contents);
  });
}

/** True once the guest is being torn down or is destroyed: do not call into it. */
export function isGuestGone(contents: { isDestroyed(): boolean }): boolean {
  return goneGuests.has(contents) || contents.isDestroyed();
}

/** A CDP error meaning the debugger's target is gone for good. */
export function isTargetClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TARGET_CLOSED_MESSAGES.some((text) => message.includes(text));
}

/** A CDP error meaning the renderer died while the command was in flight. */
export function isTargetCrashedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Target crashed");
}

export class GuestGoneError extends Error {
  constructor() {
    super("Browser tab was closed");
    this.name = "GuestGoneError";
  }
}

/**
 * Run `task` on a later macrotask, and only if the guest is still alive then. A promise
 * continuation may be running inside the guest's teardown, where calling into the guest
 * crashes the main process; by the next macrotask the teardown has finished and
 * `isDestroyed()` tells the truth.
 */
export function runWhenGuestSettled(contents: { isDestroyed(): boolean }, task: () => void): void {
  setImmediate(() => {
    if (!isGuestGone(contents)) {
      task();
    }
  });
}

/** Promise form of {@link runWhenGuestSettled}: rejects with {@link GuestGoneError} if the guest went away. */
export function whenGuestSettled<T>(
  contents: { isDestroyed(): boolean },
  task: () => T | Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setImmediate(() => {
      if (isGuestGone(contents)) {
        reject(new GuestGoneError());
        return;
      }
      try {
        resolve(task());
      } catch (error) {
        reject(error);
      }
    });
  });
}
