import type { JAgentDeskAgentBackgroundWorkOutput } from "@jagentdesk/client";

/** What "Copy output" keeps; the daemon never sends more than its 256 KiB tail at once. */
const KEEP_CHARS = 1024 * 1024;

export interface BackgroundWorkOutputBuffer {
  /** The output as written by the task, for Copy output. */
  text: string;
  /** Byte offset the next chunk should start at; null before the first chunk. */
  nextOffset: number | null;
}

export const EMPTY_OUTPUT_BUFFER: BackgroundWorkOutputBuffer = { text: "", nextOffset: null };

/** What the terminal should do with one push. */
export interface BackgroundWorkOutputWrite {
  /** Clear the terminal before writing. */
  reset: boolean;
  /** Terminal-ready text: newlines become CRLF because the output never went through a PTY. */
  data: string;
}

/**
 * Folds one output push into the buffer. A chunk that starts past the expected offset means the
 * daemon skipped output to keep up; the terminal gets a marker line so the gap is visible.
 */
export function applyOutputChunk(
  buffer: BackgroundWorkOutputBuffer,
  push: Pick<JAgentDeskAgentBackgroundWorkOutput, "chunk" | "offset" | "nextOffset" | "reset">,
  skippedLabel: string,
): { buffer: BackgroundWorkOutputBuffer; write: BackgroundWorkOutputWrite } {
  const reset = push.reset === true || buffer.nextOffset === null;
  const skipped = !reset && buffer.nextOffset !== null && push.offset > buffer.nextOffset;
  const marker = skipped ? `\n[${skippedLabel}]\n` : "";
  const text = (reset ? "" : buffer.text) + marker + push.chunk;
  return {
    buffer: {
      text: text.length > KEEP_CHARS ? text.slice(text.length - KEEP_CHARS) : text,
      nextOffset: push.nextOffset ?? push.offset + utf8Length(push.chunk),
    },
    write: {
      reset,
      data:
        (skipped ? `\r\n\u001b[2m[${skippedLabel}]\u001b[0m\r\n` : "") + toTerminalText(push.chunk),
    },
  };
}

/** Lone LF moves down without returning to column 0 in a terminal; the file has no PTY. */
export function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
