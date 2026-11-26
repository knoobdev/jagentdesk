import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  MutableDaemonConfigSchema,
  MutableDaemonConfigPatchSchema,
  AgentSnapshotPayloadSchema,
  AgentStreamEventPayloadSchema,
  AgentTimelineItemPayloadSchema,
  AgentTimelineEntryPayloadSchema,
  ServerInfoStatusPayloadSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
  CheckoutStatusResponseSchema,
  BranchSuggestionsRequestSchema,
  WorkspaceBaseBranchSetRequestSchema,
  WorkspaceBaseBranchSetResponseSchema,
} from "./messages.js";

test("base selection RPCs are correlated while older checkout and branch messages remain valid", () => {
  const payload = {
    cwd: "/repo",
    requestId: "status",
    error: null,
    isGit: true,
    isJAgentDeskOwnedWorktree: false,
    repoRoot: "/repo",
    currentBranch: "feature",
    isDirty: false,
    baseRef: "release",
    aheadBehind: null,
    aheadOfOrigin: null,
    behindOfOrigin: null,
    hasRemote: false,
    remoteUrl: null,
  };
  expect(
    CheckoutStatusResponseSchema.safeParse({ type: "checkout_status_response", payload }).success,
  ).toBe(true);
  expect(
    CheckoutStatusResponseSchema.parse({
      type: "checkout_status_response",
      payload: { ...payload, baseRefExact: "refs/remotes/upstream/release" },
    }).payload.baseRefExact,
  ).toBe("refs/remotes/upstream/release");
  expect(
    BranchSuggestionsRequestSchema.safeParse({
      type: "branch_suggestions_request",
      cwd: "/repo",
      requestId: "branches",
    }).success,
  ).toBe(true);
  const request = {
    type: "workspace.base_branch.set.request",
    workspaceId: "workspace",
    baseRef: "refs/heads/release",
    requestId: "base",
  };
  expect(WorkspaceBaseBranchSetRequestSchema.parse(request)).toEqual(request);
  const response = {
    type: "workspace.base_branch.set.response",
    payload: {
      workspaceId: "workspace",
      baseRef: "refs/heads/release",
      requestId: "base",
      accepted: true,
      error: null,
    },
  };
  expect(WorkspaceBaseBranchSetResponseSchema.parse(response)).toEqual(response);
});

test("checkout status stays valid without pull and push remotes and retains them when sent", () => {
  const olderDaemonPayload = {
    cwd: "/repo",
    requestId: "status",
    error: null,
    isGit: true,
    isJAgentDeskOwnedWorktree: false,
    repoRoot: "/repo",
    currentBranch: "main",
    isDirty: false,
    baseRef: "main",
    aheadBehind: null,
    aheadOfOrigin: 1,
    behindOfOrigin: 2,
    hasRemote: false,
    remoteUrl: null,
    upstreamRef: "refs/remotes/doras-mono/main",
    upstreamState: "tracked",
    firstPushRemote: null,
  };
  const parse = (payload: Record<string, unknown>) =>
    CheckoutStatusResponseSchema.parse({ type: "checkout_status_response", payload }).payload;

  const older = parse(olderDaemonPayload);
  expect(older.pullRemote).toBeUndefined();
  expect(older.pushRemote).toBeUndefined();
  expect(
    parse({ ...olderDaemonPayload, pullRemote: "doras-mono", pushRemote: "doras-mono" }),
  ).toMatchObject({ pullRemote: "doras-mono", pushRemote: "doras-mono" });
  expect(parse({ ...olderDaemonPayload, pullRemote: "upstream", pushRemote: null })).toMatchObject({
    pullRemote: "upstream",
    pushRemote: null,
  });
});

const LegacySubAgentToolCallSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  error: z.unknown().nullable(),
  detail: z.object({
    type: z.literal("sub_agent"),
    subAgentType: z.string().optional(),
    description: z.string().optional(),
    log: z.string(),
    // Copied from v0.1.65-beta.3: actions was required even though the UI ignored it.
    actions: z.array(
      z.object({
        index: z.number().int().positive(),
        toolName: z.string(),
        summary: z.string().optional(),
      }),
    ),
  }),
});

const LegacyAgentCapabilityFlagsSchema = z.object({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
});

const LegacyAgentSnapshotPayloadSchema = AgentSnapshotPayloadSchema.extend({
  capabilities: LegacyAgentCapabilityFlagsSchema,
});

