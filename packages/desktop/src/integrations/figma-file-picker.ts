import { BrowserWindow, type WebContents, type WebPreferences } from "electron";
import {
  FIGMA_PICKER_PARTITION,
  FIGMA_PICKER_URL,
  isFigmaPickerNavigation,
  selectedFigmaFileUrl,
} from "./figma-file-picker-policy.js";

export type FigmaFilePickerResult = { kind: "file"; url: string } | { kind: "cancelled" };

// ERR_ABORTED: our own stop()/preventDefault and the site's in-flight redirects land here, so a
// cancelled load is not a failure; everything else on the main frame is (ADR-0038 review).
const ERR_ABORTED = -3;

// The guest is a plain website window: one persistent partition shared with its login popups,
// sandboxed, context-isolated, and with no Node, no preload, and no IPC from the page. The
// renderer talks to the website no more than a browser does — only the navigation URL crosses
// back, and the REST path through the daemon owns all data (ADR-0038).
function guestWebPreferences(): WebPreferences {
  return {
    partition: FIGMA_PICKER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
  };
}

let pending: Promise<FigmaFilePickerResult> | null = null;

/**
 * Opens the Figma Files guest (or returns the in-flight one) and settles with the file the user
 * selected, or `cancelled` when the window is closed without a selection. The guest dying under
 * the user — initial or later main-frame load failure, a lost render process, an unresponsive
 * page — rejects with a visible failure instead of posing as a cancellation. The next call
 * starts fresh either way.
 */
export function pickFigmaFile(): Promise<FigmaFilePickerResult> {
  if (pending) return pending;
  const parent = BrowserWindow.getFocusedWindow();
  const result = new Promise<FigmaFilePickerResult>((resolve, reject) => {
    const owned = new Set<BrowserWindow>();
    let finished = false;

    const destroyOwned = () => {
      for (const guest of owned) {
        if (!guest.isDestroyed()) guest.destroy();
      }
      owned.clear();
    };
    const finish = (selection: FigmaFilePickerResult) => {
      if (finished) return;
      finished = true;
      resolve(selection);
      destroyOwned();
    };
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      reject(error instanceof Error ? error : new Error(String(error)));
      destroyOwned();
    };
    const select = (contents: WebContents, url: string): boolean => {
      const selected = selectedFigmaFileUrl(url);
      if (!selected) return false;
      contents.stop(); // drop the guest before the heavy editor ever loads (ADR-0038)
      finish({ kind: "file", url: selected });
      return true;
    };
    const guard = (contents: WebContents, owner: BrowserWindow) => {
      // Redirects bypass will-navigate, so both events share one capture path.
      const capture = (event: { preventDefault(): void }, url: string): void => {
        if (selectedFigmaFileUrl(url)) {
          event.preventDefault(); // never let the editor load in the guest
          select(contents, url);
        } else if (!isFigmaPickerNavigation(url)) {
          event.preventDefault();
        }
      };
      contents.on("will-navigate", (event, url) => capture(event, url));
      contents.on("will-redirect", (event, url) => capture(event, url));
      contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
        if (isMainFrame) select(contents, url); // SPA pushState selection
      });
      contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
        if (!isMainFrame || errorCode === ERR_ABORTED) return;
        fail(new Error(`Figma failed to load (${errorCode}): ${errorDescription}`));
      });
      contents.on("render-process-gone", (_event, details) => {
        // clean-exit is our own destroy(); anything else means the guest died under the user.
        if (details.reason !== "clean-exit") {
          fail(new Error(`Figma picker render process ${details.reason}.`));
        }
      });
      contents.setWindowOpenHandler(({ url }) => {
        const selected = selectedFigmaFileUrl(url);
        if (selected) {
          finish({ kind: "file", url: selected });
          return { action: "deny" };
        }
        if (!isFigmaPickerNavigation(url)) return { action: "deny" };
        return {
          action: "allow",
          overrideBrowserWindowOptions: { parent: owner, webPreferences: guestWebPreferences() },
        };
      });
      contents.on("did-create-window", (window) => attach(window));
    };
    const attach = (window: BrowserWindow) => {
      owned.add(window);
      window.once("closed", () => owned.delete(window));
      window.on("unresponsive", () => {
        fail(new Error("Figma picker became unresponsive."));
      });
      guard(window.webContents, window);
    };

    const picker = new BrowserWindow({
      title: "Browse Figma files",
      width: 1120,
      height: 800,
      ...(parent ? { parent } : {}),
      webPreferences: guestWebPreferences(),
    });
    picker.setMenuBarVisibility(false);
    attach(picker);
    picker.once("closed", () => finish({ kind: "cancelled" }));
    void picker.loadURL(FIGMA_PICKER_URL).catch((error: unknown) => fail(error));
  });
  pending = result.finally(() => {
    pending = null;
  });
  return pending;
}
