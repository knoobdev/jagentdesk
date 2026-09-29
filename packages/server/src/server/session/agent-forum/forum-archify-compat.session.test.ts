import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_CAPS } from "@jagentdesk/protocol/client-capabilities";
import type { StoredForumTopic } from "@jagentdesk/protocol/agent-forum/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ARCHIFY_LEGACY_PLACEHOLDER } from "../../agent-forum/archify-compat.js";
import { AgentForumService } from "../../agent-forum/service.js";
import { OWNER_PERMISSIONS } from "../../authorization/index.js";
import type { SessionOutboundMessage } from "../../messages.js";
import { Session, type SessionOptions } from "../../session.js";

// COMPAT(archifyDiagrams): added after v0.9.43, remove after 2027-03-29.
// Through a real Session: a client that did not advertise archify_diagrams must receive archify
// versions as a Mermaid placeholder (its schema pins format to "mermaid"), on both the forum.stream
// push and forum RPC responses; a capable client receives them unchanged.

let dir: string;
let service: AgentForumService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jad-forum-compat-session-"));
  service = new AgentForumService({
    dir,
    logger: createTestLogger(),
    renderArchify: async () => ({ ok: true, diagramType: "architecture", html: "<html></html>" }),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Any dependency the constructor touches becomes a no-op function. */
function stub<T>(overrides: Record<string, unknown> = {}): T {
  return new Proxy(overrides, {
    get: (target, key) => {
      if (key in target) return target[key as string];
      if (key === "then") return undefined;
      return vi.fn(() => () => undefined);
    },
  }) as T;
}

interface Sink {
  messages: SessionOutboundMessage[];
  targeted: Array<{ source: object; message: SessionOutboundMessage }>;
}

function createSession(sink: Sink, perSource: boolean): Session {
  const options = {
    clientId: "forum-compat-test",
    scopes: ["*"],
    permissions: OWNER_PERMISSIONS,
    onMessage: (message: SessionOutboundMessage) => sink.messages.push(message),
    ...(perSource
      ? {
          onMessageToSource: (source: object, message: SessionOutboundMessage) =>
            sink.targeted.push({ source, message }),
        }
      : {}),
    logger: createTestLogger(),
    jagentdeskHome: dir,
    agentForumService: service,
    downloadTokenStore: stub(),
    pushTokenStore: stub(),
    agentManager: stub({ listAgents: () => [], listProviderSubagentActivity: () => [] }),
    agentStorage: stub(),
    projectRegistry: stub(),
    workspaceRegistry: stub(),
    chatService: stub(),
    scheduleService: stub(),
    loopService: stub(),
    checkoutDiffManager: stub(),
    workspaceGitService: stub(),
    workspaceAutoName: stub(),
    daemonConfigStore: stub({ get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }) }),
    stt: null,
    tts: null,
    terminalManager: null,
    providerSnapshotManager: stub(),
    providerUsageService: stub(),
  } as unknown as SessionOptions;
  return new Session(options);
}

async function createArchifyTopic(): Promise<StoredForumTopic> {
  const topic = await service.createTopic({ prompt: "Build a todo app" });
  const result = await service.setDiagram(topic.id, {
    format: "archify",
    source: '{"diagram_type":"architecture"}',
    title: "Architecture",
    byAgentId: "agent_lead",
    byLabel: "Lead",
    role: "lead",
  });
  if (!result.ok) throw new Error("setDiagram failed");
  return result.topic;
}

function streamedDiagram(message: SessionOutboundMessage | undefined) {
  if (message?.type !== "forum.stream") throw new Error("expected forum.stream");
  return message.payload.topic.diagrams[0];
}

describe("forum.stream", () => {
  test("each socket gets archify or the Mermaid placeholder by its own capability", async () => {
    const topic = await createArchifyTopic();
    const stored = topic.diagrams[0]!;
    const sink: Sink = { messages: [], targeted: [] };
    const session = createSession(sink, true);
    const legacySocket = {};
    const capableSocket = {};
    session.updateClientCapabilities(null, legacySocket);
    session.updateClientCapabilities({ [CLIENT_CAPS.archifyDiagrams]: true }, capableSocket);

    session.emitForumStream(topic);

    expect(sink.messages).toEqual([]);
    const bySource = new Map(sink.targeted.map((entry) => [entry.source, entry.message]));
    expect(streamedDiagram(bySource.get(legacySocket))).toEqual({
      id: stored.id,
      version: 1,
      title: "Architecture",
      format: "mermaid",
      source: ARCHIFY_LEGACY_PLACEHOLDER,
      authorAgentId: "agent_lead",
      authorLabel: "Lead",
      note: "",
      createdAt_ms: stored.createdAt_ms,
    });
    expect(streamedDiagram(bySource.get(capableSocket))).toEqual(stored);
  });

  test("without per-socket delivery the hello capabilities decide", async () => {
    const topic = await createArchifyTopic();
    const legacy: Sink = { messages: [], targeted: [] };
    createSession(legacy, false).emitForumStream(topic);
    expect(streamedDiagram(legacy.messages[0])).toMatchObject({ format: "mermaid" });

    const capable: Sink = { messages: [], targeted: [] };
    const session = createSession(capable, false);
    session.updateClientCapabilities({ [CLIENT_CAPS.archifyDiagrams]: true });
    session.emitForumStream(topic);
    expect(streamedDiagram(capable.messages[0])).toMatchObject({ format: "archify" });
  });
});

describe("forum RPC responses", () => {
  async function forumGet(capabilities: Record<string, unknown> | null) {
    const topic = await createArchifyTopic();
    const sink: Sink = { messages: [], targeted: [] };
    const session = createSession(sink, false);
    session.updateClientCapabilities(capabilities);
    await session.handleMessage({ type: "forum/get", requestId: "req-1", topicId: topic.id });
    const response = sink.messages.find((message) => message.type === "forum/get/response");
    if (response?.type !== "forum/get/response") throw new Error("no forum/get response");
    return response.payload.topic!.diagrams[0]!;
  }

  test("an old client's forum/get carries the Mermaid placeholder", async () => {
    const diagram = await forumGet(null);
    expect(diagram).toMatchObject({ format: "mermaid", source: ARCHIFY_LEGACY_PLACEHOLDER });
    expect(diagram).not.toHaveProperty("diagramType");
    expect(diagram).not.toHaveProperty("renderStatus");
  });

  test("a capable client's forum/get carries the archify version", async () => {
    const diagram = await forumGet({ [CLIENT_CAPS.archifyDiagrams]: true });
    expect(diagram).toMatchObject({ format: "archify", diagramType: "architecture" });
  });
});
