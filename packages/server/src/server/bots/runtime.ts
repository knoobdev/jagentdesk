import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import type { ReviewFinding } from "@jagentdesk/protocol/review/types";
export type BotReviewRole = "ba" | "tester" | "pentester";
export interface BotRuntimeEvent {
  agentId: string;
  kind: "done" | "ask" | "error" | "escalation";
  key: string;
  text: string;
}
export interface BotRuntime {
  ensureSupervisor(bot: Bot, home: string): Promise<string>;
  configure(bot: Bot): Promise<void>;
  busy(agentId: string): boolean | Promise<boolean>;
  send(agentId: string, text: string, messageId?: string, sourceAgentId?: string): Promise<void>;
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
  onEvent(listener: (event: BotRuntimeEvent) => void): () => void;
  dispose(): void;
}
