import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalInputModeState } from "@jagentdesk/protocol/terminal-input-mode";
import { encodeTerminalOutput, TerminalEmulatorRuntime } from "./terminal-emulator-runtime";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    activate(): void {}
    dispose(): void {}
    onContextLoss(): void {}
  },
}));

interface TerminalSize {
  rows: number;
  cols: number;
  shouldClaim: boolean;
  forceClaim?: boolean;
}

interface TerminalKeyRecord {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

type BrowserTerminal = TerminalSize & {
  input: (data: string, wasUserInput?: boolean) => void;
  refresh: (start: number, end: number) => void;
  reset: () => void;
};

interface MountedTerminal {
  host: HTMLDivElement;
  root: HTMLDivElement;
  runtime: TerminalEmulatorRuntime;
  inputs: string[];
  sizes: TerminalSize[];
  terminalKeys: TerminalKeyRecord[];
  inputModeChanges: TerminalInputModeState[];
  openedUrls: string[];
}

const mountedTerminals: MountedTerminal[] = [];

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

function terminalOutput(text: string): Uint8Array {
  return encodeTerminalOutput(text);
}

async function waitFor(input: { predicate: () => boolean; timeoutMs?: number }): Promise<void> {
  const startedAt = performance.now();
  const timeoutMs = input.timeoutMs ?? 2_000;

  while (!input.predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for terminal browser condition");
    }
    await nextFrame();
  }
}

function settleMountRefits(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2_600));
}

/** Text typed into xterm's textarea, as the browser reports a typed character. */
function typeText(mounted: MountedTerminal, text: string): void {
  mounted.host
    .querySelector(".xterm-helper-textarea")
    ?.dispatchEvent(
      new InputEvent("input", { data: text, inputType: "insertText", bubbles: true }),
    );
}

/** A native paste of plain text into xterm's textarea. */
function pasteText(mounted: MountedTerminal, text: string): void {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  mounted.host
    .querySelector(".xterm-helper-textarea")
    ?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
}

function createTerminalHost(input: {
  width: number;
  height: number;
  scrollback?: number;
}): MountedTerminal {
  const root = document.createElement("div");
  root.style.width = `${input.width}px`;
  root.style.height = `${input.height}px`;
  root.style.position = "fixed";
  root.style.left = "0";
  root.style.top = "0";
  root.style.overflow = "hidden";

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  root.appendChild(host);
  document.body.appendChild(root);

  const sizes: TerminalSize[] = [];
  const inputs: string[] = [];
  const terminalKeys: TerminalKeyRecord[] = [];
  const inputModeChanges: TerminalInputModeState[] = [];
  const openedUrls: string[] = [];
  const runtime = new TerminalEmulatorRuntime();
  runtime.setCallbacks({
    callbacks: {
      onInput: (data) => {
        inputs.push(data);
      },
      onResize: (size) => {
        sizes.push(size);
      },
      onTerminalKey: (key) => {
        terminalKeys.push(key);
      },
      onInputModeChange: (state) => {
        inputModeChanges.push(state);
      },
      onOpenExternalUrl: (url) => {
        openedUrls.push(url);
      },
    },
  });
  runtime.mount({
    root,
    host,
    scrollback: input.scrollback ?? 10_000,
    theme: {
      background: "#0b0b0b",
      foreground: "#e6e6e6",
      cursor: "#e6e6e6",
    },
  });

  const mounted = {
    host,
    root,
    runtime,
    inputs,
    sizes,
    terminalKeys,
    inputModeChanges,
    openedUrls,
  };
  mountedTerminals.push(mounted);
  return mounted;
}

function latestSize(sizes: TerminalSize[]): TerminalSize {
  const size = sizes.at(-1);
  if (!size) {
    throw new Error("Terminal did not report a size");
  }
  return size;
}

function expectNoForcedSameSizeClaim(input: {
  sizes: TerminalSize[];
  startIndex: number;
  baseline: TerminalSize;
}): void {
  const forcedSameSizeClaims = input.sizes
    .slice(input.startIndex)
    .filter(
      (size) =>
        size.rows === input.baseline.rows &&
        size.cols === input.baseline.cols &&
        size.shouldClaim &&
        size.forceClaim,
    );
  expect(forcedSameSizeClaims).toEqual([]);
}

function getBrowserTerminal(): BrowserTerminal {
  const terminal = window.__jagentdeskTerminal as BrowserTerminal | undefined;
  if (!terminal) {
    throw new Error("Expected xterm to be exposed for browser test inspection");
  }
  return terminal;
}

