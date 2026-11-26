/**
 * Measures opening a long agent end to end on an isolated in-process daemon (A4.19b.1–2):
 * daemon-side `fetch_agent_timeline_request` duration of the tail page, of the next older page,
 * and daemon RSS growth. Provider histories are synthetic (see the fixtures beside this file).
 *
 *   npx tsx packages/server/src/server/agent/test-utils/large-history/open-agent.bench.ts claude [--restart]
 *
 * `--restart` closes the daemon after the first open and measures a reopen on a fresh daemon that
 * shares the same home, which is the first open after a daemon restart.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import pino from "pino";
import { ClaudeAgentClient } from "../../providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../../providers/codex-app-server-agent.js";
import { generateCodexLargeHistory } from "./codex-fixture.js";
import { OpenCodeV2AgentClient } from "../../providers/opencode/v2/agent.js";
import { V2Harness } from "../../providers/opencode/test-utils/v2-harness.js";
import { generateOpenCodeLargeHistory } from "./opencode-fixture.js";
import type { AgentClient, AgentProvider } from "../../agent-sdk-types.js";
import { createTestJAgentDeskDaemon } from "../../../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../../../test-utils/daemon-client.js";
import { generateClaudeLargeHistory } from "./claude-fixture.js";
import { LONG_AGENT_HISTORY } from "./synthetic-text.js";

interface PreparedProvider {
  provider: AgentProvider;
  cwd: string;
  sessionId: string;
  nativeHandle?: string;
  /** Stored agents carry the model they ran with; an empty one would resolve a default first. */
  model: string;
  client: () => AgentClient;
  expectedItems: number;
  historyBytes: number;
  lastAssistantText: string;
  dispose?: () => Promise<void>;
}

async function prepareClaude(root: string): Promise<PreparedProvider> {
  const history = generateClaudeLargeHistory({ root, size: LONG_AGENT_HISTORY });
  process.env.CLAUDE_CONFIG_DIR = history.configDir;
  return {
    provider: "claude",
    model: "claude-opus-4-5-20251101",
    cwd: history.cwd,
    sessionId: history.sessionId,
    expectedItems: history.expectedItems,
    historyBytes: statSync(history.transcriptPath).size,
    lastAssistantText: history.lastAssistantText,
    client: () =>
      new ClaudeAgentClient({
        logger: pino({ level: "silent" }),
        queryFactory: () => {
          throw new Error("Opening history must not query Claude");
        },
        resolveBinary: async () => process.execPath,
        resolveVersion: async () => "2.1.220",
      }),
  };
}

async function prepareCodex(root: string): Promise<PreparedProvider> {
  const history = generateCodexLargeHistory({ root, size: LONG_AGENT_HISTORY });
  process.env.CODEX_HOME = history.codexHome;
  return {
    provider: "codex",
    model: "gpt-5.1-codex",
    cwd: history.cwd,
    sessionId: history.threadId,
    nativeHandle: history.threadId,
    expectedItems: history.expectedItems,
    historyBytes: statSync(history.rolloutPath).size,
    lastAssistantText: history.lastAssistantText,
    client: () =>
      new CodexAppServerAgentClient(pino({ level: "silent" }), {
        env: { CODEX_HOME: history.codexHome },
      }),
  };
}

/**
 * OpenCode 2.x keeps sessions in its own SQLite store behind `opencode serve`. The real client
 * runs against an in-process v2 API here, so OpenCode's own read of its store is not measured;
 * everything the daemon does with the 2 400 messages (paged `message.list`, projection,
 * snapshot) is.
 */
async function prepareOpenCode(root: string): Promise<PreparedProvider> {
  const cwd = path.join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const history = generateOpenCodeLargeHistory({ size: LONG_AGENT_HISTORY, cwd });
  const harness = new V2Harness();
  harness.info.location.directory = cwd;
  harness.history.push(...history.messages);
  // Report which operation the daemon reached that the harness does not serve.
  const api = harness.api as unknown as Record<string, Record<string, unknown>>;
  for (const [group, operations] of Object.entries(api)) {
    for (const [name, operation] of Object.entries(operations)) {
      if (typeof operation === "function" && operation.name === "unexpected") {
        operations[name] = async () => {
          throw new Error(`OpenCode harness does not serve ${group}.${name}`);
        };
      }
    }
  }
  // Reopening applies the stored model and agent.
  harness.api.session.switchModel = async ({ model }) => {
    harness.info.model = model;
  };
  harness.api.session.switchAgent = async ({ agent }) => {
    harness.info.agent = agent;
  };
  // Page like OpenCode does: 100 per page, ordered, continued by cursor.
  harness.api.message.list = async (input) => {
    const ordered = input.order === "desc" ? harness.history.toReversed() : [...harness.history];
    const start = input.cursor ? Number(input.cursor) : 0;
    const limit = input.limit ?? 100;
    const data = ordered.slice(start, start + limit);
    const next = start + limit < ordered.length ? String(start + limit) : undefined;
    return { data, cursor: next ? { next } : {} };
  };
  return {
    provider: "opencode",
    model: "anthropic/claude-sonnet-4-5",
    cwd,
    sessionId: harness.info.id,
    nativeHandle: harness.info.id,
    expectedItems: history.expectedItems,
    historyBytes: history.bytes,
    lastAssistantText: history.lastAssistantText,
    client: () =>
      new OpenCodeV2AgentClient({ logger: pino({ level: "silent" }), runtime: harness.runtime }),
  };
}

