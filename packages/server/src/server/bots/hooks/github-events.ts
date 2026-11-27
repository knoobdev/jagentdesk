import { z } from "zod";

/** The 11 webhook events a bot's hook subscribes to (spec 37.10.1). */
export const GITHUB_HOOK_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_suite",
  "workflow_run",
  "deployment_status",
  "dependabot_alert",
  "code_scanning_alert",
  "secret_scanning_alert",
] as const;

const User = z.object({ login: z.string(), id: z.number().optional() }).passthrough();
const Repository = z.object({ full_name: z.string(), html_url: z.string().optional() });
const Issue = z.object({
  number: z.number(),
  title: z.string().optional(),
  html_url: z.string().optional(),
  pull_request: z.unknown().optional(),
});
const PullRequest = z.object({
  number: z.number(),
  title: z.string().optional(),
  html_url: z.string().optional(),
  merged: z.boolean().nullish(),
  mergeable_state: z.string().nullish(),
});
const Comment = z.object({
  id: z.number(),
  body: z.string().nullish(),
  html_url: z.string().optional(),
  user: User.optional(),
});
export const GitHubPayloadSchema = z
  .object({
    action: z.string().optional(),
    sender: User.optional(),
    repository: Repository.optional(),
    organization: z.object({ login: z.string() }).optional(),
    hook_id: z.number().optional(),
    issue: Issue.optional(),
    pull_request: PullRequest.optional(),
    comment: Comment.optional(),
    review: z
      .object({
        id: z.number(),
        body: z.string().nullish(),
        state: z.string().optional(),
        html_url: z.string().optional(),
      })
      .optional(),
    label: z.object({ name: z.string() }).optional(),
    check_suite: z
      .object({
        id: z.number(),
        conclusion: z.string().nullish(),
        head_branch: z.string().nullish(),
        pull_requests: z.array(z.object({ number: z.number() })).optional(),
      })
      .optional(),
    workflow_run: z
      .object({
        id: z.number(),
        name: z.string().nullish(),
        conclusion: z.string().nullish(),
        html_url: z.string().optional(),
      })
      .optional(),
    deployment_status: z
      .object({ state: z.string(), environment: z.string().optional() })
      .optional(),
    alert: z
      .object({
        number: z.number().optional(),
        html_url: z.string().optional(),
        secret_type_display_name: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();
export type GitHubPayload = z.infer<typeof GitHubPayloadSchema>;

export interface GitHubEventFacts {
  kinds: string[];
  /** "owner/repo#12" for an issue or pull request. */
  subject?: string;
  repo?: string;
  number?: number;
  actor?: string;
  url?: string;
  text?: string;
  /** The comment's text after `/<folder>`, when it asks the bot. */
  ask?: string;
  commentId?: number;
}

/** Text after a line that starts with `/<folder>` (case-insensitive), or null (spec 37.10.2 `mentioned`). */
export function mentionAsk(text: string, folder: string): string | null {
  const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*/${escaped}(?![A-Za-z0-9_-])[ \\t]*(.*)$`, "i");
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index < 0) return null;
  const first = pattern.exec(lines[index])![1];
  return [first, ...lines.slice(index + 1)].join("\n").trim();
}

type FactsHandler = (payload: GitHubPayload, facts: GitHubEventFacts, folder: string) => void;

const ISSUE_ACTIONS: Record<string, string> = {
  opened: "issue_opened",
  closed: "issue_closed",
  assigned: "assigned",
  labeled: "labeled",
};
const PR_ACTIONS: Record<string, string> = {
  opened: "pr_opened",
  synchronize: "pr_pushed",
  ready_for_review: "pr_ready",
  review_requested: "review_requested",
  assigned: "assigned",
  labeled: "labeled",
};
const CONFLICT_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
const CHECK_CONCLUSIONS: Record<string, string> = { failure: "ci_failed", success: "ci_passed" };
const DEPLOY_DONE = new Set(["success", "failure", "error"]);

function issues(payload: GitHubPayload, facts: GitHubEventFacts): void {
  const kind = ISSUE_ACTIONS[payload.action ?? ""];
  if (kind) facts.kinds.push(kind);
  facts.text = payload.issue?.title;
}
function pullRequest(payload: GitHubPayload, facts: GitHubEventFacts): void {
  const action = payload.action ?? "";
  const pr = payload.pull_request;
  const closedKind = pr?.merged ? "pr_merged" : "pr_closed";
  const kind = action === "closed" ? closedKind : PR_ACTIONS[action];
  if (kind) facts.kinds.push(kind);
  if (CONFLICT_ACTIONS.has(action) && pr?.mergeable_state === "dirty")
    facts.kinds.push("pr_conflicted");
  facts.text = pr?.title;
}
function comment(kind: "comment" | "review_comment"): FactsHandler {
  return (payload, facts, folder) => {
    if (payload.action !== "created") return;
    facts.kinds.push(kind);
    const body = payload.comment?.body ?? "";
    facts.text = body;
    facts.commentId = payload.comment?.id;
    facts.url = payload.comment?.html_url ?? facts.url;
    const ask = mentionAsk(body, folder);
    if (ask === null) return;
    facts.kinds.push("mentioned");
    facts.ask = ask;
  };
}
function review(payload: GitHubPayload, facts: GitHubEventFacts): void {
  if (payload.action === "submitted") facts.kinds.push("review");
  facts.text = payload.review?.body ?? undefined;
  facts.url = payload.review?.html_url ?? facts.url;
}
function checkSuite(payload: GitHubPayload, facts: GitHubEventFacts): void {
  if (payload.action !== "completed") return;
  const conclusion = payload.check_suite?.conclusion ?? "";
  const kind = CHECK_CONCLUSIONS[conclusion];
  if (kind) facts.kinds.push(kind);
  facts.kinds.push("ci_finished");
  const prNumber = payload.check_suite?.pull_requests?.[0]?.number;
  if (facts.repo && prNumber !== undefined) {
    facts.number = prNumber;
    facts.subject = `${facts.repo}#${prNumber}`;
  }
  facts.text = conclusion || undefined;
}
function workflowRun(payload: GitHubPayload, facts: GitHubEventFacts): void {
  if (payload.action === "completed") facts.kinds.push("workflow_finished");
  const run = payload.workflow_run;
  facts.text = [run?.name, run?.conclusion].filter(Boolean).join(" · ");
  facts.url = run?.html_url ?? facts.url;
}
function deploymentStatus(payload: GitHubPayload, facts: GitHubEventFacts): void {
  const status = payload.deployment_status;
  if (status && DEPLOY_DONE.has(status.state)) facts.kinds.push("deploy_finished");
  facts.text = [status?.environment, status?.state].filter(Boolean).join(" · ");
}
function securityAlert(event: string): FactsHandler {
  return (payload, facts) => {
    if (payload.action === "created") facts.kinds.push("security_alert");
    facts.url = payload.alert?.html_url ?? facts.url;
    facts.text = event.replaceAll("_", " ");
  };
}
const HANDLERS: Record<string, FactsHandler> = {
  issues,
  pull_request: pullRequest,
  issue_comment: comment("comment"),
  pull_request_review_comment: comment("review_comment"),
  pull_request_review: review,
  check_suite: checkSuite,
  workflow_run: workflowRun,
  deployment_status: deploymentStatus,
  dependabot_alert: securityAlert("dependabot_alert"),
  code_scanning_alert: securityAlert("code_scanning_alert"),
  secret_scanning_alert: securityAlert("secret_scanning_alert"),
};

/** Spec 37.10.2: which of Orca's 21 GitHub kinds one webhook delivery is. */
export function githubEventFacts(
  event: string,
  payload: GitHubPayload,
  folder: string,
): GitHubEventFacts {
  const repo = payload.repository?.full_name;
  const issue = payload.issue;
  const pr = payload.pull_request;
  const number = issue?.number ?? pr?.number;
  const facts: GitHubEventFacts = {
    kinds: [],
    repo,
    number,
    subject: repo && number !== undefined ? `${repo}#${number}` : undefined,
    actor: payload.sender?.login,
    url: pr?.html_url ?? issue?.html_url,
  };
  HANDLERS[event]?.(payload, facts, folder);
  return facts;
}
