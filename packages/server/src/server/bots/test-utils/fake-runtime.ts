// An in-process BotRuntime for service tests: no providers, no worktrees. Background runs answer
// with `backgroundReply`; every call is recorded for assertions.
import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import type { BotFirstScreen } from "@jagentdesk/protocol/bots/views";
import type { ReviewFinding } from "@jagentdesk/protocol/review/types";
import type {
  BotAgentSnapshot,
  BotBackgroundRun,
  BotReviewRole,
  BotRuntime,
  BotRuntimeEvent,
} from "../runtime.js";

export class FakeBotRuntime implements BotRuntime {
  sent: { id: string; text: string }[] = [];
  findings: ReviewFinding[] = [];
  reviews: BotReviewRole[] = [];
  background: (BotBackgroundRun & { agentId: string })[] = [];
  backgroundReply: (run: BotBackgroundRun) => Promise<string> = async () => "[]";
  snapshots: BotAgentSnapshot[] = [];
  resets: string[] = [];
  bypass: string | undefined = "bypassPermissions";
  callbacks = new Set<(e: BotRuntimeEvent) => void>();
  async configure(bot: Bot): Promise<{ modeId: string; unattended: boolean }> {
    const mode = bot.permissionMode ?? "same-as-chats";
    return mode === "same-as-chats"
      ? { modeId: "default", unattended: false }
      : { modeId: mode, unattended: mode === this.bypass };
  }
  async bypassModeId(): Promise<string | undefined> {
    return this.bypass;
  }
  async ensureSupervisor(bot: Bot): Promise<string> {
    return bot.agentId ?? `supervisor:${bot.id}`;
  }
  busy(): boolean {
    return false;
  }
  async send(id: string, text: string): Promise<void> {
    this.sent.push({ id, text });
  }
  async startWorker(
    _bot: Bot,
    item: BotItem,
    repo: string,
    _assignment: string,
    linked: (id: string, worktree: string, base: string) => void,
  ): Promise<string> {
    linked(`worker:${item.id}`, `${repo}-worktree`, "base");
    return `worker:${item.id}`;
  }
  async review(_bot: Bot, _item: BotItem, role: BotReviewRole) {
    this.reviews.push(role);
    return {
      agentId: `reviewer:${role}`,
      coverage: "all changed files",
      findings: role === "pentester" ? this.findings : [],
    };
  }
  async diff(): Promise<string> {
    return "diff --git sum.js\n+return a+b";
  }
  async cancel(): Promise<void> {}
  async runBackground(
    _bot: Bot,
    _home: string,
    run: BotBackgroundRun,
  ): Promise<{ agentId: string; done: Promise<string> }> {
    const agentId = `${run.kind}:${this.background.length + 1}`;
    this.background.push({ ...run, agentId });
    return { agentId, done: this.backgroundReply(run) };
  }
  async resetHome(bot: Bot): Promise<void> {
    if (bot.agentId) this.resets.push(bot.agentId);
  }
  agents(): BotAgentSnapshot[] {
    return this.snapshots;
  }
  async handOver(): Promise<{ title: string; agentIds: string[] }> {
    return { title: "fix-login", agentIds: ["handed-agent"] };
  }
  async firstScreen(): Promise<BotFirstScreen> {
    return { projects: { count: 0, names: [] }, workspaces: { count: 0 } };
  }
  emit(event: BotRuntimeEvent): void {
    for (const callback of this.callbacks) callback(event);
  }
  onEvent(cb: (e: BotRuntimeEvent) => void) {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }
  dispose(): void {}
}