describe("wire schema compatibility", () => {
  test("hello parses with and without the project update capability", () => {
    const legacy = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "legacy-client",
      clientType: "mobile",
      protocolVersion: 1,
    });
    const capable = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "capable-client",
      clientType: "mobile",
      protocolVersion: 1,
      capabilities: { project_updates: true },
    });

    expect([legacy, capable]).toEqual([
      {
        type: "hello",
        clientId: "legacy-client",
        clientType: "mobile",
        protocolVersion: 1,
      },
      {
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { project_updates: true },
      },
    ]);
  });

  test("timeline replacement invalidation is opt-in and carries no timeline rows", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { timeline_replacement_invalidation: true },
      }).capabilities,
    ).toEqual({ timeline_replacement_invalidation: true });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.timeline.replacement",
        payload: { agentId: "agent-1", epoch: "epoch-2" },
      }),
    ).toEqual({
      type: "agent.timeline.replacement",
      payload: { agentId: "agent-1", epoch: "epoch-2" },
    });
  });

  test("server info strips unknown legacy features while accepting former turn identity", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "legacy-server",
      features: {
        workspaceGithubClone: true,
        agentTurnIdentity: true,
      },
    });

    expect(parsed).toEqual({
      status: "server_info",
      serverId: "legacy-server",
      hostname: null,
      version: null,
      features: { agentTurnIdentity: true },
    });
  });

  test("server info accepts optional machineKind and older clients drop it cleanly", () => {
    const legacyServerInfo = z.object({
      status: z.literal("server_info"),
      serverId: z.string().trim().min(1),
      hostname: z.string().nullable().optional(),
      version: z.string().nullable().optional(),
    });
    const withKind = {
      status: "server_info",
      serverId: "macbook-server",
      hostname: "mbp.local",
      version: "0.9.5",
      machineKind: "laptop",
    };

    expect(ServerInfoStatusPayloadSchema.parse(withKind).machineKind).toBe("laptop");
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...withKind, machineKind: null }).machineKind,
    ).toBeNull();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "older-server",
      }).machineKind,
    ).toBeUndefined();
    expect(legacyServerInfo.parse(withKind)).not.toHaveProperty("machineKind");
  });

  test("assistant timeline message ids are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "old daemon shape",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "old daemon shape",
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "new daemon shape",
        messageId: "msg-1",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "new daemon shape",
      messageId: "msg-1",
    });
  });

  test("a sub-agent launch marker still parses against the v0.1.65-beta.3 schema", () => {
    const card = {
      type: "tool_call",
      callId: "call-sub-agent-1",
      name: "Task",
      status: "completed",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "Inspect repository structure",
        childSessionId: "child-session-1",
        log: "",
        actions: [],
      },
    } as const;

    const parsed = LegacySubAgentToolCallSchema.parse(JSON.parse(JSON.stringify(card)));
    expect(parsed.detail).toMatchObject({ log: "", actions: [] });
    const { log: _log, ...withoutLog } = card.detail;
    expect(LegacySubAgentToolCallSchema.safeParse({ ...card, detail: withoutLog }).success).toBe(
      false,
    );
    expect(AgentTimelineItemPayloadSchema.parse({ ...card, detail: withoutLog })).toMatchObject({
      detail: { type: "sub_agent", description: "Inspect repository structure" },
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        ...card,
        detail: { ...card.detail, log: "[Read] README.md" },
      }),
    ).toMatchObject({ detail: { log: "[Read] README.md" } });
  });

  test("old clients parse agent snapshots with rewind capabilities", () => {
    const parsed = LegacyAgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: true,
        supportsRewindFiles: true,
        supportsRewindBoth: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities).toEqual({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    });
  });

  test("new clients parse agent snapshots without rewind capabilities", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities.supportsRewindConversation).toBe(false);
    expect(parsed.capabilities.supportsRewindFiles).toBe(false);
    expect(parsed.capabilities.supportsRewindBoth).toBe(false);
  });
});

test("local STT language survives wire reads and patches", () => {
  const patch = {
    features: {
      dictation: { stt: { provider: "local", language: "fr" } },
      voiceMode: { stt: { provider: "local", language: null } },
    },
  };
  expect(MutableDaemonConfigPatchSchema.parse(patch)).toEqual(patch);
});

