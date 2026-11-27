import { describe, expect, test } from "vitest";
import { applyOutputChunk, EMPTY_OUTPUT_BUFFER, toTerminalText } from "./output-buffer";

const SKIPPED = "earlier output skipped";

describe("applyOutputChunk", () => {
  test("the first push resets the terminal and turns LF into CRLF", () => {
    const { buffer, write } = applyOutputChunk(
      EMPTY_OUTPUT_BUFFER,
      { chunk: "line-1\nline-2\n", offset: 0, nextOffset: 14, reset: true },
      SKIPPED,
    );
    expect(write).toEqual({ reset: true, data: "line-1\r\nline-2\r\n" });
    expect(buffer).toEqual({ text: "line-1\nline-2\n", nextOffset: 14 });
  });

  test("appends a contiguous push and keeps ANSI colours", () => {
    const first = applyOutputChunk(
      EMPTY_OUTPUT_BUFFER,
      { chunk: "a\n", offset: 0, nextOffset: 2, reset: true },
      SKIPPED,
    );
    const { buffer, write } = applyOutputChunk(
      first.buffer,
      { chunk: "\u001b[31mred\u001b[0m\n", offset: 2, nextOffset: 15 },
      SKIPPED,
    );
    expect(write).toEqual({ reset: false, data: "\u001b[31mred\u001b[0m\r\n" });
    expect(buffer.text).toBe("a\n\u001b[31mred\u001b[0m\n");
  });

  test("marks output the daemon skipped to keep up", () => {
    const first = applyOutputChunk(
      EMPTY_OUTPUT_BUFFER,
      { chunk: "a\n", offset: 0, nextOffset: 2, reset: true },
      SKIPPED,
    );
    const { buffer, write } = applyOutputChunk(
      first.buffer,
      { chunk: "z\n", offset: 900, nextOffset: 902 },
      SKIPPED,
    );
    expect(write.reset).toBe(false);
    expect(write.data).toContain(SKIPPED);
    expect(write.data.endsWith("z\r\n")).toBe(true);
    expect(buffer.text).toBe(`a\n\n[${SKIPPED}]\nz\n`);
    expect(buffer.nextOffset).toBe(902);
  });

  test("a restart after reconnect replaces what was there", () => {
    const first = applyOutputChunk(
      EMPTY_OUTPUT_BUFFER,
      { chunk: "old\n", offset: 0, nextOffset: 4, reset: true },
      SKIPPED,
    );
    const { buffer, write } = applyOutputChunk(
      first.buffer,
      { chunk: "tail\n", offset: 100, nextOffset: 105, reset: true },
      SKIPPED,
    );
    expect(write).toEqual({ reset: true, data: "tail\r\n" });
    expect(buffer.text).toBe("tail\n");
  });

  test("derives the next offset from the UTF-8 length when the daemon omits it", () => {
    const { buffer } = applyOutputChunk(
      EMPTY_OUTPUT_BUFFER,
      { chunk: "€\n", offset: 10, reset: true },
      SKIPPED,
    );
    expect(buffer.nextOffset).toBe(14);
  });
});

test("toTerminalText keeps existing CRLF", () => {
  expect(toTerminalText("a\r\nb\nc")).toBe("a\r\nb\r\nc");
});
