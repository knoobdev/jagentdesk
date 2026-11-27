// The 11 built-in templates this round ships (spec 37.4.10), copied from Orca dfdb4fda (MIT,
// Copyright (c) 2026 Lovecast Inc.) src/shared/bots/bot-template-catalog/*.ts with "Orca" read as
// JAgentDesk. Generated from the Orca files; do not edit by hand.
import type { BotTemplateRecord } from "./types.js";

export const BOT_TEMPLATES: readonly BotTemplateRecord[] = [
  {
    id: "pr-review",
    category: "coding",
    name: "Pull request review",
    line: "Reviews pull requests you’re asked to review and lists risky changes.",
    firstChat:
      "Asks which repos to cover, then reviews the open pull requests waiting on your review and posts its findings here, with file and line. It doesn’t comment on GitHub until you say it can.",
    mascot: "B1",
    watches: "Pull requests waiting on your review, in the repos you pick",
    does: "Reviews each one and lists risky changes and missing tests, with file and line.",
    reports: "Here, when a review is requested",
    connectors: ["github"],
    schedules: [],
    events: [
      {
        id: "review-requested",
        name: "When you’re asked to review a pull request: review it and post here",
        source: "github",
        event: "review_requested",
        prompt:
          "A pull request is waiting on my owner’s review. Review it with the pr-review-checklist skill and post the findings here, with file and line. Don’t comment on GitHub unless my owner said I can.",
      },
    ],
    skills: ["pr-review-checklist"],
    example: [
      "#4121: the retry counter is never reset, so a second outage stops retries.",
      "No test covers the new timeout path.",
    ],
  },
  {
    id: "dependency-updates",
    category: "coding",
    name: "Dependency updates",
    line: "Checks for outdated and vulnerable packages and proposes upgrades.",
    firstChat:
      "Lists outdated and vulnerable packages in a repo you pick, most urgent first. After you agree, an agent opens one pull request per group.",
    mascot: "M1",
    watches: "Packages in the repos you pick",
    does: "Lists advisories and outdated packages, most urgent first; upgrades one group per pull request once agreed.",
    reports: "Here, Mondays at 9 AM",
    connectors: ["github"],
    schedules: [
      {
        id: "weekly-check",
        when: "Mondays at 9 AM",
        what: "New advisories and major versions",
        rrule: "0 9 * * 1",
        prompt:
          "Check the repos my owner picked for new security advisories and new major versions since last week. List them here, most urgent first, grouped the way the dependency-upgrade skill says.",
      },
    ],
    events: [],
    skills: ["dependency-upgrade"],
    example: [
      "1 advisory: http-client 6.19 has a high-severity fix in 6.21.",
      "4 minor upgrades can go in one pull request.",
    ],
  },
  {
    id: "unreviewed-work",
    category: "coding",
    name: "Unreviewed agent work",
    line: "A daily list of finished agent work nobody has looked at yet.",
    firstChat:
      "Lists workspaces whose agent finished with changes you haven’t reviewed or turned into a pull request. JAgentDesk already tells you when an agent is waiting on you; this covers what’s done.",
    mascot: "K2",
    watches: "Your JAgentDesk workspaces",
    does: "Lists workspaces whose agent finished with changes nobody reviewed or opened a pull request for.",
    reports: "Here, weekdays at 9 AM",
    connectors: [],
    schedules: [
      {
        id: "daily-list",
        when: "Weekdays at 9 AM",
        what: "Finished work waiting for review",
        rrule: "0 9 * * 1-5",
        prompt:
          "List my owner’s workspaces whose agent finished with changes that have no pull request and no review yet, with the size of each diff and when it finished. Judge folder workspaces by activity only.",
      },
    ],
    events: [],
    skills: [],
    example: [
      "mobile-pairing finished yesterday with a 340-line diff, no pull request.",
      "2 more finished this week.",
    ],
  },
  {
    id: "workspace-cleanup",
    category: "coding",
    name: "Workspace cleanup",
    line: "Finds finished or abandoned workspaces and offers to remove them.",
    firstChat:
      "Lists workspaces whose pull request merged or that haven’t changed in two weeks, with any uncommitted changes. It removes only the ones you pick.",
    mascot: "J1",
    watches: "Your JAgentDesk workspaces and their pull requests",
    does: "Lists workspaces that are done or abandoned, with uncommitted changes; removes only the ones you pick.",
    reports: "Here, Fridays at 4 PM",
    connectors: ["github"],
    schedules: [
      {
        id: "weekly-list",
        when: "Fridays at 4 PM",
        what: "Workspaces ready to remove",
        rrule: "0 16 * * 5",
        prompt:
          "List my owner’s workspaces that look done or abandoned, using the workspace-hygiene skill, with anything uncommitted or unpushed. Remove nothing until my owner picks.",
      },
    ],
    events: [],
    skills: ["workspace-hygiene"],
    example: [
      "6 workspaces are done: their pull requests merged this week.",
      "2 folders haven’t changed since Oct 20.",
    ],
  },
  {
    id: "security-check",
    category: "coding",
    name: "Security check",
    line: "Looks at merged changes for leaked secrets and risky code.",
    firstChat:
      "Reviews last week’s merged pull requests in a repo you pick and lists anything that needs a second look, with file and line.",
    mascot: "N1",
    watches: "Merged pull requests in the repos you pick",
    does: "Checks them for leaked secrets, injection, missing auth and unsafe defaults.",
    reports: "Here, Mondays at 9 AM and when a pull request merges",
    connectors: ["github"],
    schedules: [
      {
        id: "weekly-review",
        when: "Mondays at 9 AM",
        what: "The week’s merged changes",
        rrule: "0 9 * * 1",
        prompt:
          "Review last week’s merged pull requests in the repos my owner picked with the security-checklist skill. List anything that needs a second look, with file and line, or say nothing was found.",
      },
    ],
    events: [
      {
        id: "pr-merged",
        name: "When a pull request merges: check it",
        source: "github",
        event: "pr_merged",
        prompt:
          "A pull request merged. Check it with the security-checklist skill and post anything that needs a second look here, with file and line. Stay quiet if nothing does.",
      },
    ],
    skills: ["security-checklist"],
    example: [
      "#4133 logs the full request headers, including the auth token.",
      "Nothing else this week.",
    ],
  },
  {
    id: "release",
    category: "releases",
    name: "Release readiness",
    line: "Tracks what’s blocking the next release.",
    firstChat:
      "Keeps a short readiness list: failing checks, pull requests waiting for review, open blockers.",
    mascot: "D1",
    watches: "Pull requests, checks and workspaces",
    does: "Keeps a short readiness list: failing checks, pull requests waiting for review, open blockers.",
    reports: "Here, weekday mornings",
    connectors: ["github"],
    schedules: [
      {
        id: "readiness-list",
        when: "Weekdays at 9 AM",
        what: "Readiness list",
        rrule: "0 9 * * 1-5",
        prompt:
          "Update the release readiness list with the release-readiness skill: failing checks, pull requests waiting for review, open blockers. Lead with blocked or ready.",
      },
    ],
    events: [],
    skills: ["release-readiness"],
    example: [
      "1.5 is blocked by one failing check: typecheck on #4121.",
      "Two pull requests still need a review: #4108, #4130.",
    ],
  },
  {
    id: "release-notes",
    category: "releases",
    name: "Release notes",
    line: "Drafts the next release’s notes from merged pull requests.",
    firstChat:
      "Finds the last release tag and drafts notes in three groups: new, fixed, changed. You edit them here.",
    mascot: "E1",
    watches: "Pull requests merged since the last release",
    does: "Drafts release notes for users in three groups: new, fixed, changed.",
    reports: "Here, when you ask",
    connectors: ["github"],
    schedules: [],
    events: [],
    skills: ["release-notes-style"],
    example: [
      "Draft for 1.5: 4 new, 9 fixed, 2 changed.",
      "Biggest change: bots can share skills.",
    ],
  },
  {
    id: "ci-failures",
    category: "releases",
    name: "CI failures",
    line: "Explains failed checks and keeps a list of flaky ones.",
    firstChat:
      "Reads the last two weeks of check runs and lists the flaky ones, then explains each failing check on your open pull requests. It starts a fix only after you agree.",
    mascot: "G1",
    watches: "Check runs in the repos you pick",
    does: "Tells flaky checks from real failures, explains each failure, and keeps a list of flaky checks.",
    reports: "Here, Mondays at 9 AM and when a check fails",
    connectors: ["github"],
    schedules: [
      {
        id: "flaky-list",
        when: "Mondays at 9 AM",
        what: "Flaky checks",
        rrule: "0 9 * * 1",
        prompt:
          "Read the last week of check runs in the repos my owner picked and update the list of flaky checks with the ci-failure-triage skill, worst first.",
      },
    ],
    events: [
      {
        id: "check-failed",
        name: "When a check fails: say whether it’s flaky or real",
        source: "github",
        event: "ci_failed",
        prompt:
          "A check failed. If it isn’t on a branch my owner cares about, stop without posting. Otherwise sort it with the ci-failure-triage skill and post whether it is real, flaky or infrastructure, with the cause.",
      },
    ],
    skills: ["ci-failure-triage"],
    needsSetup:
      "GitHub can’t filter failures by branch yet, so the bot looks at every failure in the repo and skips the ones that don’t matter. Each one costs a turn.",
    example: [
      "#4130 typecheck: a renamed export, two call sites missed. Fix is one commit.",
      "Flakiest this week: terminal-resize test, 4 of 30 runs.",
    ],
  },
  {
    id: "issue-triage",
    category: "support",
    name: "GitHub issue triage",
    line: "Labels new issues, finds duplicates and asks for missing details.",
    firstChat:
      "Goes through the last week of new issues in a repo you pick and proposes labels and duplicates here.",
    mascot: "R3",
    watches: "New issues in the repos you pick",
    does: "Proposes labels and duplicates, and lists missing details, for each new issue.",
    reports: "Here, when an issue is opened",
    connectors: ["github"],
    schedules: [],
    events: [
      {
        id: "issue-opened",
        name: "When an issue is opened: propose labels and duplicates",
        source: "github",
        event: "issue_opened",
        prompt:
          "An issue was opened. Triage it with the issue-triage skill and post the proposed labels, likely duplicate and missing details here. Change nothing on GitHub unless my owner said I can.",
      },
    ],
    skills: ["issue-triage"],
    example: [
      "#2210: bug, windows, duplicate of #2188.",
      "#2214 has no version or steps. Ask for them?",
    ],
  },
  {
    id: "docs-upkeep",
    category: "planning",
    name: "Docs upkeep",
    line: "Flags docs that no longer match merged code.",
    firstChat:
      "Reads last week’s merged pull requests and lists docs pages that now say something wrong.",
    mascot: "L2",
    watches: "Merged pull requests and the docs in the repos you pick",
    does: "Lists docs pages that no longer match what merged, with the line that is now wrong.",
    reports: "Here, Wednesdays at 10 AM",
    connectors: ["github"],
    schedules: [
      {
        id: "weekly-docs",
        when: "Wednesdays at 10 AM",
        what: "Docs to update",
        rrule: "0 10 * * 3",
        prompt:
          "Read last week’s merged pull requests in the repos my owner picked and list docs pages that now say something wrong, with the page, the line and what changed.",
      },
    ],
    events: [],
    skills: [],
    example: [
      "docs/remote.md still says SSH needs a restart; #4108 removed that.",
      "1 more page mentions the old setting name.",
    ],
  },
  {
    id: "incident-notes",
    category: "ops",
    name: "Incident notes",
    line: "Keeps a timeline in an incident channel and drafts the write-up.",
    firstChat:
      "Follows the incident channel you pick and its threads, keeps a timestamped timeline, and drafts a blameless write-up when it’s over.",
    mascot: "H2",
    watches: "The incident channel you pick, and its threads",
    does: "Keeps a timestamped timeline, then drafts a blameless write-up.",
    reports: "Here, during and after an incident",
    connectors: ["slack"],
    schedules: [],
    events: [
      {
        id: "incident-posted",
        name: "When someone posts in an incident channel: add it to the timeline",
        source: "slack",
        event: "message",
        prompt:
          "Someone posted in the incident channel. Add what matters to the timeline with the incident-timeline skill, and read the thread it starts too. Post only when the timeline changes.",
      },
    ],
    skills: ["incident-timeline"],
    example: [
      "14:02 alert fired; 14:09 rollback started; 14:21 errors back to normal.",
      "Write-up draft ready.",
    ],
  },
];
