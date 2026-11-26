import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readClaudeTranscriptTimelineMarker } from "./transcript-history.js";

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

/** What Claude Code appends when a resumed session starts or exits without a message. */
const bookkeeping = [
  line({ type: "tools-used", tools: ["Bash"], sessionId: "s" }),
  line({ type: "mode", mode: "normal", sessionId: "s" }),
  line({ type: "cost-state", sessionId: "s", totalCostUSD: 0, totalDuration: 975 }),
].join("");

describe("Claude transcript timeline marker", () => {
  let root: string;
  let transcript: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "claude-marker-"));
    transcript = path.join(root, "session.jsonl");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("ignores bookkeeping and moves with every timeline record", async () => {
    writeFileSync(
      transcript,
      line({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }) +
        line({
          type: "assistant",
          uuid: "a1",
          message: { content: [{ type: "text", text: "yo" }] },
        }),
    );
    const marker = await readClaudeTranscriptTimelineMarker(transcript);
    expect(marker).toMatch(/:a1$/);

    appendFileSync(transcript, bookkeeping);
    expect(await readClaudeTranscriptTimelineMarker(transcript)).toBe(marker);

    appendFileSync(transcript, line({ type: "user", uuid: "u2", message: { content: "next" } }));
    expect(await readClaudeTranscriptTimelineMarker(transcript)).toMatch(/:u2$/);
  });

  test("reads a final record larger than one read chunk", async () => {
    writeFileSync(
      transcript,
      line({ type: "user", uuid: "u1", message: { content: "x".repeat(700 * 1024) } }) +
        bookkeeping,
    );
    expect(await readClaudeTranscriptTimelineMarker(transcript)).toMatch(/:u1$/);
  });

  test("a missing transcript has no marker", async () => {
    expect(await readClaudeTranscriptTimelineMarker(transcript)).toBeNull();
  });
});
