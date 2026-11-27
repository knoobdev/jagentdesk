/**
 * One connector event, shaped like Orca's AutomationRunEvent (src/shared/automation-event-triggers.ts:193-222).
 * Every event fires automations, whoever sent it; Who can ask gates only asking the bot
 * (Orca automation-event-triggers.ts:13-16, spec 37.2.6).
 */
export interface BotConnectorEvent {
  botId: string;
  source: "github" | "gitlab" | "telegram";
  /** A kind from `BOT_CONNECTOR_EVENT_KINDS[source]`. */
  event: string;
  /** The source's own id for the event; one run per key. */
  key: string;
  /** The thread, PR or issue: "owner/repo#12", "group/project!3", "<chat>:<message>". */
  subject?: string;
  occurredAt: number;
  actor?: string;
  actorId?: string;
  fromOwner?: true;
  place?: string;
  url?: string;
  text?: string;
}

/** Orca's GitHub kinds (automation-event-triggers.ts:19-41) plus the GitLab and Telegram kinds of spec 37.11.2 / 37.12. */
export const BOT_CONNECTOR_EVENT_KINDS = {
  github: [
    "issue_opened",
    "pr_opened",
    "pr_pushed",
    "pr_merged",
    "comment",
    "review_comment",
    "review",
    "mentioned",
    "review_requested",
    "assigned",
    "ci_failed",
    "ci_passed",
    "ci_finished",
    "pr_conflicted",
    "pr_closed",
    "pr_ready",
    "labeled",
    "issue_closed",
    "deploy_finished",
    "security_alert",
    "workflow_finished",
  ],
  gitlab: [
    "mr_opened",
    "mr_pushed",
    "mr_updated",
    "mr_merged",
    "mr_closed",
    "comment",
    "mentioned",
    "issue_opened",
    "issue_closed",
    "ci_failed",
    "ci_passed",
    "ci_finished",
  ],
  telegram: ["mentioned", "message"],
} as const;

/** Where automations (bt1's engine) listen for connector events. */
export class BotConnectorEvents {
  private readonly listeners = new Set<(event: BotConnectorEvent) => void>();
  on(listener: (event: BotConnectorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: BotConnectorEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
