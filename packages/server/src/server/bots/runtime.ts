import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import type { BotFirstScreen } from "@jagentdesk/protocol/bots/views";
import type { ReviewFinding } from "@jagentdesk/protocol/review/types";
export type BotReviewRole = "ba" | "tester" | "pentester";
export interface BotRuntimeEvent {
  agentId: string;
  kind: "done" | "ask" | "error" | "escalation" | "resolved";
  key: string;
  text: string;
}
export interface BotExternalMessage {
  senderId: string;
  title: string;
  beforeDispatch: () => void;
}

/** Labels the daemon puts on the agents a bot owns. */
export const BOT_ID_LABEL = "jagentdesk.bot.id";
/** `home` | `side` | `look_around` | `tidy_up` | `automation` | `worker`. */
export const BOT_ROLE_LABEL = "jagentdesk.bot.role";
/** The chat (agent id) that started a worker; workers list under it in the Chats tree. */
export const BOT_CHAT_LABEL = "jagentdesk.bot.chat";

/** Look around and Tidy memory runs: held to reads (or nothing) by the daemon's gate. */
export function isBotBackgroundRun(...labelSets: (Record<string, string> | undefined)[]): boolean {
  return labelSets.some((labels) => {
    const role = labels?.[BOT_ROLE_LABEL];
    return role === "look_around" || role === "tidy_up";
  });
}

export interface BotAgentSnapshot {
  id: string;
  title: string;
  labels: Record<string, string>;
  busy: boolean;
  lifecycle: string;
  pendingPermissions: { id: string; name: string; kind: string; title?: string }[];
  createdAt_ms: number;
  updatedAt_ms: number;
  cwd: string;
  workspaceId?: string;
  parentId?: string;
}

export interface BotBackgroundRun {
  kind: "look_around" | "tidy_up";
  title: string;
  prompt: string;
  /** `look-around`: reads only; `reply-only`: no tool at all (spec 37.2.6, ADR-0046). */
  policy: "look-around" | "reply-only";
  timeoutMs: number;
}

export interface BotRuntime {
  ensureSupervisor(bot: Bot, home: string): Promise<string>;
  /** Validates provider/model and resolves `permissionMode` to the round-1 `modeId`/`unattended`. */
  configure(bot: Bot): Promise<{ modeId: string; unattended: boolean }>;
  /** The provider's mode that runs tools without asking, if it has one. */
  bypassModeId(bot: Bot): Promise<string | undefined>;
  busy(agentId: string): boolean | Promise<boolean>;
  send(
    agentId: string,
    text: string,
    messageId?: string,
    sourceAgentId?: string,
    external?: BotExternalMessage,
  ): Promise<void>;
  startWorker(
    bot: Bot,
    item: BotItem,
    repo: string,
    assignment: string,
    linked: (agentId: string, worktree: string, baseCommit: string) => void,
  ): Promise<string>;
  review(
    bot: Bot,
    item: BotItem,
    role: BotReviewRole,
    diff: string,
  ): Promise<{ agentId: string; findings: ReviewFinding[]; coverage: string }>;
  diff(item: BotItem): Promise<string>;
  cancel(agentId: string): Promise<void>;
  /** Starts a visible background conversation in the bot's home; `done` settles with its last reply. */
  runBackground(
    bot: Bot,
    home: string,
    run: BotBackgroundRun,
  ): Promise<{ agentId: string; done: Promise<string> }>;
  /** Archives the Home Chat agent so the next delivery starts a new one (spec 37.3.5). */
  resetHome(bot: Bot): Promise<void>;
  /** Agents the bot owns or that work for it, for Needs you and the Chats tree. */
  agents(bot: Bot): BotAgentSnapshot[];
  /** Hand to bot (spec 37.4.11): the workspace's agents keep running and work for the bot. */
  handOver(bot: Bot, workspaceId: string): Promise<{ title: string; agentIds: string[] }>;
  firstScreen(): Promise<BotFirstScreen>;
  onEvent(listener: (event: BotRuntimeEvent) => void): () => void;
  dispose(): void;
}
