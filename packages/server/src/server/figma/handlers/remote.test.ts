/**
 * figma.remote.* RPC handlers (ADR-0040) on the W4 protocol DTOs: target-file validation,
 * auth URL passthrough, and the execute flow's version-memo invalidation and viewer push.
 * The connector itself is faked at the FigmaRemoteGateway boundary.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import type {
  FigmaRemoteCallResult,
  FigmaRemoteStatus,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type {
  FigmaContext,
  FigmaRemoteExecuteInput,
  FigmaRemoteExecuteOutcome,
  FigmaRemoteGateway,
} from "../context.js";
import { FigmaServiceError } from "../context.js";
import { figmaContent } from "./content.js";
import {
  executeRemoteWrite,
  readRemoteMetadata,
  remoteHandlers,
  type FigmaRemoteRequestType,
} from "./remote.js";
import { FakeFigmaStore, fakeFigmaContext, fakeFile } from "../test-support/fake-figma-queue.js";
import type { FigmaSessionInfo } from "./types.js";

const logger = pino({ level: "silent" });
const FILE_KEY = "AbC123xyz";

class FakeRemoteGateway implements FigmaRemoteGateway {
  status: FigmaRemoteStatus = { state: "disconnected" };
  authResult: { status: FigmaRemoteStatus; authorizationUrl?: string } = {
    status: { state: "needs_auth" },
  };
  readonly executeCalls: FigmaRemoteExecuteInput[] = [];
  readonly readCalls: { fileKey: string; nodeId?: string }[] = [];
  disconnects = 0;
  executeOutcome: FigmaRemoteExecuteOutcome = {
    result: { content: [{ type: "text", text: "edited 1:2" }] },
    readback: { content: [], structuredContent: { version: "v-new" } },
    readbackAvailable: true,
  };
  executeError: Error | null = null;
  readError: Error | null = null;

  async getStatus(): Promise<FigmaRemoteStatus> {
    return this.status;
  }
  async authBegin(): Promise<{ status: FigmaRemoteStatus; authorizationUrl?: string }> {
    return this.authResult;
  }
  async disconnect(): Promise<void> {
    this.disconnects++;
    this.status = { state: "disconnected" };
  }
  async readMetadata(fileKey: string, nodeId?: string): Promise<FigmaRemoteCallResult> {
    this.readCalls.push({ fileKey, nodeId });
    if (this.readError) throw this.readError;
    return {
      content: [{ type: "text", text: "metadata" }],
      structuredContent: { version: "v-read" },
    };
  }
  async execute(input: FigmaRemoteExecuteInput): Promise<FigmaRemoteExecuteOutcome> {
    this.executeCalls.push(input);
    if (this.executeError) throw this.executeError;
    return this.executeOutcome;
  }
  async dispose(): Promise<void> {}
}

type RemoteTestRequest = { type: FigmaRemoteRequestType; requestId: string } & Record<
  string,
  unknown
>;

interface Harness {
  ctx: FigmaContext;
  pushes: ReturnType<typeof fakeFigmaContext>["pushes"];
  gateway: FakeRemoteGateway;
  session: FigmaSessionInfo;
  call: (request: RemoteTestRequest) => Promise<Record<string, unknown>>;
}

let home: string;
let harness: Harness;

function setup(opts?: { noGateway?: boolean }): Harness {
  const store = new FakeFigmaStore();
  store.files.set(
    FILE_KEY,
    fakeFile({ fileKey: FILE_KEY, lastVersion: "v-old", lastModified_ms: 1 }),
  );
  const { ctx, pushes } = fakeFigmaContext({ jagentdeskHome: home, logger, store });
  const gateway = new FakeRemoteGateway();
  if (!opts?.noGateway) ctx.remote = gateway;
  const session: FigmaSessionInfo = { sessionKey: "s-1", canRunLoopback: false };
  return {
    ctx,
    pushes,
    gateway,
    session,
    call: (request) => {
      const handlers = remoteHandlers as Record<
        string,
        (
          request: unknown,
          ctx: FigmaContext,
          session: FigmaSessionInfo,
        ) => Promise<Record<string, unknown>>
      >;
      const handler = handlers[request.type];
      if (!handler) throw new Error(`no handler for ${request.type}`);
      return handler(request, ctx, session);
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "jad-figma-remote-handler-"));
  harness = setup();
});

afterEach(() => {
  figmaContent.watches.dispose();
  rmSync(home, { recursive: true, force: true });
});

describe("handler registration", () => {
  it("covers exactly the five protocol RPC types", () => {
    expect(Object.keys(remoteHandlers).sort()).toEqual(
      [
        "figma.remote.auth.begin.request",
        "figma.remote.disconnect.request",
        "figma.remote.execute.request",
        "figma.remote.read.request",
        "figma.remote.status.request",
      ].sort(),
    );
  });
});

describe("status + auth", () => {
  it("passes the observed connector state through", async () => {
    harness.gateway.status = { state: "needs_auth", message: "Connect editing" };
    await expect(
      harness.call({ type: "figma.remote.status.request", requestId: "r1" }),
    ).resolves.toEqual({
      status: { state: "needs_auth", message: "Connect editing" },
    });
  });

  it("returns the validated authorization URL from auth.begin", async () => {
    harness.gateway.authResult = {
      status: { state: "needs_auth" },
      authorizationUrl: "https://www.figma.com/oauth/abc",
    };
    await expect(
      harness.call({ type: "figma.remote.auth.begin.request", requestId: "r1" }),
    ).resolves.toEqual({
      status: { state: "needs_auth" },
      authorizationUrl: "https://www.figma.com/oauth/abc",
    });
  });

  it("disconnect disables and reports disconnected", async () => {
    harness.gateway.status = { state: "connected" };
    await expect(
      harness.call({ type: "figma.remote.disconnect.request", requestId: "r1" }),
    ).resolves.toEqual({
      status: { state: "disconnected" },
    });
    expect(harness.gateway.disconnects).toBe(1);
  });

  it("rejects every remote RPC when the connector is not wired", async () => {
    const h = setup({ noGateway: true });
    const error = await h
      .call({ type: "figma.remote.status.request", requestId: "r1" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FigmaServiceError);
    expect((error as FigmaServiceError).code).toBe("unsupported");
  });
});

describe("read", () => {
  it("refuses a file that has not been added to JAgentDesk", async () => {
    const error = await harness
      .call({ type: "figma.remote.read.request", requestId: "r1", fileKey: "zzz", nodeId: "1:2" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FigmaServiceError);
    expect((error as FigmaServiceError).code).toBe("not_found");
    expect(harness.gateway.readCalls).toEqual([]);
  });

  it("forwards server-controlled fileKey and optional nodeId", async () => {
    await harness.call({ type: "figma.remote.read.request", requestId: "r1", fileKey: FILE_KEY });
    expect(harness.gateway.readCalls).toEqual([{ fileKey: FILE_KEY, nodeId: undefined }]);
  });
});

describe("execute", () => {
  it("validates the target file before the connector runs", async () => {
    const error = await harness
      .call({
        type: "figma.remote.execute.request",
        requestId: "r1",
        fileKey: "nope",
        code: "x",
        description: "d",
      })
      .catch((caught: unknown) => caught);
    expect((error as FigmaServiceError).code).toBe("not_found");
    expect(harness.gateway.executeCalls).toEqual([]);
  });

  it("requires code and description", async () => {
    await expect(
      harness.call({
        type: "figma.remote.execute.request",
        requestId: "r1",
        fileKey: FILE_KEY,
        code: "",
        description: "d",
      }),
    ).rejects.toThrow(/code/);
    await expect(
      harness.call({
        type: "figma.remote.execute.request",
        requestId: "r1",
        fileKey: FILE_KEY,
        code: "x",
        description: " ",
      }),
    ).rejects.toThrow(/description/);
  });

  it("returns result + readback and pushes a refreshed version to watchers", async () => {
    const watchId = figmaContent.watches.watch(harness.ctx, FILE_KEY, "s-1");
    const response = await harness.call({
      type: "figma.remote.execute.request",
      requestId: "r1",
      fileKey: FILE_KEY,
      code: "code()",
      description: "rename page",
    });
    expect(response).toEqual({
      result: { content: [{ type: "text", text: "edited 1:2" }] },
      readback: { content: [], structuredContent: { version: "v-new" } },
      readbackAvailable: true,
    });
    expect(harness.gateway.executeCalls).toEqual([
      { fileKey: FILE_KEY, code: "code()", description: "rename page" },
    ]);
    expect(harness.pushes).toContainEqual({
      type: "figma.file.changed",
      watchId,
      fileKey: FILE_KEY,
      version: "v-new",
      source: "rest",
    });
  });

  it("marks a failed readback unverified but still drops the stale version memo", async () => {
    harness.gateway.executeOutcome = {
      result: { content: [{ type: "text", text: "edited" }] },
      readbackAvailable: false,
    };
    const watchId = figmaContent.watches.watch(harness.ctx, FILE_KEY, "s-1");
    const response = await harness.call({
      type: "figma.remote.execute.request",
      requestId: "r1",
      fileKey: FILE_KEY,
      code: "code()",
      description: "rename page",
    });
    expect(response.readbackAvailable).toBe(false);
    expect(response.readback).toBeUndefined();
    expect(harness.pushes).toContainEqual({
      type: "figma.file.changed",
      watchId,
      fileKey: FILE_KEY,
      version: "",
      source: "rest",
    });
  });

  it("a helper restart during the write still invalidates the memo and reports a clear error", async () => {
    harness.gateway.executeError = new Error(
      "The Figma editing helper restarted during the write; outcome unverified.",
    );
    const watchId = figmaContent.watches.watch(harness.ctx, FILE_KEY, "s-1");
    const error = await harness
      .call({
        type: "figma.remote.execute.request",
        requestId: "r1",
        fileKey: FILE_KEY,
        code: "x",
        description: "d",
      })
      .catch((caught: unknown) => caught);
    expect((error as FigmaServiceError).code).toBe("figma_error");
    expect(harness.pushes).toContainEqual({
      type: "figma.file.changed",
      watchId,
      fileKey: FILE_KEY,
      version: "",
      source: "rest",
    });
  });

  it("execute failures do not fall back to the pending queue", async () => {
    // A remote failure rejects; spec 32.6.1's queue hand-off belongs to the Link path only.
    harness.gateway.executeError = new Error(
      'Figma remote editing is needs_auth. Ask the user to tap "Connect editing".',
    );
    await expect(
      executeRemoteWrite(harness.ctx, { fileKey: FILE_KEY, code: "x", description: "d" }),
    ).rejects.toThrow(/Connect editing/);
  });
});

describe("readRemoteMetadata helper", () => {
  it("wraps connector failures as a readable figma_error", async () => {
    harness.gateway.readError = new Error("connector said no");
    const error = await readRemoteMetadata(harness.ctx, FILE_KEY).catch(
      (caught: unknown) => caught,
    );
    expect((error as FigmaServiceError).code).toBe("figma_error");
    expect((error as FigmaServiceError).message).toMatch(/connector said no/);
  });
});
