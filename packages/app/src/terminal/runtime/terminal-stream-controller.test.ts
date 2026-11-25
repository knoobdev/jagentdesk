import { describe, expect, it } from "vitest";

import {
  TerminalStreamController,
  type TerminalStreamControllerClient,
  type TerminalStreamControllerStatus,
} from "./terminal-stream-controller";

function terminalOutput(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

type TerminalStreamEvent = import("@jagentdesk/client/internal/daemon-client").TerminalStreamEvent;

class FakeTerminalStreamClient implements TerminalStreamControllerClient {
  private readonly listeners = new Set<(event: TerminalStreamEvent) => void>();
  public subscribeCalls: Array<{ terminalId: string; options?: unknown }> = [];
  public unsubscribeCalls: string[] = [];
  public resizeCalls: Array<{
    terminalId: string;
    rows: number;
    cols: number;
    intent?: "claim" | "update";
  }> = [];
  public nextSubscribeResults: Array<{ terminalId: string; error?: string | null }> = [];

  async subscribeTerminal(terminalId: string, options?: unknown) {
    this.subscribeCalls.push({ terminalId, ...(options ? { options } : {}) });
    const result = this.nextSubscribeResults.shift();
    if (!result) {
      throw new Error("Missing fake subscribe result");
    }
    return result;
  }

  unsubscribeTerminal(terminalId: string): void {
    this.unsubscribeCalls.push(terminalId);
  }

  sendTerminalInput(
    terminalId: string,
    message: { type: "resize"; rows: number; cols: number; intent?: "claim" | "update" },
  ): void {
    this.resizeCalls.push({
      terminalId,
      rows: message.rows,
      cols: message.cols,
      ...(message.intent ? { intent: message.intent } : {}),
    });
  }

  onTerminalStreamEvent(handler: (event: TerminalStreamEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  emit(event: TerminalStreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function createHarness(input?: { client?: FakeTerminalStreamClient }) {
  const client = input?.client ?? new FakeTerminalStreamClient();
  const outputs: Array<{ terminalId: string; data: Uint8Array }> = [];
  const replays: import("@jagentdesk/client").TerminalReplayEvent[] = [];
  const statuses: TerminalStreamControllerStatus[] = [];
  const controller = new TerminalStreamController({
    client,
    getPreferredSize: () => ({ rows: 24, cols: 80 }),
    onOutput: (output) => {
      outputs.push(output);
    },
    onReplay: ({ replay }) => replays.push(replay),
    onStatusChange: (status) => {
      statuses.push(status);
    },
  });

  return { client, controller, outputs, replays, statuses };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("terminal-stream-controller", () => {
  it("subscribes, resizes, and forwards snapshot/output events", async () => {
    const harness = createHarness();
    harness.client.nextSubscribeResults.push({ terminalId: "term-1", error: null });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();

    harness.client.emit({
      terminalId: "term-1",
      type: "replay",
      replay: { type: "data", data: terminalOutput("hello") },
    });
    const outputData = terminalOutput(" world");
    harness.client.emit({
      terminalId: "term-1",
      type: "output",
      data: outputData,
    });

    expect(harness.client.subscribeCalls).toEqual([{ terminalId: "term-1" }]);
    expect(harness.client.resizeCalls).toEqual([
      { terminalId: "term-1", rows: 24, cols: 80, intent: "claim" },
    ]);
    expect(harness.replays).toEqual([{ type: "data", data: terminalOutput("hello") }]);
    expect(harness.outputs[0]?.data).toBe(outputData);
    expect(harness.outputs).toEqual([{ terminalId: "term-1", data: terminalOutput(" world") }]);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: "term-1",
      isAttaching: false,
      error: null,
    });
  });

  it("surfaces subscribe failures without retrying", async () => {
    const harness = createHarness();
    harness.client.nextSubscribeResults.push({
      terminalId: "term-1",
      error: "network disconnected",
    });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();

    expect(harness.client.subscribeCalls).toEqual([{ terminalId: "term-1" }]);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: "term-1",
      isAttaching: false,
      error: "network disconnected",
    });
  });

  it("treats terminal exit as final and does not reconnect", async () => {
    const harness = createHarness();
    harness.client.nextSubscribeResults.push({ terminalId: "term-1", error: null });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();
    harness.controller.handleTerminalExit({ terminalId: "term-1" });
    await flushAsyncWork();

    expect(harness.client.subscribeCalls).toEqual([{ terminalId: "term-1" }]);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: "term-1",
      isAttaching: false,
      error: "Terminal exited",
    });
  });

  it("requests configured restore options and forwards restore output", async () => {
    const client = new FakeTerminalStreamClient();
    const harness = createHarness({ client });
    client.nextSubscribeResults.push({ terminalId: "term-1", error: null });
    const controller = new TerminalStreamController({
      client,
      getPreferredSize: () => ({ rows: 24, cols: 80 }),
      getRestoreOptions: () => ({
        mode: "visible-snapshot",
        scrollbackLines: 200,
        size: { rows: 24, cols: 80 },
      }),
      onOutput: (output) => harness.outputs.push(output),
      onReplay: ({ replay }) => harness.replays.push(replay),
    });

    controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();
    const restoreData = terminalOutput("restored");
    client.emit({
      terminalId: "term-1",
      type: "replay",
      replay: { type: "data", data: restoreData },
    });
    controller.dispose();

    expect(client.subscribeCalls).toEqual([
      {
        terminalId: "term-1",
        options: {
          restore: {
            mode: "visible-snapshot",
            scrollbackLines: 200,
            size: { rows: 24, cols: 80 },
          },
        },
      },
    ]);
    expect(client.resizeCalls).toEqual([]);
    expect(harness.replays).toEqual([{ type: "data", data: restoreData }]);
    expect(harness.outputs).toEqual([]);
  });

  it("unsubscribes when switching terminals and on dispose", async () => {
    const harness = createHarness();
    harness.client.nextSubscribeResults.push({ terminalId: "term-1", error: null });
    harness.client.nextSubscribeResults.push({ terminalId: "term-2", error: null });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();
    harness.controller.setTerminal({ terminalId: "term-2" });
    await flushAsyncWork();
    harness.controller.dispose();

    expect(harness.client.unsubscribeCalls).toEqual(["term-1", "term-2"]);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: null,
      isAttaching: false,
      error: null,
    });
  });
});
