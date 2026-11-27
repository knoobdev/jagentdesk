import log from "electron-log";
import type { IdentityOutcome } from "./browser-stealth.js";
import { isGuestGone, runWhenGuestSettled } from "./guest-teardown.js";

/** How long a held first load waits for the identity before the timeout policy applies. */
export const IDENTITY_LOAD_TIMEOUT_MS = 20_000;

export interface HeldGuestContents {
  readonly id: number;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
}

/**
 * Load a guest's held first URL once its identity is applied (ADR-0026: the first request
 * carries the identity).
 *
 * - The guest closed: nothing; it must not be touched (guest-teardown.ts).
 * - The identity could not be applied, or is still pending after `timeoutMs`: with a
 *   profile or the legacy stealth toggle the URL stays held (fail-closed) and the error is
 *   logged; without one the session's plain Chrome UA is the whole identity, so it loads.
 *   A held URL still loads if the identity lands after the timeout.
 */
export function loadHeldGuestUrlAfterIdentity(input: {
  contents: HeldGuestContents;
  initialUrl: string | null;
  identity: Promise<IdentityOutcome>;
  identityProtected: () => boolean;
  timeoutMs?: number;
}): void {
  const { contents, initialUrl, identity, identityProtected } = input;
  if (!initialUrl) {
    return;
  }
  const webContentsId = contents.id;
  let settled = false;
  const load = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    runWhenGuestSettled(contents, () => {
      contents.loadURL(initialUrl).catch((error: unknown) => {
        // ERR_ABORTED: the page navigated again before the first load finished.
        if (error instanceof Error && error.message.includes("ERR_ABORTED")) return;
        log.warn("[browser-stealth] initial guest load failed", {
          webContentsId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  };
  const timer = setTimeout(() => {
    if (settled || isGuestGone(contents)) {
      return;
    }
    if (!identityProtected()) {
      log.warn("[browser-stealth] identity still pending; loading with the session identity", {
        webContentsId,
      });
      load();
      return;
    }
    log.error("[browser-stealth] identity still pending; the tab's first load stays held", {
      webContentsId,
    });
  }, input.timeoutMs ?? IDENTITY_LOAD_TIMEOUT_MS);
  timer.unref?.();
  const onOutcome = (outcome: IdentityOutcome) => {
    if (settled) {
      return;
    }
    if (outcome === "closed") {
      settled = true;
      clearTimeout(timer);
      return;
    }
    if (outcome === "unavailable" && identityProtected()) {
      settled = true;
      clearTimeout(timer);
      log.error("[browser-stealth] identity could not be applied; not loading the tab", {
        webContentsId,
      });
      return;
    }
    load();
  };
  identity.then(onOutcome, () => onOutcome("failed"));
}
