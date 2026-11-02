import { describe, expect, it } from "vitest";
import {
  createSshAgentTools,
  type HostToolPermissionRequest,
  type SshAgentToolDependencies,
  type SshForwardStartInput,
  type SshTerminalTab,
} from "./agent-tools.js";

interface Recorder {
  asked: HostToolPermissionRequest[];
  sent: Array<[string, string]>;
  started: SshForwardStartInput[];
}

function dependencies(
  recorder: Recorder,
  overrides: Partial<SshAgentToolDependencies> = {},
): SshAgentToolDependencies {
  const tabs: SshTerminalTab[] = [
    { terminalId: "term_1", serverId: "srv_a", title: "jad@srv_a" },
    { terminalId: "term_2", serverId: "srv_b", title: "build" },
    { terminalId: "term_3", serverId: "srv_b", title: "logs" },
  ];
  return {
    async acquire(serverId) {
      throw new Error(`no network in this test (${serverId})`);
    },
    callerAgentId: "agt_1",
    defaultServerId: "srv_a",
    async requestPermission(_agentId, request) {
      recorder.asked.push(request);
      return { behavior: "allow" };
    },
    terminals: {
      list: (serverId) => tabs.filter((tab) => tab.serverId === serverId),
      async send(terminalId, data) {
        recorder.sent.push([terminalId, data]);
      },
      async capture(terminalId, options) {
        return `${terminalId}:${options.lines}`;
      },
    },
    forwards: {
      async start(input) {
        recorder.started.push(input);
        return { forwardId: "fwd_1", description: "local 127.0.0.1:15432 -> db:5432" };
      },
      async stop() {},
    },
    servers: {
      async list() {
        return [];
      },
      async openTerminal(serverId) {
        return { terminalId: "term_new", serverId, title: serverId };
      },
    },
    ...overrides,
  };
}

function newRecorder(): Recorder {
  return { asked: [], sent: [], started: [] };
}

function tool(deps: SshAgentToolDependencies, name: string) {
  const found = createSshAgentTools(deps).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool ${name} not offered`);
  return found;
}

function text(result: { content: Array<{ text?: string }> }): string {
  return result.content[0].text ?? "";
}

describe("createSshAgentTools", () => {
  it("flags exactly the state-changing tools of spec 25.11 as needing permission", () => {
    const tools = createSshAgentTools(dependencies(newRecorder()));

    const flags = Object.fromEntries(tools.map((entry) => [entry.name, entry.requiresPermission]));

    expect(flags).toEqual({
      ssh_run: true,
      ssh_read_file: false,
      ssh_write_file: true,
      ssh_list_dir: false,
      ssh_terminal_send: true,
      ssh_terminal_capture: false,
      ssh_forward_start: true,
      ssh_forward_stop: true,
      ssh_list_servers: false,
      ssh_open_terminal: false,
    });
  });

  it("does not offer terminal, forward or directory tools without their backends", () => {
    const deps = dependencies(newRecorder(), { terminals: null, forwards: null, servers: null });

    const names = createSshAgentTools(deps).map((entry) => entry.name);

    expect(names).toEqual(["ssh_run", "ssh_read_file", "ssh_write_file", "ssh_list_dir"]);
  });

  it("types into the only tab of the chat's server after approval", async () => {
    const recorder = newRecorder();

    const result = await tool(dependencies(recorder), "ssh_terminal_send").handler(
      { text: "uptime", pressEnter: true },
      {},
    );

    expect(recorder.asked).toEqual([
      {
        kind: "tool",
        name: "ssh_terminal_send",
        title: "Type into jad@srv_a",
        description: "uptime",
        input: { serverId: "srv_a", terminalId: "term_1", text: "uptime" },
      },
    ]);
    expect(recorder.sent).toEqual([["term_1", "uptime\r"]]);
    expect(result.isError).toBeUndefined();
  });

  it("asks which tab when the server has several, without typing", async () => {
    const recorder = newRecorder();

    const result = await tool(dependencies(recorder), "ssh_terminal_send").handler(
      { serverId: "srv_b", text: "ls" },
      {},
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Several SSH tabs are open on srv_b; pass terminalId: term_2 (build), term_3 (logs)",
    );
    expect(recorder.asked).toEqual([]);
    expect(recorder.sent).toEqual([]);
  });

  it("captures a tab without asking", async () => {
    const recorder = newRecorder();

    const result = await tool(dependencies(recorder), "ssh_terminal_capture").handler(
      { serverId: "srv_b", terminalId: "term_3", lines: 50 },
      {},
    );

    expect(JSON.parse(text(result))).toEqual({
      serverId: "srv_b",
      terminalId: "term_3",
      screen: "term_3:50",
    });
    expect(recorder.asked).toEqual([]);
  });

  it("refuses a local forward without a destination before asking", async () => {
    const recorder = newRecorder();

    const result = await tool(dependencies(recorder), "ssh_forward_start").handler(
      { kind: "local", bindPort: 15432 },
      {},
    );

    expect(text(result)).toBe("local forwarding needs destHost and destPort.");
    expect(recorder.asked).toEqual([]);
    expect(recorder.started).toEqual([]);
  });

  it("starts an approved forward with the 127.0.0.1 default bind address", async () => {
    const recorder = newRecorder();

    await tool(dependencies(recorder), "ssh_forward_start").handler(
      { kind: "local", bindPort: 15432, destHost: "db", destPort: 5432 },
      {},
    );

    expect(recorder.started).toEqual([
      {
        serverId: "srv_a",
        kind: "local",
        bindAddress: "127.0.0.1",
        bindPort: 15432,
        destHost: "db",
        destPort: 5432,
      },
    ]);
  });

  it("needs a serverId when the chat is not bound to a server", async () => {
    const recorder = newRecorder();
    const deps = dependencies(recorder, { defaultServerId: null });

    const result = await tool(deps, "ssh_run").handler({ command: "id" }, {});

    expect(text(result)).toBe("serverId is required: this chat is not bound to an SSH server.");
    expect(recorder.asked).toEqual([]);
  });

  it("refuses state-changing tools outside an agent-scoped session", async () => {
    const recorder = newRecorder();
    const deps = dependencies(recorder, { callerAgentId: null });

    const result = await tool(deps, "ssh_write_file").handler({ path: "/tmp/x", content: "" }, {});

    expect(text(result)).toBe("ssh_write_file is only available to agent-scoped tool sessions.");
  });

  it("reports a connection failure as a tool error", async () => {
    const result = await tool(dependencies(newRecorder()), "ssh_list_dir").handler(
      { path: "/" },
      {},
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "no network in this test (srv_a)" }],
      isError: true,
    });
  });
});
