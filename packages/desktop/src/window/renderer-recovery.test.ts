import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { reloadWhenRendererExits } from "./renderer-recovery.js";

class Contents extends EventEmitter {
  reloads = 0;
  url = "jagentdesk://app/";
  getURL() {
    return this.url;
  }
  reload() {
    this.reloads += 1;
  }
  exit(reason: string) {
    this.emit("render-process-gone", {}, { reason, exitCode: reason === "clean-exit" ? 0 : 15 });
  }
}

class Window {
  webContents = new Contents();
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
}

function recoverableWindow() {
  const win = new Window();
  let time = 0;
  const deferred: Array<() => void> = [];
  reloadWhenRendererExits(win, { now: () => time, defer: (task) => deferred.push(task) });
  return {
    win,
    advance(ms: number) {
      time += ms;
    },
    flush() {
      for (const task of deferred.splice(0)) task();
    },
  };
}

describe("reloadWhenRendererExits", () => {
  it("reloads the window when its renderer is killed, after the exit event", () => {
    const { win, flush } = recoverableWindow();
    win.webContents.exit("killed");
    expect(win.webContents.reloads).toBe(0);
    flush();
    expect(win.webContents.reloads).toBe(1);
  });

  it("does not reload a window closed before the deferred reload runs", () => {
    const { win, flush } = recoverableWindow();
    win.webContents.exit("killed");
    win.destroyed = true;
    flush();
    expect(win.webContents.reloads).toBe(0);
  });

  it("reloads after a renderer crash or out-of-memory exit", () => {
    const { win, advance, flush } = recoverableWindow();
    win.webContents.exit("crashed");
    advance(120_000);
    win.webContents.exit("oom");
    flush();
    expect(win.webContents.reloads).toBe(2);
  });

  it("leaves a renderer that exited cleanly alone", () => {
    const { win, flush } = recoverableWindow();
    win.webContents.exit("clean-exit");
    flush();
    expect(win.webContents.reloads).toBe(0);
  });

  it("leaves a renderer that exits before the first page commits to Chromium", () => {
    const { win, flush } = recoverableWindow();
    win.webContents.url = "";
    win.webContents.exit("killed");
    flush();
    expect(win.webContents.reloads).toBe(0);
  });

  it("leaves a closed window closed", () => {
    const { win, flush } = recoverableWindow();
    win.destroyed = true;
    win.webContents.exit("killed");
    flush();
    expect(win.webContents.reloads).toBe(0);
  });

  it("stops reloading a renderer that keeps exiting, and recovers again later", () => {
    const { win, advance, flush } = recoverableWindow();
    for (let exit = 0; exit < 5; exit += 1) {
      win.webContents.exit("crashed");
      advance(1_000);
    }
    flush();
    expect(win.webContents.reloads).toBe(3);

    advance(60_000);
    win.webContents.exit("killed");
    flush();
    expect(win.webContents.reloads).toBe(4);
  });
});
