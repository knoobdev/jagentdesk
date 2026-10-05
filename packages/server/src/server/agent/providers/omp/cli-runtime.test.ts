import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { OmpCliRuntime } from "./cli-runtime.js";
import type { OmpRuntimeLaunch } from "./runtime.js";

type OmpChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killedSignals: Array<NodeJS.Signals | number | undefined>;
};

function createOmpChild(): OmpChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killedSignals: [],
  }) as OmpChild;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killedSignals.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal ?? null));
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  // Real OMP writes a `ready` frame immediately after launch; the runtime waits
  // for it before negotiating the RPC protocol. Advertise v1 only so the session
  // stays on protocol v1 and command streams are unaffected.
  child.stdout.write(
    `${JSON.stringify({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1],
      maxFrameBytes: 1024 * 1024,
      maxReassembledFrameBytes: 64 * 1024 * 1024,
    })}\n`,
  );
  return child;
}

function createRuntime(
  child: OmpChild,
  launches: OmpRuntimeLaunch[] = [],
  options?: { requestTimeoutMs?: number },
): OmpCliRuntime {
  return new OmpCliRuntime({
    logger: pino({ level: "silent" }),
    command: ["omp"],
    commandsRpcName: "get_available_commands",
    requestTimeoutMs: options?.requestTimeoutMs,
    spawnProcess: (launch) => {
      launches.push(launch);
      return child;
    },
  });
}

function onOmpCommand(child: OmpChild, handler: (command: Record<string, unknown>) => void): void {
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handler(JSON.parse(line) as Record<string, unknown>);
    }
  });
}

function replyToCommands(
  child: OmpChild,
  handler: (command: Record<string, unknown>) => unknown,
): void {
  onOmpCommand(child, (command) => {
    const result = handler(command);
    child.stdout.write(
      `${JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: result,
      })}\n`,
    );
  });
}

function capturePendingCommand(child: OmpChild, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    onOmpCommand(child, (command) => {
      if (command.type === type) resolve(command);
    });
  });
}

/** Kill the child the moment it receives `type`, so the request is in flight when it dies. */
function exitOnCommand(child: OmpChild, type: string): void {
  onOmpCommand(child, (command) => {
    if (command.type === type) {
      child.emit("exit", 1, null);
    }
  });
}

function withoutRequestId(command: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = command;
  return rest;
}

