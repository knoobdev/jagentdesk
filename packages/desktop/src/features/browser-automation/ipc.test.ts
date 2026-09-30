import { EventEmitter } from "node:events";
import type { Rectangle } from "electron";
import { describe, expect, test, vi } from "vitest";
import type { TabImage } from "./service.js";
import { installGuestDialogHandler } from "./guest-dialogs.js";
import { adaptWebContents, HostSnapshotEngineRegistry } from "./ipc.js";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";

class FakeImage implements TabImage {
  public toPNG(): Uint8Array {
    return new Uint8Array([137, 80, 78, 71]);
  }

  public getSize(): { width: number; height: number } {
    return { width: 640, height: 480 };
  }
}

class FakeDebugger {
  public attachedProtocolVersions: string[] = [];
  public commands: Array<{ command: string; params: Record<string, unknown> }> = [];
  public blockCommands = false;
  public readonly blockedCommandNames = new Set<string>();
  public readonly failedCommandNames = new Set<string>();
  public readonly promptDialogs: unknown[] = [];
  public failPromptDrain = false;
  private messageListener:
    | ((event: unknown, method: string, params?: Record<string, unknown>) => void)
    | null = null;
  private readonly blockedCommands: Array<() => void> = [];

  public isAttached(): boolean {
    return this.attachedProtocolVersions.length > 0;
  }

  public attach(protocolVersion?: string): void {
    this.attachedProtocolVersions.push(protocolVersion ?? "");
  }

  public async sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ command, params: params ?? {} });
    if (this.failedCommandNames.has(command)) {
      throw new Error(`${command} failed`);
    }
    if (this.blockCommands || this.blockedCommandNames.has(command)) {
      await new Promise<void>((resolve) => {
        this.blockedCommands.push(resolve);
      });
    }
    if (command === "Runtime.evaluate" && typeof params?.expression === "string") {
      if (params.expression.includes("state.prompts.splice(0)")) {
        if (this.failPromptDrain) {
          throw new Error("execution context destroyed");
        }
        return { result: { value: this.promptDialogs.splice(0) } };
      }
      return { result: { value: true } };
    }
    return { ok: true };
  }

  public on(
    event: "message",
    listener: (event: unknown, method: string, params?: Record<string, unknown>) => void,
  ): void {
    expect(event).toBe("message");
    this.messageListener = listener;
  }

  public emitMessage(method: string, params?: Record<string, unknown>): void {
    if (!this.messageListener) {
      throw new Error("Debugger message listener was not registered");
    }
    this.messageListener({}, method, params);
  }

  public finishNextCommand(): void {
    const resolve = this.blockedCommands.shift();
    if (!resolve) {
      throw new Error("No command is blocked");
    }
    resolve();
  }
}

type ConsoleMessageListener = (
  event: unknown,
  level: unknown,
  message: unknown,
  line: unknown,
  sourceId: unknown,
) => void;

class FakeWebContents {
  public readonly debugger = new FakeDebugger();
  public readonly inputEvents: IsolatedKeyboardInputEvent[] = [];
  public readonly captures: Array<{
    rect: Rectangle | undefined;
    options: { stayHidden?: boolean } | undefined;
  }> = [];
  public readonly invalidations: string[] = [];
  private consoleMessageListener: ConsoleMessageListener | null = null;
  private destroyedListener: (() => void) | null = null;
  public destroyed = false;

  public constructor(private readonly webContentsId: number) {}

  public get id(): number {
    if (this.destroyed) {
      throw new TypeError("Object has been destroyed");
    }
    return this.webContentsId;
  }

  public getURL(): string {
    return "https://example.com";
  }

  public getTitle(): string {
    return "Example";
  }

  public canGoBack(): boolean {
    return false;
  }

  public canGoForward(): boolean {
    return false;
  }

