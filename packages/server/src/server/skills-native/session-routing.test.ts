import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import type { SessionOutboundMessage } from "../messages.js";
import { Session, type SessionOptions } from "../session.js";
import { NativeSkillsService } from "./service.js";
import { makeTempRoots, writeSkill } from "./test-utils/fixtures.js";

/**
 * Proves the native skills RPCs are reachable through a real Session
 * (inbound schema, permission map, scope check, dispatch) — a missing entry in
 * any of them means the request is never answered.
 */
let roots: ReturnType<typeof makeTempRoots>;

beforeEach(async () => {
  roots = makeTempRoots();
  await fs.mkdir(roots.home, { recursive: true });
  await fs.mkdir(roots.jdHome, { recursive: true });
});

afterEach(async () => {
  await fs.rm(roots.root, { recursive: true, force: true });
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

function createSession(service: NativeSkillsService, messages: SessionOutboundMessage[]) {
  const options = {
    clientId: "skills-test",
    scopes: ["*"],
    permissions: OWNER_PERMISSIONS,
    onMessage: (message: SessionOutboundMessage) => messages.push(message),
    logger: createTestLogger(),
    jagentdeskHome: roots.jdHome,
    skillsStorage: service,
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

it("answers skills.catalog.list and reports install conflicts as rpc_error codes", async () => {
  await writeSkill(
    path.join(roots.home, ".claude", "skills", "mine"),
    "name: mine\ndescription: Mine.",
  );
  const service = new NativeSkillsService({
    jagentdeskHome: roots.jdHome,
    homeDir: roots.home,
    logger: createTestLogger(),
  });
  await service.initialize();
  const messages: SessionOutboundMessage[] = [];
  const session = createSession(service, messages);

  await session.handleMessage({ type: "skills.catalog.list.request", requestId: "r1" });
  const list = messages.find((message) => message.type === "skills.catalog.list.response");
  expect(list?.payload).toMatchObject({
    requestId: "r1",
    skills: [{ skillId: "global:claude:mine", owned: false }],
  });

  await session.handleMessage({
    type: "skills.author.request",
    requestId: "r2",
    name: "mine",
    description: "Duplicate",
    body: "x",
    scope: "global",
  });
  expect(messages).toContainEqual(
    expect.objectContaining({
      type: "rpc_error",
      payload: expect.objectContaining({ requestId: "r2", code: "skill_name_conflict" }),
    }),
  );

  await session.handleMessage({
    type: "skills.author.request",
    requestId: "r3",
    name: "fresh",
    description: "New skill",
    body: "Body",
    scope: "global",
  });
  const authored = messages.find((message) => message.type === "skills.author.response");
  expect(authored?.payload).toMatchObject({
    requestId: "r3",
    skill: { skillId: "global:agents:fresh", owned: true },
  });

  await session.handleMessage({ type: "skills.get.request", requestId: "r4" });
  const legacy = messages.find((message) => message.type === "skills.get.response");
  expect(legacy?.payload).toMatchObject({ requestId: "r4", skills: [{ name: "fresh" }] });
});
