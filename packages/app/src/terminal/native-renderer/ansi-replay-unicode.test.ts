import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { SerializeAddon } from "@xterm/addon-serialize";
import { createNativeHeadlessTerminal, type TerminalCellRow } from "./headless-terminal-state";
import { createNativeTerminalOutputDrain } from "./headless-terminal-output-drain";

function rowText(row: TerminalCellRow): string {
  return row
    .filter((cell) => cell.width !== 0)
    .map((cell) => cell.char)
    .join("")
    .trimEnd();
}

describe("native ANSI replay with grapheme widths", () => {
  it("preserves CJK and emoji columns across split UTF-8 replay and live output", async () => {
    const source = new Terminal({ rows: 4, cols: 80, allowProposedApi: true });
    source.loadAddon(new UnicodeGraphemesAddon());
    const serializer = new SerializeAddon();
    source.loadAddon(serializer);
    const native = createNativeHeadlessTerminal({ rows: 4, cols: 80 });
    const drain = createNativeTerminalOutputDrain({
      write: (chunk) => native.write(chunk),
      reset: (size) => {
        native.reset();
        if (size) native.resize(size);
      },
      restoreSize: () => native.resize({ rows: 4, cols: 80 }),
      getViewportState: () => native.getViewportState(),
      onPaint: () => {},
    });
    try {
      const lines = ["你好世界 日本語 한글", "A😀B❤️C👋🏽D👨‍👩‍👧E"];
      await new Promise<void>((resolve) => source.write(lines.join("\r\n"), resolve));
      const bytes = new TextEncoder().encode(serializer.serialize());
      for (let replay = 0; replay < 2; replay++) {
        drain.replay({ type: "begin", rows: 4, cols: 80 });
        // One-byte chunks exercise every UTF-8 and grapheme boundary.
        for (const byte of bytes) drain.replay({ type: "data", data: new Uint8Array([byte]) });
        drain.replay({ type: "end" });
        drain.enqueueText("!");
        await drain.flush();
        const state = native.getViewportState();
        expect(native.getBufferWindow({ startRow: 0, rowCount: 2 }).rows.map(rowText)).toEqual([
          lines[0],
          lines[1] + "!",
        ]);
        expect(state.grid[1][12].char).toBe("E");
        expect(state.cursor).toEqual({ row: 1, col: 14 });
      }
    } finally {
      drain.dispose();
      native.dispose();
      source.dispose();
    }
  });
});