describe("OMP CLI runtime", () => {
  test("steer waits for OMP's response and surfaces rejection", async () => {
    const child = createOmpChild();
    let pending: Record<string, unknown> | null = null;
    onOmpCommand(child, (command) => {
      if (command.type === "steer") pending = command;
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const result = session.steer("change direction");
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending).toMatchObject({ type: "steer", message: "change direction" });
    child.stdout.write(
      `${JSON.stringify({ id: pending!.id, type: "response", command: "steer", success: false, error: "rejected" })}\n`,
    );
    await expect(result).rejects.toThrow("rejected");
    await session.close();
  });
  test("uses the configured RPC timeout and attributes the pending phase", async () => {
    vi.useFakeTimers();
    const child = createOmpChild();
    const session = await createRuntime(child, [], { requestTimeoutMs: 100 }).startSession({
      cwd: "/workspace/project",
    });

    try {
      const state = session.getState();
      const rejection = expect(state).rejects.toThrow(
        "OMP RPC request timed out phase=get_state elapsedMs=100 timeoutMs=100",
      );
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  test("validates session state with the documented queued message count", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      model: null,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 3,
      queuedMessageCount: 1,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).resolves.toMatchObject({
      sessionId: "session-1",
      messageCount: 3,
      queuedMessageCount: 1,
    });
  });

  test("accepts session state without thinkingLevel for non-reasoning models", async () => {
    const child = createOmpChild();
    // Models like cursor-grok-4.5-high-fast encode effort in the model ID, so
    // OMP marks them reasoning: false and omits thinkingLevel from get_state.
    replyToCommands(child, () => ({
      model: null,
      isStreaming: false,
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 0,
      queuedMessageCount: 0,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).resolves.toMatchObject({ sessionId: "session-1" });
  });

  test("rejects malformed RPC results instead of trusting transport data", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      thinkingLevel: "medium",
      isStreaming: "no",
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 0,
      queuedMessageCount: 0,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).rejects.toThrow();
  });

  test("emits validated known events and drops unknown frames", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const eventTypes: string[] = [];
    session.onEvent((event) => eventTypes.push(event.type));

    child.stdout.write(`${JSON.stringify({ type: "future_control", enabled: true })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "notice", level: "info", message: "ready" })}\n`);

    expect(eventTypes).toEqual(["notice"]);
  });

  test("emits agent_end for a run that contains an OMP developer message", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const eventTypes: string[] = [];
    session.onEvent((event) => eventTypes.push(event.type));

    // OMP 18.5 injects a developer reminder mid-run when a tool call matches a rule.
    const reminder = {
      role: "developer",
      content: [
        { type: "text", text: '<system-reminder reason="rule_violation">…</system-reminder>' },
      ],
      attribution: "agent",
      timestamp: 2,
    };
    child.stdout.write(`${JSON.stringify({ type: "message_end", message: reminder })}\n`);
    child.stdout.write(
      `${JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "Write tiny.ts" }], timestamp: 1 },
          reminder,
          {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            stopReason: "stop",
            timestamp: 3,
          },
        ],
      })}\n`,
    );

    expect(eventTypes).toEqual(["message_end", "agent_end"]);
  });

  test("emits agent_end for a run that contains every OMP message role JAgentDesk does not render", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const eventTypes: string[] = [];
    session.onEvent((event) => eventTypes.push(event.type));

    // A prompt that @-mentions a file makes OMP add a fileMention message to the run.
    const fileMention = {
      role: "fileMention",
      files: [{ path: "notes.md", content: "# Notes\n", lineCount: 1 }],
      timestamp: 2,
    };
    child.stdout.write(`${JSON.stringify({ type: "message_end", message: fileMention })}\n`);
    child.stdout.write(
      `${JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "Read @notes.md" }], timestamp: 1 },
          fileMention,
          {
            role: "pythonExecution",
            code: "print(1)",
            output: "1\n",
            cancelled: false,
            truncated: false,
            timestamp: 3,
          },
          {
            role: "hookMessage",
            customType: "hook",
            content: "hook output",
            display: false,
            timestamp: 4,
          },
          { role: "branchSummary", summary: "Earlier branch", fromId: "entry-1", timestamp: 5 },
          {
            role: "compactionSummary",
            summary: "Earlier turns",
            tokensBefore: 1000,
            timestamp: 6,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            stopReason: "stop",
            timestamp: 7,
          },
        ],
      })}\n`,
    );

    expect(eventTypes).toEqual(["message_end", "agent_end"]);
  });

  test("lists commands through get_available_commands", async () => {
    const child = createOmpChild();
    const commandTypes: string[] = [];
    replyToCommands(child, (command) => {
      commandTypes.push(String(command.type));
      return {
        commands: [
          { name: "prewalk", description: "Prewalk at the next action", source: "builtin" },
        ],
      };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getCommands()).resolves.toEqual([
      {
        name: "prewalk",
        description: "Prewalk at the next action",
        source: "builtin",
      },
    ]);
    expect(commandTypes).toEqual(["get_available_commands"]);
  });

  test("accepts model catalogs with null maxTokens from newer OMP binaries", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      models: [
        {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          name: "gpt-5.6-sol",
          maxTokens: null,
        },
      ],
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        maxTokens: null,
      }),
    ]);
  });

  test("accepts model catalogs with null contextWindow from NVIDIA", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      models: [
        {
          provider: "nvidia",
          id: "minimaxai/minimax-m3",
          name: "MiniMax-M3",
          contextWindow: null,
        },
        {
          provider: "zai",
          id: "glm-5.2",
          name: "GLM-5.2",
          contextWindow: 131_072,
        },
      ],
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({
        provider: "nvidia",
        id: "minimaxai/minimax-m3",
        contextWindow: null,
      }),
      expect.objectContaining({
        provider: "zai",
        id: "glm-5.2",
        contextWindow: 131_072,
      }),
    ]);
  });

  test("wraps OMP subagent RPC commands", async () => {
    const child = createOmpChild();
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      return undefined;
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await session.setSubagentSubscription("events");

    expect(commands.map(withoutRequestId)).toEqual([
      { type: "set_subagent_subscription", level: "events" },
    ]);
  });

  test("compact waits beyond the control-plane timeout for a late response", async () => {
    vi.useFakeTimers();
    const child = createOmpChild();
    const pending = capturePendingCommand(child, "compact");
    const session = await createRuntime(child, [], { requestTimeoutMs: 100 }).startSession({
      cwd: "/workspace/project",
    });
    try {
      const compact = session.compact("focus on tests");
      const command = await pending;
      await vi.advanceTimersByTimeAsync(101);
      child.stdout.write(
        `${JSON.stringify({ id: command.id, type: "response", command: "compact", success: true, data: {} })}\n`,
      );
      await expect(compact).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  test("accepts the empty prompt acknowledgement emitted by OMP 17", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => undefined);
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.prompt("hello")).resolves.toEqual({ requestId: "req_1" });
  });

  test("reports OMP 18.3's late prompt rejection as a failed prompt result", async () => {
    const child = createOmpChild();
    onOmpCommand(child, (command) => {
      if (command.type !== "prompt") return;
      const response = { id: command.id, type: "response", command: "prompt" };
      const rejection = { ...response, success: false, error: "No API key found for anthropic." };
      child.stdout.write(
        `${JSON.stringify({ ...response, success: true })}\n${JSON.stringify(rejection)}\n`,
      );
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    await expect(session.prompt("hello")).resolves.toEqual({ requestId: "req_1" });

    expect(events).toContainEqual({
      type: "prompt_result",
      id: "req_1",
      agentInvoked: false,
      status: "error",
      error: { message: "No API key found for anthropic." },
    });
  });

  // A dead runtime owns no turn, so aborting it is already satisfied. Rejecting here
  // makes AgentManager treat the interrupt as unacknowledged and refuse the stop, which
  // pins the agent at `running` until the daemon restarts. See issue #3749.
  test("abort resolves once the OMP process has exited", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    child.emit("exit", 1, null);

    await expect(session.abort()).resolves.toBeUndefined();
  });

  test("abort resolves when the OMP process exits while the abort is in flight", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    exitOnCommand(child, "abort");

    await expect(session.abort()).resolves.toBeUndefined();
  });
});
