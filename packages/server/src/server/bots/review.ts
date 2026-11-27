import { createHash, randomUUID } from "node:crypto";
import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import type { Review } from "@jagentdesk/protocol/review/types";
import {
  deriveReviewVerdict,
  REQUIRED_REVIEW_ROLES,
  REVIEW_ROLE_DIMENSIONS,
  renderReviewMarkdown,
} from "../review/cross-review.js";
import type { BotRuntime, BotReviewRole } from "./runtime.js";

export function diffHash(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}
export async function reviewWorker(
  runtime: BotRuntime,
  bot: Bot,
  item: BotItem,
  shouldContinue: () => boolean = () => true,
): Promise<{ reviews: Review[]; diff: string; hash: string; blocked: boolean }> {
  const diff = await runtime.diff(item);
  const reviews: Review[] = [];
  // Sequential bounded peers keep local provider/CPU use bounded and preserve permission cards.
  for (const role of REQUIRED_REVIEW_ROLES) {
    if (!shouldContinue()) throw new Error("Bot review paused");
    const result = await runtime.review(bot, item, role as BotReviewRole, diff);
    reviews.push({
      id: randomUUID(),
      role,
      reviewerAgentId: result.agentId,
      reviewerLabel: role,
      verdict: deriveReviewVerdict(role, result.findings),
      findings: result.findings,
      coverage: result.coverage,
      createdAt_ms: Date.now(),
    });
  }
  if (!shouldContinue()) throw new Error("Bot review paused");
  if (diff !== (await runtime.diff(item)))
    throw new Error("Worktree changed during review; review must run again");
  return {
    reviews,
    diff,
    hash: diffHash(diff),
    blocked: reviews.some((r) => r.verdict === "request_changes"),
  };
}
export function reviewSummary(reviews: Review[]): string {
  return reviews
    .map((r) => `### ${r.role}\n${renderReviewMarkdown(r.verdict, r.findings, r.coverage)}`)
    .join("\n\n");
}

/** Spec 37.3.7 step 2: critical/high always block; medium blocks in the role's own dimension. */
export function blockingFindingCount(reviews: Review[]): number {
  return reviews.reduce(
    (sum, review) =>
      sum +
      review.findings.filter(
        (finding) =>
          finding.severity === "critical" ||
          finding.severity === "high" ||
          (finding.severity === "medium" &&
            (REVIEW_ROLE_DIMENSIONS[review.role]?.has(finding.category) ?? false)),
      ).length,
    0,
  );
}
