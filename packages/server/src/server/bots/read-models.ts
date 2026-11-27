// The read models the bot panels draw (spec 37.4.1, 37.4.4, 37.4.6), built from the daemon's state.
// Pure: the service passes in the bot, its agents, items and run states.
import { getJAgentDeskToolLabel } from "@jagentdesk/protocol/jagentdesk-tool-presentation/index";
import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import type {
  BotAutomation,
  BotChat,
  BotChatTree,
  BotChatWorker,
  BotNeedsYouRow,
} from "@jagentdesk/protocol/bots/views";
import {
  LOOK_AROUND_EVERY_LABELS,
  TIDY_UP_EVERY_LABELS,
  botItemGroupOf,
  botItemStaleDays,
  botLookAround,
  lookAroundSupported,
} from "@jagentdesk/protocol/bots/rules";
import { BOT_CHAT_LABEL, BOT_ROLE_LABEL, type BotAgentSnapshot } from "./runtime.js";

export interface RunState {
  running: boolean;
  runAgentId?: string;
  lastAgentId?: string;
  error?: string;
}

const CONNECTOR_NAMES = {
  slack: "Slack",
  github: "GitHub",
  gitlab: "GitLab",
  telegram: "Telegram",
} as const;

function approvalRow(
  bot: Bot,
  agent: BotAgentSnapshot,
  request: BotAgentSnapshot["pendingPermissions"][number],
  known: ReadonlySet<string>,
): BotNeedsYouRow {
  const row: BotNeedsYouRow = {
    key: `approval:${agent.id}:${request.id}`,
    kind: "approval",
    tool: request.name,
    agentId: agent.id,
    requestId: request.id,
    // A JAgentDesk tool by its label ("Start worker"), never its tool name.
    title: request.name
      ? `Permission · ${getJAgentDeskToolLabel(request.name) ?? request.name}`
      : "Permission needed",
    at_ms: agent.updatedAt_ms,
  };
  const isWorker = agent.id !== bot.agentId && agent.labels[BOT_ROLE_LABEL] !== "side";
  if (isWorker) row.workerName = agent.title;
  const chat = agent.labels[BOT_CHAT_LABEL] ?? agent.parentId ?? bot.agentId;
  if (chat && known.has(chat)) row.chatAgentId = chat;
  if (request.title) row.detail = request.title;
  return row;
}

function questionRow(
  bot: Bot,
  agent: BotAgentSnapshot,
  request: BotAgentSnapshot["pendingPermissions"][number],
): BotNeedsYouRow {
  return {
    key: `question:${agent.id}:${request.id}`,
    kind: "question",
    agentId: agent.id,
    requestId: request.id,
    chatTitle: agent.id === bot.agentId ? "Home Chat" : agent.title,
    title: `Your chat with ${bot.name}`,
    detail: request.title ?? "Waiting for you",
    at_ms: agent.updatedAt_ms,
  };
}

function itemRow(item: BotItem): BotNeedsYouRow {
  const row: BotNeedsYouRow = {
    key: `item:${item.id}`,
    kind: "item",
    itemId: item.id,
    title: item.title,
    at_ms: item.lastActivityAt_ms ?? item.updatedAt_ms,
  };
  if (item.number) row.itemNumber = item.number;
  const first = item.question?.decisions?.[0];
  if (first) row.detail = first.prompt;
  return row;
}

/** Needs you (spec 37.4.4): approvals, chat questions, connectors to fix, then Needs you items. */
export function needsYouRows(
  bot: Bot,
  agents: readonly BotAgentSnapshot[],
  items: readonly BotItem[],
  now: number,
): BotNeedsYouRow[] {
  const known = new Set(agents.map((agent) => agent.id));
  const approvals: BotNeedsYouRow[] = [];
  const questions: BotNeedsYouRow[] = [];
  for (const agent of agents) {
    for (const request of agent.pendingPermissions) {
      if (request.kind === "question") questions.push(questionRow(bot, agent, request));
      else approvals.push(approvalRow(bot, agent, request, known));
    }
  }
  const connectors = (Object.keys(CONNECTOR_NAMES) as (keyof typeof CONNECTOR_NAMES)[])
    .filter((name) => bot[name]?.needsFix)
    .map(
      (name): BotNeedsYouRow => ({
        key: `connector:${name}`,
        kind: "connector",
        connector: name,
        title: `${CONNECTOR_NAMES[name]} needs you to sign in again or fix it.`,
        at_ms: bot.updatedAt_ms,
      }),
    );
  const staleDays = botItemStaleDays(bot.itemsStale);
  const waiting = items
    .filter((item) => botItemGroupOf(item, staleDays, now) === "needs_you")
    .sort(
      (a, b) => (b.lastActivityAt_ms ?? b.updatedAt_ms) - (a.lastActivityAt_ms ?? a.updatedAt_ms),
    )
    .map(itemRow);
  return [...approvals, ...questions, ...connectors, ...waiting];
}

