import type {
  Review,
  ReviewFinding,
  ReviewRole,
  ReviewTaskStatus,
  ReviewVerdict,
} from "@jagentdesk/protocol/review/types";

// Which review categories each role is the owner of (open-code-review dimension split). A medium
// finding in your own dimension blocks; criticals/highs from anyone always block.
export const REVIEW_ROLE_DIMENSIONS: Readonly<Partial<Record<ReviewRole, ReadonlySet<string>>>> = {
  ba: new Set(["maintainability", "documentation", "other"]),
  tester: new Set(["test", "bug"]),
  pentester: new Set(["security"]),
};
export const REQUIRED_REVIEW_ROLES: readonly ReviewRole[] = ["ba", "tester", "pentester"];

// The daemon (not the agent) decides the verdict from the findings: any critical/high blocks, and a
// medium in the role's own dimension blocks; otherwise it's an approval.
export function deriveReviewVerdict(
  role: ReviewRole,
  findings: readonly ReviewFinding[],
): ReviewVerdict {
  const core = REVIEW_ROLE_DIMENSIONS[role];
  const blocking = findings.some(
    (f) =>
      f.severity === "critical" ||
      f.severity === "high" ||
      (f.severity === "medium" && (core?.has(f.category) ?? false)),
  );
  return blocking ? "request_changes" : "approve";
}

// A task under review is done only once every required role's latest review approves; a single
// request_changes sends it back to in_progress; otherwise it stays in review awaiting the rest.
export function deriveTaskStatusFromReviews(
  reviews: readonly Pick<Review, "role" | "verdict">[],
): ReviewTaskStatus {
  const latestByRole = new Map<ReviewRole, Pick<Review, "role" | "verdict">>();
  for (const r of reviews) latestByRole.set(r.role, r);
  const latest = [...latestByRole.values()];
  if (latest.some((r) => r.verdict === "request_changes")) return "in_progress";
  const allApproved = REQUIRED_REVIEW_ROLES.every(
    (role) => latestByRole.get(role)?.verdict === "approve",
  );
  return allApproved ? "done" : "review";
}

const SEVERITY_ICON: Record<string, string> = {
  critical: "🟥",
  high: "🟧",
  medium: "🟨",
  low: "⬜",
};

// Render structured findings as a Markdown summary for the task comment + thread timeline.
export function renderReviewMarkdown(
  verdict: ReviewVerdict,
  findings: readonly ReviewFinding[],
  coverage: string,
): string {
  const head = verdict === "approve" ? "✅ **Approved**" : "🔴 **Changes requested**";
  const cov = coverage ? ` · _${coverage}_` : "";
  if (findings.length === 0) return `${head}${cov} — no blocking findings.`;
  const lines = findings.map((f) => {
    const where = f.startLine ? `\`${f.path}:${f.startLine}\`` : `\`${f.path}\``;
    const icon = SEVERITY_ICON[f.severity] ?? "⬜";
    const sug = f.suggestion ? `\n  ↳ ${f.suggestion}` : "";
    return `- ${icon} **${f.severity}/${f.category}** ${where} — ${f.content}${sug}`;
  });
  return `${head}${cov}\n${lines.join("\n")}`;
}