  public isLoading(): boolean {
    return false;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public async executeJavaScript(): Promise<unknown> {
    return null;
  }

  public async loadURL(): Promise<void> {}

  public goBack(): void {}

  public goForward(): void {}

  public reload(): void {}

  public async capturePage(
    rect?: Rectangle,
    options?: { stayHidden?: boolean },
  ): Promise<TabImage> {
    this.captures.push({ rect, options });
    return new FakeImage();
  }

  public invalidate(): void {
    this.invalidations.push("invalidate");
  }

  public sendInputEvent(event: IsolatedKeyboardInputEvent): void {
    this.inputEvents.push(event);
  }

  public on(event: "console-message", listener: ConsoleMessageListener): void {
    expect(event).toBe("console-message");
    this.consoleMessageListener = listener;
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public emitConsoleMessage(input: {
    level: unknown;
    message: unknown;
    line: unknown;
    sourceId: unknown;
  }): void {
    if (!this.consoleMessageListener) {
      throw new Error("Console listener was not registered");
    }
    this.consoleMessageListener({}, input.level, input.message, input.line, input.sourceId);
  }

  public destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }
}

describe("browser automation IPC adapter", () => {
  test("isolates snapshot refs by host window and releases them on destruction", () => {
    const registry = new HostSnapshotEngineRegistry();
    const firstHost = new FakeHostWebContents(1);
    const secondHost = new FakeHostWebContents(2);

    const firstEngine = registry.get(firstHost);
    expect(registry.get(firstHost)).toBe(firstEngine);
    expect(registry.get(secondHost)).not.toBe(firstEngine);

    firstHost.destroy();
    expect(registry.get(new FakeHostWebContents(1))).not.toBe(firstEngine);
  });

  test("sends contained keyboard input directly to the guest", () => {
    const contents = new FakeWebContents(19);
    const tab = adaptWebContents(contents);

    tab.sendInputEvent({ type: "keyDown", keyCode: "Enter", skipIfUnhandled: true });

    expect(contents.inputEvents).toEqual([
      { type: "keyDown", keyCode: "Enter", skipIfUnhandled: true },
    ]);
  });

  test("delegates viewport capture to the guest without a renderer prep bridge", async () => {
    const contents = new FakeWebContents(20);
    const tab = adaptWebContents(contents);

    const image = await tab.capturePage({ stayHidden: false });
    tab.invalidate();

    expect(image.getSize()).toEqual({ width: 640, height: 480 });
    expect(contents.captures).toEqual([{ rect: undefined, options: { stayHidden: false } }]);
    expect(contents.invalidations).toEqual(["invalidate"]);
  });

  test("collects console messages until the guest is destroyed", () => {
    const contents = new FakeWebContents(21);
    const tab = adaptWebContents(contents);

    contents.emitConsoleMessage({
      level: "warning",
      message: "hello",
      line: 12,
      sourceId: "https://example.com/app.js",
    });

    expect(tab.getConsoleMessages?.()).toEqual([
      {
        level: "warning",
        message: "hello",
        line: 12,
        source: "https://example.com/app.js",
        timestamp: expect.any(Number),
      },
    ]);

    expect(() => contents.destroy()).not.toThrow();

    expect(tab.getConsoleMessages?.()).toEqual([]);
  });

  test("attaches the debugger before sending a CDP command", async () => {
    const contents = new FakeWebContents(22);
    const tab = adaptWebContents(contents);

    const result = await tab.sendDebugCommand?.("Page.captureScreenshot", {
      format: "png",
    });

    expect(result).toEqual({ ok: true });
    expect(contents.debugger.attachedProtocolVersions).toEqual(["1.3"]);
    expect(contents.debugger.commands).toEqual([
      { command: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
      { command: "Page.captureScreenshot", params: { format: "png" } },
    ]);
  });

  test("serializes CDP commands per guest contents", async () => {
    const contents = new FakeWebContents(23);
    contents.debugger.blockedCommandNames.add("Input.dispatchMouseEvent");
    contents.debugger.blockedCommandNames.add("Page.captureScreenshot");
    const tab = adaptWebContents(contents);

    const first = tab.sendDebugCommand?.("Input.dispatchMouseEvent", { type: "mouseMoved" });
    const second = tab.sendDebugCommand?.("Page.captureScreenshot", { format: "png" });
    await flushMicrotasks();

    expect(contents.debugger.commands).toEqual([
      { command: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
      { command: "Input.dispatchMouseEvent", params: { type: "mouseMoved" } },
    ]);

    contents.debugger.finishNextCommand();
    await flushMicrotasks();

    expect(contents.debugger.commands).toEqual([
      { command: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
      { command: "Input.dispatchMouseEvent", params: { type: "mouseMoved" } },
      { command: "Page.captureScreenshot", params: { format: "png" } },
    ]);

    contents.debugger.finishNextCommand();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  test("returns as soon as the command opens a dialog, leaving the tab waiting", async () => {
    const contents = new FakeWebContents(24);
    const guest = new FakeDialogGuest(24);
    installGuestDialogHandler(guest);
    const tab = adaptWebContents(contents);
    const click = deferred<string>();

    const captured = tab.captureDialogs!(() => click.promise);
    const respond = guest.openDialog({ dialogType: "confirm", messageText: "Delete item?" });
    const outcome = await captured;

    expect(outcome.result).toBeUndefined();
    expect(outcome.pendingDialog).toMatchObject({ type: "confirm", message: "Delete item?" });
    expect(tab.getPendingDialog?.()).toMatchObject({ type: "confirm" });
    expect(respond).not.toHaveBeenCalled();

    expect(tab.answerDialog?.({ action: "dismiss" })).toMatchObject({
      type: "confirm",
      action: "dismissed",
    });
    expect(respond).toHaveBeenCalledWith(false, "");
    expect(tab.getPendingDialog?.()).toBeNull();
    click.resolve("clicked");
  });

  test("returns the command result when no dialog opens", async () => {
    const contents = new FakeWebContents(25);
    installGuestDialogHandler(new FakeDialogGuest(25));
    const tab = adaptWebContents(contents);

    await expect(tab.captureDialogs!(async () => "done")).resolves.toEqual({
      result: "done",
      dialogs: [],
    });
  });

  test("a dialog in another tab does not interrupt the command", async () => {
    const contents = new FakeWebContents(26);
    installGuestDialogHandler(new FakeDialogGuest(26));
    const other = new FakeDialogGuest(27);
    installGuestDialogHandler(other);
    const tab = adaptWebContents(contents);
    const task = deferred<string>();

    const captured = tab.captureDialogs!(() => task.promise);
    other.openDialog({ dialogType: "alert", messageText: "elsewhere" });
    task.resolve("done");

    await expect(captured).resolves.toMatchObject({ result: "done" });
    expect(tab.getPendingDialog?.()).toBeNull();
  });
});

/** The guest side of Electron's `-run-dialog` event (see guest-dialogs.ts). */
class FakeDialogGuest extends EventEmitter {
  public constructor(public readonly id: number) {
    super();
  }

  public getURL(): string {
    return "http://localhost:4000/";
  }

  public isDestroyed(): boolean {
    return false;
  }

  public openDialog(info: Record<string, unknown>) {
    const respond = vi.fn();
    this.emit("-run-dialog", info, respond);
    return respond;
  }
}

class FakeHostWebContents {
  private destroyedListener: (() => void) | null = null;

  public constructor(public readonly id: number) {}

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyedListener?.();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