function workerState(agent: BotAgentSnapshot): BotChatWorker["state"] {
  if (agent.pendingPermissions.length > 0) return "needs-you";
  if (agent.busy) return "running";
  if (agent.lifecycle === "error") return "failed";
  if (agent.lifecycle === "closed") return "stopped";
  return "done";
}

const CHAT_ROLES: ReadonlySet<string> = new Set(["side", "look_around", "tidy_up", "automation"]);
type RunRole = "look_around" | "tidy_up" | "automation";

function runRole(role: string | undefined): RunRole | null {
  return role === "look_around" || role === "tidy_up" || role === "automation" ? role : null;
}

function chatKind(bot: Bot, agent: BotAgentSnapshot, role: RunRole | null): BotChat["kind"] {
  if (agent.id === bot.agentId) return "home";
  return role ? "automation" : "side";
}

function chatTitle(bot: Bot, agent: BotAgentSnapshot): string {
  if (agent.id === bot.agentId) return "Home Chat";
  const role = agent.labels[BOT_ROLE_LABEL];
  if (role === "look_around") return "Look around";
  if (role === "tidy_up") return "Tidy memory";
  return agent.title;
}

function runStateOf(
  role: RunRole,
  agent: BotAgentSnapshot,
  runs: { look: RunState; tidy: RunState },
): "running" | "done" | "failed" {
  if (role === "automation") return agent.busy ? "running" : "done";
  const state = role === "look_around" ? runs.look : runs.tidy;
  if (state.runAgentId === agent.id) return "running";
  return state.lastAgentId === agent.id && state.error ? "failed" : "done";
}

function liveOf(agent: BotAgentSnapshot): BotChat["live"] {
  if (agent.pendingPermissions.length > 0) return "needs-you";
  return agent.busy ? "replying" : "idle";
}

function workerOf(agent: BotAgentSnapshot, item: BotItem | undefined): BotChatWorker {
  const worker: BotChatWorker = {
    agentId: agent.id,
    title: agent.title,
    state: workerState(agent),
    startedAt_ms: agent.createdAt_ms,
  };
  if (item) worker.itemId = item.id;
  if (item?.worktree) worker.worktree = item.worktree;
  if (!agent.busy) worker.settledAt_ms = agent.updatedAt_ms;
  return worker;
}

/** The chat a worker lists under: the chat that started it, else Home Chat. */
function parentChat(
  bot: Bot,
  agent: BotAgentSnapshot,
  chatIds: ReadonlySet<string>,
  item: BotItem | undefined,
): string | undefined {
  const labeled = agent.labels[BOT_CHAT_LABEL];
  if (labeled) return labeled;
  if (agent.parentId && chatIds.has(agent.parentId)) return agent.parentId;
  // A sub-agent of a worker lists with its worker, not as a worker of its own.
  if (agent.parentId && !item && agent.labels[BOT_ROLE_LABEL] !== "worker") return undefined;
  return bot.agentId;
}

