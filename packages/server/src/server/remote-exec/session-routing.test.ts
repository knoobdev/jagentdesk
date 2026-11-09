// session-routing.test.ts — proves the Session-level wiring of spec 33.8: the six
// remote_exec.* requests dispatch to the injected RemoteExecService and every request gets a
// response (also when the engine is unavailable, i.e. service null), and the
// remote_exec.job_updated push only reaches sessions whose scopes allow it.
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { Session, type SessionOptions } from "../session.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { WorkspaceAutoName } from "../workspace-auto-name.js";
import type { ProviderUsageService } from "../../services/quota-fetcher/service.js";
import { createStub } from "../test-utils/class-mocks.js";
import {
  asAgentManager,
  asAgentStorage,
  asCheckoutDiffManager,
  asChatService,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asLoopService,
  asPushTokenStore,
  asScheduleService,
  asWorkspaceGitService,
  createProviderSnapshotManagerStub,
} from "../test-utils/session-stubs.js";
import { RemoteExecError, type RemoteExecService, type RemoteJob } from "./types.js";

const job: RemoteJob = {
  id: "rjb_0123456789ab",
  serverId: "srv_a",
  serverLabel: "build box",
  workspacePath: "/repo",
  workspaceKey: "wsk_0123456789ab",
  snapshotId: null,
  command: "npm test",
  status: "running",
  exitCode: null,
  error: null,
  agentId: null,
  sync: null,
  outputBytes: 0,
  outputTruncated: false,
  createdAtMs: 1_000,
  startedAtMs: 1_100,
  finishedAtMs: null,
  timeoutMs: 7_200_000,
};

