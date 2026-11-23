import { z } from "zod";

export const ReviewRoleSchema = z.enum([
  "supervisor",
  "lead",
  "peer",
  "ba",
  "tester",
  "pentester",
  "reviewer",
  "user",
  "system",
]);
export type ReviewRole = z.infer<typeof ReviewRoleSchema>;

export const ReviewVerdictSchema = z.enum(["approve", "request_changes"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewCategorySchema = z.enum([
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
]);
export type ReviewCategory = z.infer<typeof ReviewCategorySchema>;

export const ReviewSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

// One evidence-carrying finding: where (file + line range), what kind, how bad, the issue, and an
// optional suggested fix. Line anchors + description are the evidence contract (a finding without a
// path is rejected upstream).
export const ReviewFindingSchema = z.object({
  path: z.string(),
  startLine: z.number().int().nullable().default(null),
  endLine: z.number().int().nullable().default(null),
  category: ReviewCategorySchema,
  severity: ReviewSeveritySchema,
  content: z.string(),
  suggestion: z.string().nullable().default(null),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

// A completed role review of a task: the findings + the daemon-derived verdict + a coverage note.
export const ReviewSchema = z.object({
  id: z.string(),
  role: ReviewRoleSchema,
  reviewerAgentId: z.string(),
  reviewerLabel: z.string(),
  verdict: ReviewVerdictSchema,
  findings: z.array(ReviewFindingSchema),
  // Free-text coverage note (e.g. "reviewed 3/3 changed files"), open-code-review's coverage accounting.
  coverage: z.string().default(""),
  createdAt_ms: z.number().int(),
});
export type Review = z.infer<typeof ReviewSchema>;

export type ReviewTaskStatus = "in_progress" | "review" | "done";