/** Chats tree (spec 37.4.1, 37.4.6): Home Chat, then other chats newest first, each with its workers. */
export function chatTree(input: {
  bot: Bot;
  agents: readonly BotAgentSnapshot[];
  items: readonly BotItem[];
  runs: { look: RunState; tidy: RunState };
  query?: string;
  workspaceTitle: (workspaceId: string) => string;
}): BotChatTree {
  const { bot, agents, items, runs } = input;
  const itemOfWorker = new Map<string, BotItem>();
  for (const item of items) for (const id of item.workerAgentIds) itemOfWorker.set(id, item);
  const chatAgents = agents.filter(
    (agent) => agent.id === bot.agentId || CHAT_ROLES.has(agent.labels[BOT_ROLE_LABEL] ?? ""),
  );
  const chatIds = new Set(chatAgents.map((agent) => agent.id));
  const workersOf = new Map<string, BotChatWorker[]>();
  for (const agent of agents) {
    if (chatIds.has(agent.id)) continue;
    const item = itemOfWorker.get(agent.id);
    const parent = parentChat(bot, agent, chatIds, item);
    if (!parent) continue;
    workersOf.set(parent, [...(workersOf.get(parent) ?? []), workerOf(agent, item)]);
  }
  const toChat = (agent: BotAgentSnapshot): BotChat => {
    const role = runRole(agent.labels[BOT_ROLE_LABEL]);
    const workers = (workersOf.get(agent.id) ?? []).sort((a, b) => b.startedAt_ms - a.startedAt_ms);
    const chat: BotChat = {
      id: agent.id,
      kind: chatKind(bot, agent, role),
      title: chatTitle(bot, agent),
      live: liveOf(agent),
      lastActiveAt_ms: agent.updatedAt_ms,
      workers,
      runningTotal: workers.filter((w) => w.state === "running").length,
      waitingTotal: workers.filter((w) => w.state === "needs-you").length,
    };
    if (role) chat.run = { kind: role, state: runStateOf(role, agent, runs) };
    return chat;
  };
  const needle = input.query?.trim().toLowerCase();
  const matches = (chat: BotChat) =>
    !needle ||
    chat.title.toLowerCase().includes(needle) ||
    chat.workers.some((worker) => worker.title.toLowerCase().includes(needle));
  const home = chatAgents.find((agent) => agent.id === bot.agentId);
  const homeChat = home ? toChat(home) : undefined;
  const tree: BotChatTree = {
    chats: chatAgents
      .filter((agent) => agent.id !== bot.agentId)
      .map(toChat)
      .filter(matches)
      .sort((a, b) => b.lastActiveAt_ms - a.lastActiveAt_ms),
    workspaces: (bot.handedWorkspaces ?? []).map((entry) => ({
      workspaceId: entry.workspaceId,
      title: input.workspaceTitle(entry.workspaceId),
    })),
  };
  if (homeChat && matches(homeChat)) tree.home = homeChat;
  return tree;
}

function stateOf(run: RunState, on: boolean): BotAutomation["state"] {
  if (run.running) return "running";
  if (run.error) return "failed";
  return on ? "idle" : "stopped";
}

/** Automations (spec 37.4.4): Look around, Tidy memory (Claude/Codex only), core schedules, open waits. */
export function automationRows(input: {
  bot: Bot;
  items: readonly BotItem[];
  runs: { look: RunState; tidy: RunState };
  nextLookAt?: number;
  nextTidyAt?: number;
  /** The bot's core schedules, as rows (`scheduleAutomationRow`). */
  schedules: readonly BotAutomation[];
}): BotAutomation[] {
  const { bot, runs } = input;
  const rows: BotAutomation[] = [];
  if (lookAroundSupported(bot.provider)) {
    const setting = botLookAround(bot);
    const look: BotAutomation = {
      id: "look_around",
      kind: "look_around",
      name: "Look around",
      when: LOOK_AROUND_EVERY_LABELS[setting.every],
      state: stateOf(runs.look, setting.on),
      enabled: setting.on,
    };
    if (setting.on && input.nextLookAt) look.nextAt_ms = input.nextLookAt;
    rows.push(look);
    const tidySetting = bot.tidyUp ?? { on: true, every: "night" as const };
    const tidy: BotAutomation = {
      id: "tidy_up",
      kind: "tidy_up",
      name: "Tidy memory",
      when: TIDY_UP_EVERY_LABELS[tidySetting.every],
      state: stateOf(runs.tidy, tidySetting.on),
      enabled: tidySetting.on,
    };
    if (tidySetting.on && input.nextTidyAt) tidy.nextAt_ms = input.nextTidyAt;
    rows.push(tidy);
  }
  rows.push(...input.schedules);
  for (const item of input.items) {
    if (item.status !== "waiting") continue;
    const row: BotAutomation = {
      id: `wait:${item.id}`,
      kind: "wait",
      name: item.wait?.text ?? item.waitFor?.condition ?? item.title,
      state: "idle",
      enabled: true,
      itemId: item.id,
    };
    if (item.waitFor) row.nextAt_ms = item.waitFor.until_ms;
    rows.push(row);
  }
  return rows;
}
