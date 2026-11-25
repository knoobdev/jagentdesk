import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SshSnippetRun } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { resolveTerminalAppearance, terminalPaletteFor } from "./appearance";
import { SshRpcError, sshRequest, type SshRpcIo, type SshRpcRequest } from "./rpc-io";
import { applyRunEvent, tallyRun, targetOutcome } from "./run-state";
import { planSnippetWorkspace, snippetTerminalInput } from "./snippet-input";
import { computePaneRects, paneIds } from "./split-layout";
import { darkMidnightTheme } from "@/styles/theme";

describe("snippetTerminalInput", () => {
  it("presses Enter for run and leaves the last line at the prompt for paste", () => {
    expect(snippetTerminalInput("uname -a\n", "run")).toBe("uname -a\r");
    expect(snippetTerminalInput("cd /srv\r\nls\n", "run")).toBe("cd /srv\rls\r");
    expect(snippetTerminalInput("git pull", "paste")).toBe("git pull");
  });
});

describe("planSnippetWorkspace", () => {
  it("opens one pane per server, each typing the snippet", () => {
    const plan = planSnippetWorkspace({
      serverIds: ["srv_a", "srv_b", "srv_c", "srv_a"],
      labelsByServerId: { srv_a: "web-1", srv_b: "web-2", srv_c: "db-1" },
      script: "uname -a",
    });
    expect(paneIds(plan.workspace)).toEqual(["pane_srv_a", "pane_srv_b", "pane_srv_c"]);
    expect(plan.workspace.nodes.pane_srv_b).toEqual({
      kind: "pane",
      id: "pane_srv_b",
      target: { kind: "server", serverId: "srv_b" },
      tabTitle: "web-2",
    });
    expect(plan.inputByPaneId).toEqual({
      pane_srv_a: "uname -a\r",
      pane_srv_b: "uname -a\r",
      pane_srv_c: "uname -a\r",
    });
    expect(computePaneRects(plan.workspace).size).toBe(3);
  });
});

function runWith(targets: SshSnippetRun["targets"]): SshSnippetRun {
  return {
    runId: "run_1",
    snippetId: null,
    label: "uname -a",
    script: "uname -a",
    startedAtMs: 10,
    finishedAtMs: null,
    targets,
  };
}

const connecting = {
  state: "connecting" as const,
  exitCode: null,
  signal: null,
  error: null,
  startedAtMs: 10,
  finishedAtMs: null,
  truncated: false,
  output: [],
};

describe("applyRunEvent", () => {
  it("appends streamed output per server and finishes the run with the last target", () => {
    let run = runWith([
      { ...connecting, serverId: "srv_a" },
      { ...connecting, serverId: "srv_b" },
    ]);
    run = applyRunEvent(run, {
      type: "ssh.snippet.output",
      runId: "run_1",
      serverId: "srv_a",
      stream: "stdout",
      text: "Lin",
    });
    run = applyRunEvent(run, {
      type: "ssh.snippet.output",
      runId: "run_1",
      serverId: "srv_a",
      stream: "stdout",
      text: "ux\n",
    });
    run = applyRunEvent(run, {
      type: "ssh.snippet.output",
      runId: "run_other",
      serverId: "srv_a",
      stream: "stdout",
      text: "ignored",
    });
    const { output: _a, ...statusA } = { ...connecting, serverId: "srv_a" };
    run = applyRunEvent(run, {
      type: "ssh.snippet.state",
      runId: "run_1",
      target: { ...statusA, state: "exited", exitCode: 0, finishedAtMs: 20 },
    });
    expect(run.finishedAtMs).toBeNull();
    expect(run.targets[0]?.output).toEqual([{ stream: "stdout", text: "Linux\n" }]);
    run = applyRunEvent(run, {
      type: "ssh.snippet.state",
      runId: "run_1",
      target: {
        ...statusA,
        serverId: "srv_b",
        state: "failed",
        error: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" },
        finishedAtMs: 30,
      },
    });
    expect(run.finishedAtMs).toBe(30);
    expect(run.targets.map(targetOutcome)).toEqual(["success", "failure"]);
    expect(tallyRun(run)).toEqual({ success: 1, failure: 1, pending: 0, cancelled: 0 });
  });
});

describe("resolveTerminalAppearance", () => {
  it("takes the nearest theme and font size up the group chain", () => {
    const groups = [
      { id: "grp_root", theme: "midnight", fontSize: 12 },
      { id: "grp_prod", parentId: "grp_root", fontSize: 15 },
    ];
    expect(resolveTerminalAppearance({ groupId: "grp_prod" }, groups)).toEqual({
      theme: "midnight",
      fontSize: 15,
      themeSource: { kind: "group", groupId: "grp_root" },
      fontSizeSource: { kind: "group", groupId: "grp_prod" },
    });
    expect(resolveTerminalAppearance({ groupId: "grp_prod", theme: "light" }, groups).theme).toBe(
      "light",
    );
    expect(resolveTerminalAppearance({ theme: "not-a-theme" }, [])).toEqual({
      theme: null,
      fontSize: null,
      themeSource: { kind: "default" },
      fontSizeSource: { kind: "default" },
    });
    expect(terminalPaletteFor("midnight")).toBe(darkMidnightTheme.colors.terminal);
  });
});

const EchoResponseSchema = z.object({
  type: z.literal("ssh.test.echo.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable(), value: z.number() }),
});

function loopbackIo(answer: (request: SshRpcRequest) => unknown): SshRpcIo {
  const handlers = new Set<(message: unknown) => void>();
  return {
    send(request) {
      queueMicrotask(() => {
        for (const handler of handlers) {
          handler({
            type: "ssh.test.echo.response",
            payload: { requestId: "other", error: null, value: -1 },
          });
          handler(answer(request));
        }
      });
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

describe("sshRequest", () => {
  it("resolves with the payload correlated by requestId and rejects on error", async () => {
    const ok = loopbackIo((request) => ({
      type: "ssh.test.echo.response",
      payload: { requestId: request.requestId, error: null, value: 7 },
    }));
    await expect(
      sshRequest({
        io: ok,
        message: { type: "ssh.test.echo.request" },
        response: EchoResponseSchema,
      }),
    ).resolves.toEqual({ requestId: expect.stringMatching(/^ssh_/), error: null, value: 7 });

    const failing = loopbackIo((request) => ({
      type: "ssh.test.echo.response",
      payload: { requestId: request.requestId, error: "Snippet label is required", value: 0 },
    }));
    await expect(
      sshRequest({
        io: failing,
        message: { type: "ssh.test.echo.request" },
        response: EchoResponseSchema,
      }),
    ).rejects.toEqual(new SshRpcError("ssh.test.echo.request", "Snippet label is required"));
  });
});
