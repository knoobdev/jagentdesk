import { describe, expect, it } from "vitest";
import type { RemoteJob } from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import {
  REMOTE_JOB_OUTPUT_TAIL_LIMIT,
  appendOutputTail,
  isTerminalRemoteJobStatus,
  remoteJobCardReducer,
  type RemoteJobCardState,
} from "./job-card-state";

function makeJob(status: RemoteJob["status"]): RemoteJob {
  return {
    id: "rjb_0123456789ab",
    serverId: "srv_1",
    serverLabel: "WSL box",
    workspacePath: "/repo",
    workspaceKey: "wsk_0123456789ab",
    snapshotId: null,
    command: "uname -a",
    status,
    exitCode: null,
    error: null,
    agentId: null,
    sync: null,
    outputBytes: 0,
    outputTruncated: false,
    createdAtMs: 0,
    startedAtMs: null,
    finishedAtMs: null,
    timeoutMs: 7_200_000,
  };
}

const emptyState: RemoteJobCardState = {
  job: null,
  output: "",
  nextOffset: 0,
  totalBytes: 0,
};

describe("isTerminalRemoteJobStatus", () => {
  it("treats succeeded, failed, stopped, timed_out and lost as terminal", () => {
    expect(isTerminalRemoteJobStatus("succeeded")).toBe(true);
    expect(isTerminalRemoteJobStatus("failed")).toBe(true);
    expect(isTerminalRemoteJobStatus("stopped")).toBe(true);
    expect(isTerminalRemoteJobStatus("timed_out")).toBe(true);
    expect(isTerminalRemoteJobStatus("lost")).toBe(true);
  });

  it("keeps syncing and running live", () => {
    expect(isTerminalRemoteJobStatus("syncing")).toBe(false);
    expect(isTerminalRemoteJobStatus("running")).toBe(false);
  });
});

describe("appendOutputTail", () => {
  it("appends while the tail fits", () => {
    expect(appendOutputTail("abc", "def", 100)).toBe("abcdef");
  });

  it("keeps only the last `limit` characters when the tail overflows", () => {
    expect(appendOutputTail("0123456789", "abcde", 6)).toBe("9abcde");
  });

  it("keeps the last 64 KiB with the default limit", () => {
    const seed = "a".repeat(REMOTE_JOB_OUTPUT_TAIL_LIMIT);
    const grown = appendOutputTail(seed, "bcdefg");
    expect(grown.length).toBe(REMOTE_JOB_OUTPUT_TAIL_LIMIT);
    expect(grown.endsWith("bcdefg")).toBe(true);
  });
});

describe("remoteJobCardReducer", () => {
  it("applies job pushes without touching the output tail", () => {
    const withOutput = remoteJobCardReducer(emptyState, {
      type: "chunk",
      chunk: "hello",
      nextOffset: 5,
      totalBytes: 5,
    });
    const afterJob = remoteJobCardReducer(withOutput, {
      type: "job",
      job: makeJob("running"),
    });
    expect(afterJob.job?.status).toBe("running");
    expect(afterJob.output).toBe("hello");
    expect(afterJob.nextOffset).toBe(5);
  });

  it("appends chunks and advances the read offsets", () => {
    const first = remoteJobCardReducer(emptyState, {
      type: "chunk",
      chunk: "one ",
      nextOffset: 4,
      totalBytes: 4,
    });
    const second = remoteJobCardReducer(first, {
      type: "chunk",
      chunk: "two",
      nextOffset: 7,
      totalBytes: 9,
    });
    expect(second.output).toBe("one two");
    expect(second.nextOffset).toBe(7);
    expect(second.totalBytes).toBe(9);
  });

  it("never regresses the read offsets from a stale response", () => {
    const ahead = remoteJobCardReducer(emptyState, {
      type: "chunk",
      chunk: "later",
      nextOffset: 10,
      totalBytes: 10,
    });
    const stale = remoteJobCardReducer(ahead, {
      type: "chunk",
      chunk: "early",
      nextOffset: 4,
      totalBytes: 10,
    });
    expect(stale.nextOffset).toBe(10);
    expect(stale.totalBytes).toBe(10);
  });

  it("replaces the tail on a loaded mount fetch and keeps the known job otherwise", () => {
    const seeded = remoteJobCardReducer(emptyState, { type: "job", job: makeJob("running") });
    const loaded = remoteJobCardReducer(seeded, {
      type: "loaded",
      job: null,
      output: "tail",
      nextOffset: 65536,
      totalBytes: 65536,
    });
    expect(loaded.job?.status).toBe("running");
    expect(loaded.output).toBe("tail");
    expect(loaded.nextOffset).toBe(65536);
  });
});
