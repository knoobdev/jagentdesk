import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@jagentdesk/protocol/agent-types";
import { isSshRunToolName, parseSshRunResult, readSshRunToolResult } from "./ssh-run-detection";

describe("isSshRunToolName", () => {
  // Every provider naming of the same tool (spec 33.7 / tool-name-normalization).
  it.each([
    "ssh_run",
    "jagentdesk.ssh_run",
    "mcp__jagentdesk__ssh_run",
    "jagentdesk_ssh_run",
    "SSH_RUN",
  ])("matches %s", (toolName) => {
    expect(isSshRunToolName(toolName)).toBe(true);
  });

  it.each([
    "remote_run",
    "jagentdesk.remote_run",
    "mcp__jagentdesk__remote_run",
    "jagentdesk_remote_run",
    "ssh_terminal_send",
    "jagentdesk.ssh_read_file",
    "mcp__jagentdesk__ssh_run_extra",
    "jagentdesk_ssh_run_all",
    "ssh",
    "bash",
    "",
  ])("rejects %s", (toolName) => {
    expect(isSshRunToolName(toolName)).toBe(false);
  });
});

const fullResult = {
  serverId: "srv_e4e910a0a4ab",
  stdout: "Linux pc 6.1.0\n",
  stderr: "ls: cannot access '/x': No such file or directory\n",
  exitCode: 2,
  signal: null,
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
};

describe("parseSshRunResult", () => {
  it("reads the object payload", () => {
    expect(parseSshRunResult(fullResult)).toEqual(fullResult);
  });

  it("reads a JSON-string payload", () => {
    expect(parseSshRunResult(JSON.stringify(fullResult))).toEqual(fullResult);
  });

  it("reads an MCP content array whose text item holds the JSON", () => {
    const payload = {
      content: [{ type: "text", text: JSON.stringify(fullResult) }],
    };
    expect(parseSshRunResult(payload)).toEqual(fullResult);
  });

  it("skips non-text MCP content items", () => {
    const payload = {
      content: [
        { type: "image", data: "…" },
        { type: "text", text: JSON.stringify(fullResult) },
      ],
    };
    expect(parseSshRunResult(payload)).toEqual(fullResult);
  });

  it("defaults missing optional fields", () => {
    expect(parseSshRunResult({ serverId: "srv_1", exitCode: 0 })).toEqual({
      serverId: "srv_1",
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    });
  });

  it("keeps a null exitCode (signal kill, channel closed without a status)", () => {
    const result = parseSshRunResult({ serverId: "srv_1", exitCode: null, signal: "SIGKILL" });
    expect(result?.exitCode).toBeNull();
    expect(result?.signal).toBe("SIGKILL");
  });

  it.each([
    undefined,
    null,
    42,
    "hello",
    "not json {",
    "{broken",
    "[]",
    "{}",
    { exitCode: 0 }, // missing serverId
    { serverId: "", exitCode: 0 }, // empty serverId
    { serverId: 7, exitCode: 0 }, // non-string serverId
    { serverId: "srv_1" }, // missing exitCode
    { serverId: "srv_1", exitCode: "0" }, // non-numeric exitCode
    { content: [] }, // MCP array without a text item
    { content: [{ type: "text" }] }, // text item without text
    { content: [{ type: "text", text: "hello" }] }, // text item without JSON
    { content: [{ type: "text", text: "{broken" }] }, // text item with malformed JSON
  ])("returns null for %p", (raw) => {
    expect(parseSshRunResult(raw)).toBeNull();
  });
});

function unknownDetail(input: unknown, output: unknown): ToolCallDetail {
  return { type: "unknown", input, output };
}

describe("readSshRunToolResult", () => {
  it("takes the command from the call input", () => {
    const detail = unknownDetail({ command: "uname -a", serverId: "srv_other" }, fullResult);
    const result = readSshRunToolResult("ssh_run", detail);
    expect(result?.command).toBe("uname -a");
    expect(result?.serverId).toBe("srv_e4e910a0a4ab");
  });

  it("reads every provider naming", () => {
    const detail = unknownDetail({ command: "uptime" }, JSON.stringify(fullResult));
    for (const toolName of [
      "ssh_run",
      "jagentdesk.ssh_run",
      "mcp__jagentdesk__ssh_run",
      "jagentdesk_ssh_run",
    ]) {
      expect(readSshRunToolResult(toolName, detail)?.stdout).toBe(fullResult.stdout);
    }
  });

  it("reads a plain_text detail (command unknown)", () => {
    const detail: ToolCallDetail = { type: "plain_text", text: JSON.stringify(fullResult) };
    const result = readSshRunToolResult("mcp__jagentdesk__ssh_run", detail);
    expect(result?.serverId).toBe("srv_e4e910a0a4ab");
    expect(result?.command).toBe("");
  });

  it("returns null for pending calls and non ssh_run tools", () => {
    expect(readSshRunToolResult("ssh_run", undefined)).toBeNull();
    expect(readSshRunToolResult("ssh_run", unknownDetail({}, null))).toBeNull();
    expect(
      readSshRunToolResult("remote_run", unknownDetail({ command: "x" }, fullResult)),
    ).toBeNull();
  });

  it("returns null when the result is malformed", () => {
    expect(readSshRunToolResult("ssh_run", unknownDetail({ command: "x" }, "{}"))).toBeNull();
    expect(readSshRunToolResult("ssh_run", unknownDetail({ command: "x" }, "denied"))).toBeNull();
  });
});