function dispatchTerminalKey(input: {
  host: HTMLElement;
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): boolean {
  const textarea = input.host.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) {
    throw new Error("Expected xterm textarea to be mounted");
  }
  textarea.focus();
  return textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: input.key,
      shiftKey: input.shiftKey ?? false,
      ctrlKey: input.ctrlKey ?? false,
      altKey: input.altKey ?? false,
      metaKey: input.metaKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** An OSC 8 hyperlink, the escape sequence CLIs such as gh and ls --hyperlink print. */
function hyperlink(input: { url: string; text: string }): string {
  return `\x1b]8;;${input.url}\x1b\\${input.text}\x1b]8;;\x1b\\`;
}

function writeLines(mounted: MountedTerminal, lines: string[]): Promise<void> {
  return new Promise((resolve) => {
    mounted.runtime.write({
      data: terminalOutput(lines.map((line) => `${line}\r\n`).join("")),
      onCommitted: resolve,
    });
  });
}

async function clickTerminalLink(input: {
  host: HTMLElement;
  row: number;
  col: number;
}): Promise<void> {
  const terminal = getBrowserTerminal();
  const screen = input.host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) {
    throw new Error("Expected xterm screen to be mounted");
  }
  const position = {
    x: (input.col + 0.5) * (screen.clientWidth / terminal.cols),
    y: (input.row + 0.5) * (screen.clientHeight / terminal.rows),
  };
  await userEvent.hover(screen, { position });
  await waitFor({
    predicate: () => input.host.querySelector(".xterm-cursor-pointer") !== null,
  });
  await userEvent.click(screen, { position });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const mounted of mountedTerminals.splice(0)) {
    mounted.runtime.unmount();
    mounted.root.remove();
  }
});

