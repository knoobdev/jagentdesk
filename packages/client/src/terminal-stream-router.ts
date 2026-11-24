import {
  TerminalReplayMetadataSchema,
  encodeTerminalResizePayload,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "@jagentdesk/protocol/binary-frames/index";
import type { TerminalInput } from "@jagentdesk/protocol/messages";

export type TerminalReplayEvent =
  | { type: "begin"; rows?: number; cols?: number; retainedHistoryLines?: number }
  | { type: "data"; data: Uint8Array }
  | { type: "end" };

export type TerminalStreamEvent = { terminalId: string } & (
  | { type: "output"; data: Uint8Array }
  | { type: "replay"; replay: TerminalReplayEvent }
);

export class TerminalStreamRouter {
  private readonly terminalSlots = new Map<string, number>();
  private readonly slotTerminals = new Map<number, string>();
  private readonly listeners = new Set<(event: TerminalStreamEvent) => void>();

  onEvent(handler: (event: TerminalStreamEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  setSlot(terminalId: string, slot: number): void {
    const existingTerminalId = this.slotTerminals.get(slot);
    if (existingTerminalId && existingTerminalId !== terminalId) {
      this.terminalSlots.delete(existingTerminalId);
    }

    const existingSlot = this.terminalSlots.get(terminalId);
    if (typeof existingSlot === "number" && existingSlot !== slot) {
      this.slotTerminals.delete(existingSlot);
    }

    this.terminalSlots.set(terminalId, slot);
    this.slotTerminals.set(slot, terminalId);
  }

  removeTerminal(terminalId: string): void {
    const slot = this.terminalSlots.get(terminalId);
    if (typeof slot !== "number") {
      return;
    }
    this.terminalSlots.delete(terminalId);
    if (this.slotTerminals.get(slot) === terminalId) {
      this.slotTerminals.delete(slot);
    }
  }

  clearSlots(): void {
    this.terminalSlots.clear();
    this.slotTerminals.clear();
  }

  encodeInput(terminalId: string, message: TerminalInput["message"]): Uint8Array | null {
    const slot = this.terminalSlots.get(terminalId);
    if (typeof slot !== "number") {
      return null;
    }

    if (message.type === "input") {
      return encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Input,
        slot,
        payload: message.data,
      });
    }

    if (message.type === "resize") {
      return encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Resize,
        slot,
        payload: encodeTerminalResizePayload({
          rows: message.rows,
          cols: message.cols,
          ...(message.intent ? { intent: message.intent } : {}),
        }),
      });
    }

    return null;
  }

  handleFrame(frame: TerminalStreamFrame): void {
    const terminalId = this.slotTerminals.get(frame.slot);
    if (!terminalId) {
      return;
    }

    if (frame.opcode === TerminalStreamOpcode.Output) {
      this.emit({
        terminalId,
        type: "output",
        data: frame.payload,
      });
      return;
    }

    if (frame.opcode === TerminalStreamOpcode.Restore) {
      // COMPAT(terminalSingleRestore): ADR-0051, keep accepting released hosts' ANSI restore.
      for (const replay of [
        { type: "begin" },
        { type: "data", data: frame.payload },
        { type: "end" },
      ] as TerminalReplayEvent[]) {
        this.emit({ terminalId, type: "replay", replay });
      }
    } else if (frame.opcode === TerminalStreamOpcode.ReplayBegin) {
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(frame.payload));
      } catch {
        return;
      }
      const parsed = TerminalReplayMetadataSchema.safeParse(raw);
      if (parsed.success)
        this.emit({ terminalId, type: "replay", replay: { type: "begin", ...parsed.data } });
    } else if (frame.opcode === TerminalStreamOpcode.ReplayData) {
      this.emit({ terminalId, type: "replay", replay: { type: "data", data: frame.payload } });
    } else if (frame.opcode === TerminalStreamOpcode.ReplayEnd) {
      this.emit({ terminalId, type: "replay", replay: { type: "end" } });
    }
  }

  private emit(event: TerminalStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // no-op
      }
    }
  }
}