function rssMiB(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

async function openOnce(params: {
  prepared: PreparedProvider;
  homeRoot: string;
  agentId: string;
  seed: boolean;
}) {
  const { prepared, homeRoot, agentId } = params;
  const slowRequests: number[] = [];
  const trace: string[] = [];
  let traceStart = 0;
  const logger = pino(
    { level: process.env.BENCH_TRACE ? "debug" : "warn" },
    {
      write(line: string) {
        const record = JSON.parse(line) as {
          msg?: string;
          requestType?: string;
          durationMs?: number;
          time?: number;
          module?: string;
          phases?: Record<string, number>;
        };
        if (traceStart > 0 && record.time && record.time >= traceStart) {
          const phases = record.phases ? ` ${JSON.stringify(record.phases)}` : "";
          trace.push(
            `${record.time - traceStart}ms ${record.module ?? ""} ${record.msg ?? ""}${phases}`,
          );
        }
        if (
          record.msg === "ws_slow_request" &&
          record.requestType === "fetch_agent_timeline_request"
        ) {
          slowRequests.push(record.durationMs ?? -1);
        }
      },
    },
  );
  const daemon = await createTestJAgentDeskDaemon({
    jagentdeskHomeRoot: homeRoot,
    cleanup: false,
    logger,
    agentClients: { [prepared.provider]: prepared.client() },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.10.1",
  });
  try {
    if (params.seed) {
      const now = new Date().toISOString();
      await daemon.daemon.agentStorage.upsert({
        id: agentId,
        provider: prepared.provider,
        cwd: prepared.cwd,
        createdAt: now,
        updatedAt: now,
        title: "Long agent",
        labels: {},
        metadata: {},
        lastStatus: "closed",
        config: { model: prepared.model },
        persistence: {
          provider: prepared.provider,
          sessionId: prepared.sessionId,
          ...(prepared.nativeHandle ? { nativeHandle: prepared.nativeHandle } : {}),
        },
      });
    }
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "bench" } });
    global.gc?.();
    const rssBefore = rssMiB();
    traceStart = Date.now();
    const tailStartedAt = performance.now();
    const tail = await client.fetchAgentTimeline(agentId, {
      direction: "tail",
      limit: 50,
      wholeTurns: true,
      timeout: 600_000,
    });
    const tailMs = performance.now() - tailStartedAt;
    // What the daemon keeps holding for the opened agent, not garbage awaiting collection.
    global.gc?.();
    const rssAfterTail = rssMiB();
    const olderStartedAt = performance.now();
    const older = tail.startCursor
      ? await client.fetchAgentTimeline(agentId, {
          direction: "before",
          cursor: tail.startCursor,
          limit: 50,
          wholeTurns: true,
          timeout: 600_000,
        })
      : null;
    const olderMs = performance.now() - olderStartedAt;
    const last = tail.entries.at(-1)?.item;
    return {
      tailMs: Math.round(tailMs),
      olderMs: Math.round(olderMs),
      daemonSlowRequestMs: slowRequests,
      tailEntries: tail.entries.length,
      olderEntries: older?.entries.length ?? 0,
      window: tail.window,
      hasOlder: tail.hasOlder,
      lastIsExpected:
        last?.type === "assistant_message" && last.text === prepared.lastAssistantText,
      rssBeforeMiB: rssBefore,
      rssAfterTailMiB: rssAfterTail,
      rssGrowthMiB: Math.round((rssAfterTail - rssBefore) * 10) / 10,
      ...(process.env.BENCH_TRACE ? { trace: trace.slice(0, 120) } : {}),
    };
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}

const PREPARE: Record<string, (root: string) => Promise<PreparedProvider>> = {
  claude: prepareClaude,
  codex: prepareCodex,
  opencode: prepareOpenCode,
};

/**
 * `--busy` keeps the event loop about half occupied, as a daemon streaming other agents and
 * serving several clients is. Yielding history replays then wait behind that work.
 */
function startBusyLoad(): () => void {
  const timer = setInterval(() => {
    const until = performance.now() + 8;
    while (performance.now() < until) {
      // Busy work standing in for other agents' stream processing.
    }
  }, 16);
  return () => clearInterval(timer);
}

async function main(): Promise<void> {
  const providerName = process.argv[2] ?? "claude";
  const prepare = PREPARE[providerName];
  if (!prepare) throw new Error(`Unknown provider ${providerName}`);
  const root = await mkdtemp(path.join(os.tmpdir(), "jad-large-history-"));
  try {
    const generatedAt = performance.now();
    const prepared = await prepare(root);
    const generateMs = Math.round(performance.now() - generatedAt);
    const homeRoot = path.join(root, "home");
    const stopBusyLoad = process.argv.includes("--busy") ? startBusyLoad() : () => undefined;
    const agentId = "00000000-0000-4000-8000-00000000a9e7";
    const first = await openOnce({ prepared, homeRoot, agentId, seed: true });
    const result: Record<string, unknown> = {
      provider: providerName,
      generateMs,
      expectedItems: prepared.expectedItems,
      historyMiB: Math.round(prepared.historyBytes / 1024 / 1024),
      first,
    };
    const snapshotPath = path.join(homeRoot, ".jagentdesk", "agent-timelines", `${agentId}.json`);
    result.snapshotMiB = existsSync(snapshotPath)
      ? Math.round((statSync(snapshotPath).size / 1024 / 1024) * 10) / 10
      : null;
    if (process.argv.includes("--restart")) {
      result.afterRestart = await openOnce({ prepared, homeRoot, agentId, seed: false });
    }
    stopBusyLoad();
    result.busy = process.argv.includes("--busy");
    console.log(JSON.stringify(result, null, 2));
    await prepared.dispose?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
