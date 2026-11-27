import { describe, expect, it } from "vitest";
import { BOT_CONNECTOR_EVENT_KINDS } from "./events.js";
import { GitHubPayloadSchema, githubEventFacts, mentionAsk } from "./github-events.js";

// Payload shapes follow GitHub's webhook docs ("Webhook events and payloads"), trimmed to the fields read.
const repository = {
  full_name: "octo-org/hello-world",
  html_url: "https://github.com/octo-org/hello-world",
};
const sender = { login: "octocat", id: 1 };
const issue = {
  number: 7,
  title: "Typo in README",
  html_url: "https://github.com/octo-org/hello-world/issues/7",
};
const pr = (extra: Record<string, unknown> = {}) => ({
  number: 9,
  title: "Fix typo",
  html_url: "https://github.com/octo-org/hello-world/pull/9",
  merged: false,
  mergeable_state: "clean",
  ...extra,
});
const comment = (body: string) => ({
  id: 42,
  body,
  user: sender,
  html_url: "https://github.com/c/42",
});
const cases: [string, string, Record<string, unknown>, string[]][] = [
  ["issue_opened", "issues", { action: "opened", issue }, ["issue_opened"]],
  ["issue_closed", "issues", { action: "closed", issue }, ["issue_closed"]],
  ["pr_opened", "pull_request", { action: "opened", pull_request: pr() }, ["pr_opened"]],
  ["pr_pushed", "pull_request", { action: "synchronize", pull_request: pr() }, ["pr_pushed"]],
  ["pr_ready", "pull_request", { action: "ready_for_review", pull_request: pr() }, ["pr_ready"]],
  [
    "pr_merged",
    "pull_request",
    { action: "closed", pull_request: pr({ merged: true }) },
    ["pr_merged"],
  ],
  [
    "pr_closed",
    "pull_request",
    { action: "closed", pull_request: pr({ merged: false }) },
    ["pr_closed"],
  ],
  [
    "pr_conflicted",
    "pull_request",
    { action: "reopened", pull_request: pr({ mergeable_state: "dirty" }) },
    ["pr_conflicted"],
  ],
  [
    "review_requested",
    "pull_request",
    { action: "review_requested", pull_request: pr() },
    ["review_requested"],
  ],
  ["assigned", "issues", { action: "assigned", issue }, ["assigned"]],
  [
    "labeled",
    "pull_request",
    { action: "labeled", pull_request: pr(), label: { name: "bug" } },
    ["labeled"],
  ],
  [
    "comment",
    "issue_comment",
    { action: "created", issue, comment: comment("Looks good") },
    ["comment"],
  ],
  [
    "review_comment",
    "pull_request_review_comment",
    { action: "created", pull_request: pr(), comment: comment("nit: rename") },
    ["review_comment"],
  ],
  [
    "review",
    "pull_request_review",
    { action: "submitted", pull_request: pr(), review: { id: 5, body: "LGTM", state: "approved" } },
    ["review"],
  ],
  [
    "mentioned",
    "issue_comment",
    { action: "created", issue, comment: comment("Thanks!\n/Scout fix the typo") },
    ["comment", "mentioned"],
  ],
  [
    "ci_failed",
    "check_suite",
    {
      action: "completed",
      check_suite: { id: 1, conclusion: "failure", pull_requests: [{ number: 9 }] },
    },
    ["ci_failed", "ci_finished"],
  ],
  [
    "ci_passed",
    "check_suite",
    { action: "completed", check_suite: { id: 1, conclusion: "success", pull_requests: [] } },
    ["ci_passed", "ci_finished"],
  ],
  [
    "ci_finished",
    "check_suite",
    { action: "completed", check_suite: { id: 1, conclusion: "cancelled" } },
    ["ci_finished"],
  ],
  [
    "workflow_finished",
    "workflow_run",
    { action: "completed", workflow_run: { id: 3, name: "CI", conclusion: "success" } },
    ["workflow_finished"],
  ],
  [
    "deploy_finished",
    "deployment_status",
    { action: "created", deployment_status: { state: "failure", environment: "production" } },
    ["deploy_finished"],
  ],
  [
    "security_alert",
    "dependabot_alert",
    { action: "created", alert: { number: 2, html_url: "https://github.com/a/2" } },
    ["security_alert"],
  ],
];

describe("GitHub webhook kinds (spec 37.10.2, A37.10.5)", () => {
  it("covers all 21 of Orca's kinds", () => {
    expect(new Set(cases.map(([kind]) => kind))).toEqual(new Set(BOT_CONNECTOR_EVENT_KINDS.github));
  });
  it.each(cases)("%s", (_kind, event, body, expected) => {
    const payload = GitHubPayloadSchema.parse({ repository, sender, ...body });
    expect(githubEventFacts(event, payload, "scout").kinds).toEqual(expected);
  });
  it("finds the subject of issues, pull requests and their check suites", () => {
    const parse = (body: Record<string, unknown>) =>
      GitHubPayloadSchema.parse({ repository, sender, ...body });
    expect(githubEventFacts("issues", parse({ action: "opened", issue }), "scout").subject).toBe(
      "octo-org/hello-world#7",
    );
    expect(
      githubEventFacts(
        "check_suite",
        parse({
          action: "completed",
          check_suite: { id: 1, conclusion: "failure", pull_requests: [{ number: 9 }] },
        }),
        "scout",
      ).subject,
    ).toBe("octo-org/hello-world#9");
  });
  it("other states and actions are no kind", () => {
    const parse = (body: Record<string, unknown>) =>
      GitHubPayloadSchema.parse({ repository, sender, ...body });
    expect(
      githubEventFacts(
        "deployment_status",
        parse({ deployment_status: { state: "pending" } }),
        "scout",
      ).kinds,
    ).toEqual([]);
    expect(githubEventFacts("issues", parse({ action: "edited", issue }), "scout").kinds).toEqual(
      [],
    );
    expect(
      githubEventFacts(
        "issue_comment",
        parse({ action: "edited", issue, comment: comment("/scout hi") }),
        "scout",
      ).kinds,
    ).toEqual([]);
    expect(
      githubEventFacts("secret_scanning_alert", parse({ action: "resolved" }), "scout").kinds,
    ).toEqual([]);
  });
});

describe("mention rule /<folder>", () => {
  it("matches a line starting with /<folder>, any case, and returns the rest", () => {
    expect(mentionAsk("/scout fix the typo", "scout")).toBe("fix the typo");
    expect(mentionAsk("Hi\n  /SCOUT  please look\nat line 3", "scout")).toBe(
      "please look\nat line 3",
    );
    expect(mentionAsk("/scout", "scout")).toBe("");
  });
  it("does not match inside a line, another folder, or a longer word", () => {
    expect(mentionAsk("ask /scout later", "scout")).toBeNull();
    expect(mentionAsk("/scouting now", "scout")).toBeNull();
    expect(mentionAsk("/scout-2 now", "scout")).toBeNull();
    expect(mentionAsk("@scout now", "scout")).toBeNull();
  });
});