function createFakeService(overrides: Partial<RemoteExecService> = {}): RemoteExecService {
  return {
    listTargets: vi.fn(async () => [
      {
        serverId: "srv_a",
        label: "build box",
        address: "srv_a.tailnet",
        via: "tailnet" as const,
        workRoot: "~/.jagentdesk/remote-exec",
        connectionState: "connected",
        environment: null,
      },
    ]),
    checkTarget: vi.fn(async () => ({
      ok: true,
      os: "linux",
      shell: "/bin/bash",
      missing: [],
      freeKb: 1_000,
      writable: true,
      error: null,
    })),
    previewSnapshot: vi.fn(async () => ({
      workspacePath: "/repo",
      workspaceKey: "wsk_0123456789ab",
      filesTotal: 0,
      bytesTotal: 0,
      excludedSecrets: [],
      skipped: [],
    })),
    startJob: vi.fn(async () => job),
    waitForJob: vi.fn(async () => ({
      job,
      output: "",
      outputOffset: 0,
      outputTruncatedHead: false,
    })),
    readOutput: vi.fn(async () => ({
      chunk: "hello",
      offset: 0,
      nextOffset: 5,
      totalBytes: 5,
      complete: true,
    })),
    stopJob: vi.fn(async () => ({ ...job, status: "stopped" as const })),
    listJobs: vi.fn(() => [job]),
    getJob: vi.fn(() => job),
    onJobUpdated: vi.fn(() => () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

function createSessionForTest(options: {
  messages: SessionOutboundMessage[];
  scopes?: string[];
  remoteExecService?: RemoteExecService | null;
}): Session {
  const logger = pino({ level: "silent" });
  return new Session({
    clientId: "test-client",
    scopes: options.scopes ?? ["*"],
    onMessage: (message) => options.messages.push(message),
    logger,
    downloadTokenStore: asDownloadTokenStore(),
    pushTokenStore: asPushTokenStore(),
    jagentdeskHome: "/tmp/jagentdesk-remote-exec-test-home",
    agentManager: asAgentManager({
      listAgents: vi.fn(() => []),
      listProviderSubagentActivity: vi.fn(() => []),
      subscribe: vi.fn(() => () => {}),
    }),
    agentStorage: asAgentStorage({
      get: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    }),
    projectRegistry: createStub<NonNullable<SessionOptions["projectRegistry"]>>({
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      getOrCreateActiveByRoot: vi.fn(async () => {
        throw new Error("not stubbed");
      }),
      upsert: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      initialize: vi.fn(async () => {}),
      existsOnDisk: vi.fn(async () => false),
      subscribeToMutations: vi.fn(() => () => {}),
    }),
    workspaceRegistry: createStub<NonNullable<SessionOptions["workspaceRegistry"]>>({
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      subscribeToMutations: vi.fn(() => () => {}),
    }),
    chatService: asChatService(),
    scheduleService: asScheduleService(),
    loopService: asLoopService(),
    checkoutDiffManager: asCheckoutDiffManager({ scheduleRefreshForCwd: vi.fn() }),
    workspaceGitService: asWorkspaceGitService({}),
    workspaceAutoName: createStub<WorkspaceAutoName>({}),
    daemonConfigStore: asDaemonConfigStore({
      get: vi.fn(() => ({ mcp: { injectIntoAgents: false }, providers: {} })),
      onChange: vi.fn(() => () => {}),
    }),
    stt: null,
    tts: null,
    terminalManager: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    providerUsageService: createStub<ProviderUsageService>({}),
    remoteExecService: options.remoteExecService,
  });
}

describe("remote_exec session routing", () => {
  test("routes requests to the injected service and emits its response", async () => {
    const messages: SessionOutboundMessage[] = [];
    const service = createFakeService();
    const session = createSessionForTest({ messages, remoteExecService: service });

    await session.handleMessage({
      type: "remote_exec.list_targets.request",
      requestId: "r1",
    });
    await session.handleMessage({
      type: "remote_exec.stop_job.request",
      requestId: "r2",
      jobId: job.id,
    });

    expect(service.listTargets).toHaveBeenCalledOnce();
    expect(service.stopJob).toHaveBeenCalledWith(job.id);
    expect(messages).toEqual([
      {
        type: "remote_exec.list_targets.response",
        payload: {
          requestId: "r1",
          error: null,
          targets: [
            {
              serverId: "srv_a",
              label: "build box",
              address: "srv_a.tailnet",
              via: "tailnet",
              workRoot: "~/.jagentdesk/remote-exec",
              connectionState: "connected",
              environment: null,
            },
          ],
        },
      },
      {
        type: "remote_exec.stop_job.response",
        payload: {
          requestId: "r2",
          error: null,
          job: { ...job, status: "stopped" },
        },
      },
    ]);
  });

  test("maps a service failure to the '<code>: <message>' error response", async () => {
    const messages: SessionOutboundMessage[] = [];
    const service = createFakeService({
      listTargets: vi.fn(async () => {
        throw new RemoteExecError("tailnet_unavailable", "Tailscale is down");
      }),
    });
    const session = createSessionForTest({ messages, remoteExecService: service });

    await session.handleMessage({
      type: "remote_exec.list_targets.request",
      requestId: "r3",
    });

    expect(messages).toEqual([
      {
        type: "remote_exec.list_targets.response",
        payload: { requestId: "r3", error: "tailnet_unavailable: Tailscale is down", targets: [] },
      },
    ]);
  });

  test("answers every request even when no service is wired (engine unavailable)", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages, remoteExecService: null });

    await session.handleMessage({
      type: "remote_exec.get_job.request",
      requestId: "r4",
      jobId: job.id,
    });

    expect(messages).toEqual([
      {
        type: "remote_exec.get_job.response",
        payload: { requestId: "r4", error: "internal: remote-exec is unavailable", job: null },
      },
    ]);
  });

  test("forwards job updates to sessions whose scopes allow the push", () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages, scopes: ["*"] });

    session.emitRemoteExecJobUpdated(job);

    expect(messages).toEqual([{ type: "remote_exec.job_updated", payload: { job } }]);
  });

  test("drops job updates for sessions whose scopes do not allow the push", () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      scopes: ["remote_exec.list_targets.request"],
    });

    session.emitRemoteExecJobUpdated(job);

    expect(messages).toEqual([]);
  });
});
