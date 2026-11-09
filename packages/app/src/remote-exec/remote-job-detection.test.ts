import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@jagentdesk/protocol/agent-types";
import { isRemoteJobToolName, readRemoteJobToolResult } from "./remote-job-detection";

describe("isRemoteJobToolName", () => {
  it("matches the plain tool names", () => {
    expect(isRemoteJobToolName("remote_run")).toBe(true);
    expect(isRemoteJobToolName("remote_job_wait")).toBe(true);
  });

  it("matches daemon-prefixed names", () => {
    expect(isRemoteJobToolName("jagentdesk.remote_run")).toBe(true);
    expect(isRemoteJobToolName("jagentdesk.remote_job_wait")).toBe(true);
  });

  it("matches MCP-prefixed names", () => {
    expect(isRemoteJobToolName("mcp__jagentdesk__remote_run")).toBe(true);
    expect(isRemoteJobToolName("mcp__jagentdesk__remote_job_wait")).toBe(true);
  });

  it("rejects other tools", () => {
    expect(isRemoteJobToolName("remote_stop")).toBe(false);
    expect(isRemoteJobToolName("remote_exec")).toBe(false);
    expect(isRemoteJobToolName("shell")).toBe(false);
  });
});

function unknownResult(value: unknown): ToolCallDetail {
  return { type: "unknown", input: {}, output: value };
}

function jobResult(overrides: Record<string, unknown> = {}) {
  return {
    job: {
      id: "rjb_0123456789ab",
      status: "running",
      ...overrides,
    },
    output: "hello\n",
    outputOffset: 0,
    outputTruncatedHead: false,
  };
}

describe("readRemoteJobToolResult", () => {
  it("reads the job from an unknown-detail object output", () => {
    const result = readRemoteJobToolResult("remote_run", unknownResult(jobResult()));
    expect(result?.job.id).toBe("rjb_0123456789ab");
    expect(result?.output).toBe("hello\n");
  });

  it("reads the job from a JSON-string unknown-detail output", () => {
    const detail = unknownResult(JSON.stringify(jobResult({ status: "succeeded", exitCode: 0 })));
    const result = readRemoteJobToolResult("jagentdesk.remote_run", detail);
    expect(result?.job.status).toBe("succeeded");
    expect(result?.outputOffset).toBe(0);
  });

  it("reads the job from a plain_text detail", () => {
    const detail: ToolCallDetail = {
      type: "plain_text",
      text: JSON.stringify(jobResult()),
    };
    const result = readRemoteJobToolNameGuarded(detail);
    expect(result?.job.id).toBe("rjb_0123456789ab");
  });

  it("returns null for a pending tool call with no detail", () => {
    expect(readRemoteJobToolResult("remote_run", undefined)).toBeNull();
  });

  it("returns null when the output is not a remote job result", () => {
    expect(readRemoteJobToolResult("remote_run", unknownResult("plain output"))).toBeNull();
    expect(readRemoteJobToolResult("remote_run", unknownResult({ other: true }))).toBeNull();
    expect(readRemoteJobToolResult("remote_run", unknownResult("{not json"))).toBeNull();
  });

  it("returns null when the job id is not a remote job id", () => {
    const value = jobResult();
    value.job.id = "job_7";
    expect(readRemoteJobToolResult("remote_run", unknownResult(value))).toBeNull();
  });

  it("returns null for non remote-job tools even with a job-shaped result", () => {
    expect(readRemoteJobToolResult("shell", unknownResult(jobResult()))).toBeNull();
  });

  it("defaults missing output fields", () => {
    const result = readRemoteJobToolResult(
      "remote_run",
      unknownResult({ job: { id: "rjb_1", status: "syncing" } }),
    );
    expect(result?.output).toBe("");
    expect(result?.outputOffset).toBe(0);
    expect(result?.outputTruncatedHead).toBe(false);
  });

  it("passes through the truncated-head flag", () => {
    const value = jobResult();
    value.outputTruncatedHead = true;
    const result = readRemoteJobToolResult("remote_run", unknownResult(value));
    expect(result?.outputTruncatedHead).toBe(true);
  });
});

function readRemoteJobToolNameGuarded(detail: ToolCallDetail) {
  return readRemoteJobToolResult("mcp__jagentdesk__remote_job_wait", detail);
}