describe("terminal emulator runtime in a real browser", () => {
  it("passes configured scrollback to xterm", async () => {
    await page.viewport(900, 600);
    createTerminalHost({ width: 720, height: 360, scrollback: 42_000 });

    await waitFor({
      predicate: () => window.__jagentdeskTerminal !== undefined,
    });

    expect(window.__jagentdeskTerminal?.options.scrollback).toBe(42_000);
  });

  it("updates scrollback on the mounted xterm", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360, scrollback: 10_000 });

    await waitFor({
      predicate: () => window.__jagentdeskTerminal !== undefined,
    });
    const terminal = window.__jagentdeskTerminal;

    mounted.runtime.setScrollback({ lines: 42_000 });

    expect(window.__jagentdeskTerminal).toBe(terminal);
    expect(window.__jagentdeskTerminal?.options.scrollback).toBe(42_000);
  });

  it("does not claim PTY ownership from passive mount refits", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();

    expect(mounted.sizes.length).toBeGreaterThan(1);
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);

    const settledSize = latestSize(mounted.sizes);
    mounted.runtime.resize({ forceClaim: true, shouldClaim: true });

    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([
      { ...settledSize, shouldClaim: true, forceClaim: true },
    ]);
  });

  it("reports a larger PTY size when the terminal container grows", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    const initialSize = latestSize(mounted.sizes);

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    await nextFrame();
    mounted.runtime.resize({ forceRefresh: true, shouldClaim: true });

    await waitFor({
      predicate: () => {
        const size = latestSize(mounted.sizes);
        return size.cols > initialSize.cols && size.rows > initialSize.rows;
      },
    });

    const grownSize = latestSize(mounted.sizes);
    expect(grownSize.cols).toBeGreaterThan(initialSize.cols);
    expect(grownSize.rows).toBeGreaterThan(initialSize.rows);
    expect(grownSize.shouldClaim).toBe(true);
  });

  it("keeps passive container measurements local after another client can claim", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    const initialSize = latestSize(mounted.sizes);
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";

    await waitFor({
      predicate: () =>
        mounted.sizes.some((size) => size.cols > initialSize.cols && size.rows > initialSize.rows),
    });

    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("keeps visual viewport keyboard refits passive", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    expect(window.visualViewport).not.toBeNull();
    window.visualViewport?.dispatchEvent(new Event("resize"));

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("keeps browser window refits passive", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    window.dispatchEvent(new Event("resize"));

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("does not force-claim a same-size resize while forwarding ordinary terminal input", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    const sizeCount = mounted.sizes.length;
    const sizeBeforeInput = latestSize(mounted.sizes);
    const terminal = getBrowserTerminal();

    terminal.input("a", true);

    await waitFor({ predicate: () => mounted.inputs.length > 0 });

    expect(mounted.inputs.at(-1)).toBe("a");
    expectNoForcedSameSizeClaim({
      sizes: mounted.sizes,
      startIndex: sizeCount,
      baseline: sizeBeforeInput,
    });
  });

  it("pastes through xterm's input producer", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    mounted.runtime.paste("legacy renderer paste");

    await waitFor({ predicate: () => mounted.inputs.length > 0 });
    expect(mounted.inputs).toEqual(["legacy renderer paste"]);
  });

  it("refreshes visible rows on a forced same-size resize", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    const terminal = getBrowserTerminal();
    const refreshCalls: Array<[number, number]> = [];
    const originalRefresh = terminal.refresh.bind(terminal);
    terminal.refresh = (start, end) => {
      refreshCalls.push([start, end]);
      originalRefresh(start, end);
    };

    mounted.runtime.resize({ forceRefresh: true, shouldClaim: false });

    await waitFor({ predicate: () => refreshCalls.length > 0 });
    expect(refreshCalls.at(-1)).toEqual([0, terminal.rows - 1]);
  });

  it("intercepts Shift+Enter only after enhanced terminal input mode is active", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([]);

    mounted.runtime.write({ data: terminalOutput("\x1b[>7u") });
    await waitFor({
      predicate: () =>
        mounted.inputModeChanges.some(
          (state) => state.kittyKeyboardFlags === 7 && !state.win32InputMode,
        ),
    });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);

    mounted.terminalKeys.length = 0;
    mounted.runtime.write({ data: terminalOutput("\x1b[=0;0u\x1b[?9001h") });
    await waitFor({
      predicate: () =>
        mounted.inputModeChanges.some(
          (state) => state.kittyKeyboardFlags === 0 && state.win32InputMode,
        ),
    });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);

    const sizeCount = mounted.sizes.length;
    const sizeBeforeKey = latestSize(mounted.sizes);
    mounted.terminalKeys.length = 0;

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);
    expectNoForcedSameSizeClaim({
      sizes: mounted.sizes,
      startIndex: sizeCount,
      baseline: sizeBeforeKey,
    });
  });

  it.each([
    { name: "DA1", bytes: "\x1b[c" },
    { name: "DA1-zero", bytes: "\x1b[0c" },
    { name: "DA2", bytes: "\x1b[>c" },
    { name: "DA3", bytes: "\x1b[=c" },
    { name: "XTVERSION", bytes: "\x1b[>q" },
    { name: "DSR-5", bytes: "\x1b[5n" },
    { name: "DSR-6", bytes: "\x1b[6n" },
    { name: "DSR-?6", bytes: "\x1b[?6n" },
    { name: "DECRQM", bytes: "\x1b[1$p" },
    { name: "DECRQM-?", bytes: "\x1b[?1$p" },
    { name: "DECRQSS", bytes: "\x1bP$qm\x1b\\" },
    { name: "OSC-10-foreground-color", bytes: "\x1b]10;?\x07" },
    { name: "OSC-11-background-color", bytes: "\x1b]11;?\x07" },
    { name: "OSC-12-cursor-color", bytes: "\x1b]12;?\x07" },
  ])("does not emit a PTY input reply for $name", async ({ bytes }) => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    mounted.runtime.write({ data: terminalOutput(bytes) });
    await nextFrame();
    await nextFrame();

    expect(mounted.inputs).toEqual([]);
  });

  it("keeps what the user types, but not pastes, while a replay is still parsing", async () => {
    const mounted = createTerminalHost({ width: 720, height: 360 });
    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    mounted.runtime.clear();
    mounted.runtime.replay({ type: "begin" });
    mounted.runtime.replay({ type: "data", data: terminalOutput("\x1b]4;1;?\x07restored") });
    mounted.runtime.replay({ type: "end" });

    typeText(mounted, "a");
    pasteText(mounted, "echo one\necho two\n");
    typeText(mounted, "f");
    await new Promise<void>((resolve) =>
      mounted.runtime.write({ data: terminalOutput("live"), onCommitted: resolve }),
    );

    expect(mounted.inputs).toEqual(["a", "f"]);
  });

  it("replays snapshots without synchronously resetting the visible terminal", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    const terminal = getBrowserTerminal();
    const originalReset = terminal.reset.bind(terminal);
    const reset = vi.fn(originalReset);
    terminal.reset = reset;

    mounted.runtime.replay({ type: "begin", rows: terminal.rows, cols: terminal.cols });
    mounted.runtime.replay({ type: "data", data: terminalOutput("prompt") });
    mounted.runtime.replay({ type: "end" });
    expect(reset).not.toHaveBeenCalled();
    await nextFrame();
  });

  it("opens OSC 8 hyperlinks the same way as plain-text URLs", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    await writeLines(mounted, [
      hyperlink({ url: "https://example.com/osc8", text: "example" }),
      "https://example.com/plain",
    ]);

    await clickTerminalLink({ host: mounted.host, row: 1, col: 4 });
    await clickTerminalLink({ host: mounted.host, row: 0, col: 2 });

    expect(mounted.openedUrls).toEqual(["https://example.com/plain", "https://example.com/osc8"]);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("incremental replay lifecycle", () => {
  it.each(["clear", "remount"] as const)(
    "recovers live input after interrupted replay and %s",
    async (cleanup) => {
      const mounted = createTerminalHost({ width: 720, height: 360 });
      mounted.runtime.replay({ type: "begin", rows: 30, cols: 120 });
      mounted.root.style.width = "360px";
      mounted.runtime.resize({ shouldClaim: false });
      mounted.runtime.replay({ type: "data", data: terminalOutput("interrupted") });
      if (cleanup === "clear")
        await new Promise<void>((resolve) => mounted.runtime.clear({ onCommitted: resolve }));
      else {
        mounted.runtime.unmount();
        mounted.runtime.mount({
          root: mounted.root,
          host: mounted.host,
          scrollback: 1000,
          theme: {},
        });
      }
      await new Promise<void>((resolve) =>
        mounted.runtime.write({ data: terminalOutput("live"), onCommitted: resolve }),
      );
      getBrowserTerminal().input("user-input", true);
      expect(mounted.inputs).toContain("user-input");
      expect(getBrowserTerminal().cols).toBeLessThan(60);
    },
  );

  it("suppresses generated replies until queued replay chunks commit after end", async () => {
    const mounted = createTerminalHost({ width: 720, height: 360 });
    mounted.runtime.replay({ type: "begin" });
    mounted.runtime.replay({ type: "data", data: terminalOutput("\x1b]4;1;?\x07") });
    mounted.runtime.replay({ type: "data", data: terminalOutput("\x1b]4;1;?\x07") });
    mounted.runtime.replay({ type: "end" });
    await new Promise<void>((resolve) =>
      mounted.runtime.write({ data: terminalOutput("committed"), onCommitted: resolve }),
    );
    expect(mounted.inputs).toEqual([]);
    await new Promise<void>((resolve) =>
      mounted.runtime.write({ data: terminalOutput("\x1b]4;1;?\x07"), onCommitted: resolve }),
    );
    expect(mounted.inputs).toHaveLength(1);
    expect(mounted.inputs[0]?.startsWith("\x1b]4;1;rgb:")).toBe(true);
  });
});

it("restores fitted web geometry after replay before live output", async () => {
  const mounted = createTerminalHost({ width: 720, height: 360 });
  await settleMountRefits();
  const local = latestSize(mounted.sizes);
  mounted.runtime.replay({ type: "begin", rows: 30, cols: 120 });
  mounted.runtime.replay({ type: "data", data: terminalOutput("x".repeat(100)) });
  mounted.runtime.replay({ type: "end" });
  await new Promise<void>((resolve) =>
    mounted.runtime.write({ data: terminalOutput("LIVE"), onCommitted: resolve }),
  );
  expect(getBrowserTerminal().cols).toBe(latestSize(mounted.sizes).cols);
  expect(getBrowserTerminal().cols).toBeLessThan(120);
  expect(getBrowserTerminal().rows).toBe(local.rows);
  mounted.runtime.resize({ forceClaim: true, shouldClaim: true });
  expect(getBrowserTerminal().cols).toBe(latestSize(mounted.sizes).cols);
});

it("defers layout fit until all replay chunks commit", async () => {
  const mounted = createTerminalHost({ width: 720, height: 360 });
  await settleMountRefits();
  mounted.runtime.replay({ type: "begin", rows: 30, cols: 120 });
  await new Promise<void>((resolve) =>
    mounted.runtime.write({
      data: terminalOutput("first"),
      suppressInput: true,
      onCommitted: resolve,
    }),
  );
  expect(getBrowserTerminal().cols).toBe(120);
  mounted.root.style.width = "360px";
  mounted.runtime.resize({ shouldClaim: true, forceClaim: true, forceRefresh: true });
  await nextFrame();
  expect(getBrowserTerminal().cols).toBe(120);
  mounted.runtime.replay({ type: "data", data: terminalOutput("\x1b[2;110Hsecond") });
  mounted.runtime.replay({ type: "end" });
  await new Promise<void>((resolve) =>
    mounted.runtime.write({ data: terminalOutput("LIVE"), onCommitted: resolve }),
  );
  expect(getBrowserTerminal().cols).toBe(latestSize(mounted.sizes).cols);
  expect(getBrowserTerminal().cols).toBeLessThan(60);
  expect(latestSize(mounted.sizes)).toMatchObject({ shouldClaim: true, forceClaim: true });
  mounted.runtime.resize({ shouldClaim: true, forceClaim: true });
  expect(getBrowserTerminal().cols).toBe(latestSize(mounted.sizes).cols);
});
