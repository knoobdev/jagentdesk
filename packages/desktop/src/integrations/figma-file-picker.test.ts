import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIGMA_PICKER_PARTITION, FIGMA_PICKER_URL } from "./figma-file-picker-policy";
import { pickFigmaFile, type FigmaFilePickerResult } from "./figma-file-picker";

const { FakeBrowserWindow: PickerWindow } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  interface OpenResult {
    action: "allow" | "deny";
    overrideBrowserWindowOptions?: {
      parent?: unknown;
      webPreferences?: Record<string, unknown>;
    };
  }
  interface WindowOptions {
    title?: string;
    width?: number;
    height?: number;
    parent?: unknown;
    webPreferences?: Record<string, unknown>;
  }

  class FakeEmitter {
    private readonly listeners = new Map<string, Listener[]>();

    public on(event: string, listener: Listener): void {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
    }

    public once(event: string, listener: Listener): void {
      const wrapped: Listener = (...args) => {
        this.off(event, wrapped);
        listener(...args);
      };
      this.on(event, wrapped);
    }

    public off(event: string, listener: Listener): void {
      const existing = this.listeners.get(event) ?? [];
      const index = existing.indexOf(listener);
      if (index >= 0) existing.splice(index, 1);
    }

    public emit(event: string, ...args: unknown[]): void {
      for (const listener of Array.from(this.listeners.get(event) ?? [])) listener(...args);
    }
  }

  class FakeWebContents extends FakeEmitter {
    public stopCount = 0;
    public openHandler: ((details: { url: string }) => OpenResult) | null = null;

    public stop(): void {
      this.stopCount += 1;
    }

    public setWindowOpenHandler(handler: (details: { url: string }) => OpenResult): void {
      this.openHandler = handler;
    }
  }

  class FakeBrowserWindow extends FakeEmitter {
    public static instances: FakeBrowserWindow[] = [];
    public static focused: FakeBrowserWindow | null = null;
    public static failNextLoad: Error | null = null;

    public static getFocusedWindow(): FakeBrowserWindow | null {
      return FakeBrowserWindow.focused;
    }

    public static reset(): void {
      FakeBrowserWindow.instances = [];
      FakeBrowserWindow.focused = null;
      FakeBrowserWindow.failNextLoad = null;
    }

    public readonly webContents = new FakeWebContents();
    public readonly options: WindowOptions;
    public destroyed = false;
    public loadedUrl: string | null = null;
    public menuBarVisible = true;

    public constructor(options: WindowOptions) {
      super();
      this.options = options;
      FakeBrowserWindow.instances.push(this);
    }

    public setMenuBarVisibility(visible: boolean): void {
      this.menuBarVisible = visible;
    }

    public async loadURL(url: string): Promise<void> {
      this.loadedUrl = url;
      const failure = FakeBrowserWindow.failNextLoad;
      FakeBrowserWindow.failNextLoad = null;
      if (failure) throw failure;
    }

    public close(): void {
      // Mirrors Electron: a user-initiated close has the window gone when 'closed' fires.
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }

    public destroy(): void {
      this.close();
    }

    public isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  return { FakeBrowserWindow };
});

vi.mock("electron", () => ({ BrowserWindow: PickerWindow }));

class FakeNavigationEvent {
  public defaultPrevented = false;

  public preventDefault(): void {
    this.defaultPrevented = true;
  }
}

const FILE_KEY = "XKVu5QzA9G4iGv5pKQ2m3c";
const selectedDesignUrl = `https://www.figma.com/design/${FILE_KEY}/My%20File?node-id=1-23&t=ZqLm`;
const selectedDesignResult = `https://www.figma.com/design/${FILE_KEY}?node-id=1-23`;

let openPicks: Promise<FigmaFilePickerResult>[] = [];

function startPick(): Promise<FigmaFilePickerResult> {
  const pick = pickFigmaFile();
  openPicks.push(pick);
  return pick;
}

function guest(): PickerWindow {
  const window = PickerWindow.instances.at(-1);
  if (!window) throw new Error("no picker window was created");
  return window;
}

beforeEach(() => {
  PickerWindow.reset();
  openPicks = [];
});

afterEach(async () => {
  // Nothing may leave a pending pick behind: closing every owned window settles it.
  for (const window of PickerWindow.instances) window.close();
  await Promise.allSettled(openPicks);
});

describe("pickFigmaFile guest window", () => {
  it("loads the real Files site in a sandboxed website guest with no Node, preload, or IPC", async () => {
    PickerWindow.focused = new PickerWindow({});
    const pick = startPick();

    const picker = guest();
    expect(picker.loadedUrl).toBe(FIGMA_PICKER_URL);
    expect(picker.menuBarVisible).toBe(false);
    expect(picker.options.parent).toBe(PickerWindow.focused);
    const preferences = picker.options.webPreferences ?? {};
    expect(preferences).toMatchObject({
      partition: FIGMA_PICKER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    });
    expect(Object.keys(preferences)).not.toContain("preload");

    picker.close();
    await expect(pick).resolves.toEqual({ kind: "cancelled" });
  });

  it("has no parent when no window is focused", async () => {
    const pick = startPick();
    expect(guest().options.parent).toBeUndefined();
    pick.catch(() => undefined);
  });
});