test("speech config reads remain compatible with clients before features and future providers", () => {
  const oldSchema = MutableDaemonConfigSchema.omit({ features: true, envOverrides: true });
  const oldRead = oldSchema.parse({
    providers: {},
    relay: { enabled: false, endpoint: "relay.jagentdesk.local:443", useTls: true },
    mcp: { enabled: true, injectIntoAgents: true },
  });
  const read = {
    ...oldRead,
    features: {
      dictation: { enabled: true, stt: { provider: "local", language: "fr" } },
      voiceMode: {
        enabled: false,
        stt: { provider: "future", model: "future-model", region: "eu" },
        tts: { provider: "openai", hasApiKey: false },
      },
    },
    envOverrides: { "features.voiceMode.stt.provider": "JAGENTDESK_VOICE_STT_PROVIDER" },
  };
  expect(oldSchema.parse(read)).toEqual(oldRead);
  expect(MutableDaemonConfigSchema.parse(oldRead)).toEqual(oldRead);
  expect(MutableDaemonConfigSchema.parse(read).features?.dictation.stt).toEqual(
    read.features.dictation.stt,
  );
  expect(MutableDaemonConfigSchema.parse(read).features?.voiceMode.stt).toEqual(
    read.features.voiceMode.stt,
  );
  const oldPatchSchema = MutableDaemonConfigPatchSchema.omit({ features: true });
  const oldPatch = oldPatchSchema.parse({ relay: { enabled: true } });
  expect(MutableDaemonConfigPatchSchema.parse(oldPatch)).toEqual(oldPatch);
  expect(
    MutableDaemonConfigPatchSchema.parse({
      features: { voiceMode: { stt: { provider: "future", region: "eu" } } },
    }).features?.voiceMode?.stt,
  ).toEqual({ provider: "future", region: "eu" });
});

describe("provider metrics", () => {
  const metrics = [
    { label: "Model", value: "gpt-5.5" },
    { label: "Cache", value: "82%", tone: "ok" },
  ];
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/project",
    model: null,
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
  const turnCompleted = { type: "turn_completed", provider: "codex", turnId: "turn-1" };
  const entry = {
    provider: "codex",
    item: { type: "assistant_message", text: "Done" },
    timestamp: "2026-11-22T00:00:00.000Z",
    seqStart: 1,
    seqEnd: 1,
    sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    collapsed: [],
  };

  test("new apps read session, turn and timeline metrics from a new daemon", () => {
    expect(
      AgentSnapshotPayloadSchema.parse({ ...snapshot, sessionMetrics: metrics }).sessionMetrics,
    ).toEqual(metrics);
    expect(AgentStreamEventPayloadSchema.parse({ ...turnCompleted, metrics })).toEqual({
      ...turnCompleted,
      metrics,
    });
    expect(AgentTimelineEntryPayloadSchema.parse({ ...entry, turnMetrics: metrics })).toEqual({
      ...entry,
      turnMetrics: metrics,
    });
  });

  test("new apps accept payloads from daemons that send no metrics", () => {
    expect(AgentSnapshotPayloadSchema.parse(snapshot).sessionMetrics).toBeUndefined();
    expect(AgentStreamEventPayloadSchema.parse(turnCompleted)).toEqual(turnCompleted);
    expect(AgentTimelineEntryPayloadSchema.parse(entry)).toEqual(entry);
  });

  test("apps released before metrics drop the fields they do not know", () => {
    const legacySnapshot = AgentSnapshotPayloadSchema.omit({ sessionMetrics: true });
    const legacyTurnCompleted = z.object({
      type: z.literal("turn_completed"),
      provider: z.string(),
      turnId: z.string().optional(),
    });
    const legacyEntry = AgentTimelineEntryPayloadSchema.omit({ turnMetrics: true });

    expect(legacySnapshot.parse({ ...snapshot, sessionMetrics: metrics })).not.toHaveProperty(
      "sessionMetrics",
    );
    expect(legacyTurnCompleted.parse({ ...turnCompleted, metrics })).toEqual(turnCompleted);
    expect(legacyEntry.parse({ ...entry, turnMetrics: metrics })).toEqual(entry);
  });

  test("metric tone is a closed set, so a new tone needs a capability gate", () => {
    expect(
      AgentTimelineEntryPayloadSchema.safeParse({
        ...entry,
        turnMetrics: [{ label: "Cache", value: "82%", tone: "sparkly" }],
      }).success,
    ).toBe(false);
  });
});
