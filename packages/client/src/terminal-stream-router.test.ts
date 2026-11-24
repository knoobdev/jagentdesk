import { TerminalStreamOpcode } from "@jagentdesk/protocol/binary-frames/index";
import { describe, expect, test } from "vitest";

import { TerminalStreamRouter, type TerminalStreamEvent } from "./terminal-stream-router.js";

describe("terminal-stream-router", () => {
  test("normalizes a single legacy Restore into replay events", () => {
    const router = new TerminalStreamRouter();
    const events: TerminalStreamEvent[] = [];
    const payload = new TextEncoder().encode("restored screen");

    router.setSlot("term-1", 7);
    router.onEvent((event) => events.push(event));
    router.handleFrame({
      opcode: TerminalStreamOpcode.Restore,
      slot: 7,
      payload,
    });

    expect(events).toEqual([
      { terminalId: "term-1", type: "replay", replay: { type: "begin" } },
      { terminalId: "term-1", type: "replay", replay: { type: "data", data: payload } },
      { terminalId: "term-1", type: "replay", replay: { type: "end" } },
    ]);
  });
  test("streams replay chunks without joining, and drops detached slots", () => {
    const router = new TerminalStreamRouter();
    const events: TerminalStreamEvent[] = [];
    router.setSlot("term-1", 7);
    router.onEvent((event) => events.push(event));
    const metadata = { rows: 24, cols: 80, retainedHistoryLines: 10000 };
    const data = new TextEncoder().encode("界🙂");
    router.handleFrame({
      opcode: TerminalStreamOpcode.ReplayBegin,
      slot: 7,
      payload: new TextEncoder().encode(JSON.stringify(metadata)),
    });
    router.handleFrame({
      opcode: TerminalStreamOpcode.ReplayData,
      slot: 7,
      payload: data.subarray(0, 4),
    });
    router.handleFrame({
      opcode: TerminalStreamOpcode.ReplayData,
      slot: 7,
      payload: data.subarray(4),
    });
    router.handleFrame({
      opcode: TerminalStreamOpcode.ReplayEnd,
      slot: 7,
      payload: new Uint8Array(),
    });
    expect(events).toEqual([
      { terminalId: "term-1", type: "replay", replay: { type: "begin", ...metadata } },
      { terminalId: "term-1", type: "replay", replay: { type: "data", data: data.subarray(0, 4) } },
      { terminalId: "term-1", type: "replay", replay: { type: "data", data: data.subarray(4) } },
      { terminalId: "term-1", type: "replay", replay: { type: "end" } },
    ]);
    router.removeTerminal("term-1");
    router.handleFrame({ opcode: TerminalStreamOpcode.ReplayData, slot: 7, payload: data });
    expect(events).toHaveLength(4);
  });
});