describe("pickFigmaFile selection", () => {
  it("catches a top-level navigation to a file, prevents the editor load, and closes the guest", async () => {
    const pick = startPick();
    const picker = guest();
    const event = new FakeNavigationEvent();

    picker.webContents.emit("will-navigate", event, selectedDesignUrl);

    expect(event.defaultPrevented).toBe(true);
    await expect(pick).resolves.toEqual({ kind: "file", url: selectedDesignResult });
    expect(picker.webContents.stopCount).toBe(1);
    expect(picker.destroyed).toBe(true);
  });

  it("catches a server redirect to a file, which bypasses will-navigate", async () => {
    const pick = startPick();
    const picker = guest();
    const event = new FakeNavigationEvent();

    picker.webContents.emit("will-redirect", event, selectedDesignUrl);

    expect(event.defaultPrevented).toBe(true);
    await expect(pick).resolves.toEqual({ kind: "file", url: selectedDesignResult });
    expect(picker.webContents.stopCount).toBe(1);
    expect(picker.destroyed).toBe(true);
  });

  it("blocks a non-HTTPS redirect without ending the pick", async () => {
    const pick = startPick();
    const picker = guest();
    const event = new FakeNavigationEvent();

    picker.webContents.emit("will-redirect", event, `http://www.figma.com/design/${FILE_KEY}`);

    expect(event.defaultPrevented).toBe(true);
    picker.close();
    await expect(pick).resolves.toEqual({ kind: "cancelled" });
  });

  it("catches a redirected child window the same way as the guest itself", async () => {
    const pick = startPick();
    const picker = guest();
    const child = new PickerWindow({});
    picker.webContents.emit("did-create-window", child);
    const event = new FakeNavigationEvent();

    child.webContents.emit("will-redirect", event, selectedDesignUrl);

    expect(event.defaultPrevented).toBe(true);
    await expect(pick).resolves.toEqual({ kind: "file", url: selectedDesignResult });
    expect(child.destroyed).toBe(true);
    expect(picker.destroyed).toBe(true);
  });

  it("catches a SPA pushState selection from the main frame only", async () => {
    const pick = startPick();
    const picker = guest();

    picker.webContents.emit(
      "did-navigate-in-page",
      new FakeNavigationEvent(),
      `https://www.figma.com/proto/${FILE_KEY}?node-id=2-4`,
      false,
    );
    picker.webContents.emit(
      "did-navigate-in-page",
      new FakeNavigationEvent(),
      selectedDesignUrl,
      true,
    );

    await expect(pick).resolves.toEqual({ kind: "file", url: selectedDesignResult });
  });

  it("blocks non-HTTPS navigations, allows off-host HTTPS, and never ends the pick", async () => {
    const pick = startPick();
    const picker = guest();

    const away = new FakeNavigationEvent();
    picker.webContents.emit("will-navigate", away, "https://example.com/pricing");
    expect(away.defaultPrevented).toBe(false); // off-host HTTPS still navigates

    const insecure = new FakeNavigationEvent();
    picker.webContents.emit("will-navigate", insecure, `http://www.figma.com/design/${FILE_KEY}`);
    expect(insecure.defaultPrevented).toBe(true);

    const within = new FakeNavigationEvent();
    picker.webContents.emit("will-navigate", within, "https://www.figma.com/files");
    expect(within.defaultPrevented).toBe(false);

    picker.close();
    await expect(pick).resolves.toEqual({ kind: "cancelled" });
    expect(picker.destroyed).toBe(true);
  });

  it("selects a file opened through window.open without creating the popup", async () => {
    const pick = startPick();
    const picker = guest();
    const handler = picker.webContents.openHandler;
    if (!handler) throw new Error("no window-open handler was installed");

    expect(handler({ url: selectedDesignUrl })).toEqual({ action: "deny" });

    await expect(pick).resolves.toEqual({ kind: "file", url: selectedDesignResult });
    expect(picker.destroyed).toBe(true);
  });

  it("allows HTTPS popups into the same sandboxed guest session and denies other schemes", async () => {
    const pick = startPick();
    const picker = guest();
    const handler = picker.webContents.openHandler;
    if (!handler) throw new Error("no window-open handler was installed");

    const popup = handler({ url: "https://accounts.google.com/o/oauth2/auth" });
    expect(popup.action).toBe("allow");
    const popupPreferences = popup.overrideBrowserWindowOptions?.webPreferences ?? {};
    expect(popupPreferences).toMatchObject({
      partition: FIGMA_PICKER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    });
    expect(Object.keys(popupPreferences)).not.toContain("preload");
    expect(popup.overrideBrowserWindowOptions?.parent).toBe(picker);

    expect(handler({ url: "http://localhost:3000/help" })).toEqual({ action: "deny" });

    picker.close();
    await expect(pick).resolves.toEqual({ kind: "cancelled" });
  });

  it("guards child windows and closes every owned window once a selection lands", async () => {
    const pick = startPick();
    const picker = guest();
    const child = new PickerWindow({});
    picker.webContents.emit("did-create-window", child);

    const event = new FakeNavigationEvent();
    child.webContents.emit("will-navigate", event, selectedDesignUrl);

    expect(event.defaultPrevented).toBe(true);
    await expect(pick).resolves.toEqual({ kind: "file", url: selectedDesignResult });
    expect(child.destroyed).toBe(true);
    expect(picker.destroyed).toBe(true);
  });
});

describe("pickFigmaFile cancellation and failures", () => {
  it("resolves cancelled when the user closes the window", async () => {
    const pick = startPick();
    const picker = guest();

    picker.close();

    await expect(pick).resolves.toEqual({ kind: "cancelled" });
  });

  it("rejects as a visible failure when the guest process crashes, not as a cancellation", async () => {
    const pick = startPick();
    const picker = guest();

    picker.webContents.emit("render-process-gone", new FakeNavigationEvent(), {
      reason: "crashed",
    });

    await expect(pick).rejects.toThrow("render process crashed");
    expect(picker.destroyed).toBe(true);
  });

  it("ignores the clean-exit render-process-gone caused by our own teardown", async () => {
    const pick = startPick();
    const picker = guest();

    picker.webContents.emit("render-process-gone", new FakeNavigationEvent(), {
      reason: "clean-exit",
    });
    picker.close();

    await expect(pick).resolves.toEqual({ kind: "cancelled" });
  });

  it("rejects as a visible failure when the guest page stops responding", async () => {
    const pick = startPick();
    const picker = guest();

    picker.emit("unresponsive");

    await expect(pick).rejects.toThrow("unresponsive");
    expect(picker.destroyed).toBe(true);
  });

  it("rejects a later main-frame load failure and closes every owned window", async () => {
    const pick = startPick();
    const picker = guest();
    const child = new PickerWindow({});
    picker.webContents.emit("did-create-window", child);

    picker.webContents.emit(
      "did-fail-load",
      new FakeNavigationEvent(),
      -6,
      "net::ERR_INTERNET_DISCONNECTED",
      "https://www.figma.com/files",
      true,
    );

    await expect(pick).rejects.toThrow("net::ERR_INTERNET_DISCONNECTED");
    expect(picker.destroyed).toBe(true);
    expect(child.destroyed).toBe(true);
  });

  it("ignores aborted and subframe load failures", async () => {
    const pick = startPick();
    const picker = guest();

    // ERR_ABORTED is our own stop/preventDefault; subframes never own the pick.
    picker.webContents.emit(
      "did-fail-load",
      new FakeNavigationEvent(),
      -3,
      "net::ERR_ABORTED",
      selectedDesignUrl,
      true,
    );
    picker.webContents.emit(
      "did-fail-load",
      new FakeNavigationEvent(),
      -6,
      "net::ERR_INTERNET_DISCONNECTED",
      "https://www.figma.com/iframe-login",
      false,
    );

    const event = new FakeNavigationEvent();
    picker.webContents.emit("will-navigate", event, selectedDesignUrl);
    await expect(pick).resolves.toEqual({ kind: "file", url: selectedDesignResult });
    expect(event.defaultPrevented).toBe(true);
  });

  it("shares one guest across duplicate calls and opens a fresh guest afterwards", async () => {
    const first = startPick();
    const second = startPick();
    expect(first).toBe(second);
    expect(PickerWindow.instances).toHaveLength(1);

    guest().close();
    await expect(first).resolves.toEqual({ kind: "cancelled" });
    await expect(second).resolves.toEqual({ kind: "cancelled" });

    const third = startPick();
    expect(PickerWindow.instances).toHaveLength(2);
    guest().close();
    await third;
  });

  it("rejects and closes owned windows when the initial load fails, and stays usable", async () => {
    PickerWindow.failNextLoad = new Error("net::ERR_NAME_NOT_RESOLVED");

    await expect(startPick()).rejects.toThrow("net::ERR_NAME_NOT_RESOLVED");
    expect(guest().destroyed).toBe(true);

    const retry = startPick();
    expect(PickerWindow.instances).toHaveLength(2);
    expect(guest().destroyed).toBe(false);
    guest().close();
    await expect(retry).resolves.toEqual({ kind: "cancelled" });
  });
});
