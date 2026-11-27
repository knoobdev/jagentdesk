// Look around (spec 37.2.6): a scheduled read-only run that lists next steps. Ported from Orca dfdb4fda
// (MIT, Copyright (c) 2026 Lovecast Inc.): src/main/bots/bot-look-around-policy.ts:1-160,
// bot-look-around-prompt.ts, bot-look-around-schedule.ts, src/shared/bots/bot-look-around.ts:118-200.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LookAroundEvery } from "@jagentdesk/protocol/bots/types";
import { LOOK_AROUND_EVERY, LOOK_AROUND_LIMITS } from "@jagentdesk/protocol/bots/rules";

export const BOT_QUIET_MARKER = "[[quiet]]";

export const LOOK_AROUND_REFUSAL =
  "Looking around can only read. Suggest this as a next step instead.";
export const REPLY_ONLY_REFUSAL = "A tidy-up only replies: everything it needs is in its prompt.";

/** Read-only commands, by program then subcommand words; the subcommand must come first. */
const READ_COMMANDS: Record<string, readonly (readonly string[])[]> = {
  gh: [
    ["pr", "view"],
    ["pr", "list"],
    ["pr", "checks"],
    ["pr", "diff"],
    ["issue", "view"],
    ["issue", "list"],
    ["run", "view"],
    ["run", "list"],
  ],
  git: [["log"], ["show"], ["diff"], ["status"], ["branch"], ["rev-parse"], ["ls-files"]],
};

/** Arguments that make an otherwise-read command write, run something, or send something. */
const REFUSED_ARGUMENTS: Record<string, (word: string) => boolean> = {
  gh: (word) => /^--(method|input|field|raw-field)/.test(word) || /^-[^-]*[XfF]/.test(word),
  git: (word) =>
    word.startsWith("-c") ||
    /^-[^-]*o/.test(word) ||
    /^--(output|exec|ext-diff|textconv|upload-pack|receive-pack)/.test(word) ||
    word.startsWith(":"),
};

const GITHUB_REPO = /^(?:github\.com\/)?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const GITHUB_URL = /^https:\/\/github\.com\//;

function ghStaysOnGitHub(args: readonly string[]): boolean {
  return args.every((word, index) => {
    const previous = args[index - 1];
    if (previous === "-R" || previous === "--repo") return GITHUB_REPO.test(word);
    if (word.startsWith("--repo=")) return GITHUB_REPO.test(word.slice("--repo=".length));
    if (word === "--web" || (/^-[^-]*[Rw]/.test(word) && word !== "-R")) return false;
    return !word.includes("://") || GITHUB_URL.test(word);
  });
}

const GIT_BRANCH_LISTING: ReadonlySet<string> = new Set(["-a", "-r", "--all", "--remotes"]);
const PLAIN_WORD = /^[A-Za-z0-9._/:=@,+-]+$/;

function words(command: string): string[] | null {
  const out: string[] = [];
  let consumed = "";
  for (const match of command.matchAll(/(?<=^|[ \t])(?:'([^'\n\r]*)'|([^\s']+))(?=[ \t]|$)/g)) {
    const [whole, quoted, plain] = match;
    if (plain !== undefined && (!PLAIN_WORD.test(plain) || plain.startsWith("="))) return null;
    out.push(quoted ?? plain ?? "");
    consumed += whole;
  }
  const gaps = (text: string) => text.replace(/[ \t]/g, "");
  return gaps(consumed) === gaps(command) ? out : null;
}

/** Codex wraps commands as `/bin/zsh -lc '<command>'`; the inner command is what runs. */
export function unwrapShell(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+'((?:[^']|'\\'')*)'$/.exec(command.trim());
  return wrapped ? wrapped[1].replace(/'\\''/g, "'") : command.trim();
}

/** Whether a shell command is one read the run may make. */
export function lookAroundCommandAllowed(command: string): boolean {
  const parts = words(unwrapShell(command));
  if (!parts || parts.length === 0) return false;
  const [program, ...rest] = parts;
  const allowed = Object.hasOwn(READ_COMMANDS, program) ? READ_COMMANDS[program] : undefined;
  const path = allowed?.find((candidate) => candidate.every((word, index) => rest[index] === word));
  if (!path) return false;
  const args = rest.slice(path.length);
  if (args.some((word) => REFUSED_ARGUMENTS[program]?.(word) === true)) return false;
  if (program === "gh" && !ghStaysOnGitHub(args)) return false;
  return path[0] !== "branch" || args.every((word) => GIT_BRANCH_LISTING.has(word));
}

const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite"]);

function commandOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.cmd;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string"))
    return value.join(" ");
  return null;
}

/**
 * The permission gate's answer for a background run's tool (ADR-0046): a look may read; a tidy-up
 * may do nothing. Everything else is refused here, not by asking the model.
 */
export function backgroundToolDecision(
  mode: "look-around" | "reply-only",
  toolName: string,
  input: unknown,
): { behavior: "allow" } | { behavior: "deny"; message: string } {
  if (mode === "reply-only") return { behavior: "deny", message: REPLY_ONLY_REFUSAL };
  if (READ_TOOLS.has(toolName)) return { behavior: "allow" };
  const command = commandOf(input);
  if (command !== null && /^(bash|shell|exec|command)/i.test(toolName.replace(/[^a-z]/gi, ""))) {
    return lookAroundCommandAllowed(command)
      ? { behavior: "allow" }
      : { behavior: "deny", message: LOOK_AROUND_REFUSAL };
  }
  return { behavior: "deny", message: LOOK_AROUND_REFUSAL };
}

const DAY_MS = 24 * 60 * 60_000;

/** The slot times (local wall clock) of one day for a preset, honoring weekdays only. */
function slotsOn(day: Date, every: LookAroundEvery, weekdaysOnly: boolean): number[] {
  const weekday = day.getDay();
  if (weekdaysOnly && (weekday === 0 || weekday === 6)) return [];
  return LOOK_AROUND_EVERY[every].map((hour) => {
    const at = new Date(day);
    at.setHours(hour, 0, 0, 0);
    return at.getTime();
  });
}

export function nextLookAt(
  setting: { every: LookAroundEvery; weekdaysOnly: boolean },
  after: number,
): number | undefined {
  const start = new Date(after);
  start.setHours(0, 0, 0, 0);
  for (let offset = 0; offset < 9; offset++) {
    const day = new Date(start.getTime() + offset * DAY_MS + 2 * 60 * 60_000);
    day.setHours(0, 0, 0, 0);
    const slot = slotsOn(day, setting.every, setting.weekdaysOnly).find((at) => at > after);
    if (slot !== undefined) return slot;
  }
  return undefined;
}

/**
 * The slot owed now, or undefined: the latest slot today at or before `now` that came after the last
 * look and after Look around was turned on. A slot the host slept through is caught up the same day.
 */
export function dueLookSlot(
  setting: { every: LookAroundEvery; weekdaysOnly: boolean },
  input: { now: number; lastLookedAt?: number; since?: number; firstChatAt?: number },
): number | undefined {
  if (input.firstChatAt === undefined) return undefined;
  const today = new Date(input.now);
  today.setHours(0, 0, 0, 0);
  const floor = Math.max(input.lastLookedAt ?? 0, input.since ?? 0, input.firstChatAt);
  return slotsOn(today, setting.every, setting.weekdaysOnly).findLast(
    (at) => at <= input.now && at > floor,
  );
}

const DEFAULT_FOCUS =
  "Anything waiting on your owner: reviews asked of them, failing checks on their work, questions put to them, follow-ups they promised.";

export const LOOK_AROUND_PROMPT_OPENING = "Look around: find what is waiting on your owner";

export function lookAroundPrompt(input: {
  focus: string;
  open: readonly string[];
  started: readonly string[];
  dismissed: readonly string[];
}): string {
  const titles = (heading: string, list: readonly string[]) =>
    list.length === 0 ? [] : [heading, ...list.map((title) => `- ${title}`)];
  return [
    `${LOOK_AROUND_PROMPT_OPENING} and suggest up to ${LOOK_AROUND_LIMITS.perRun} next steps for their Suggestions list.`,
    "",
    "This run only reads. Read files and run read-only commands (`gh pr view|list|checks|diff`, `gh issue|run view|list`, `git log|show|diff|status|branch|rev-parse|ls-files`). Anything else is refused; do not retry it, suggest it instead. Do not edit MEMORY.md or any other file.",
    "",
    `Look for: ${input.focus.trim() || DEFAULT_FOCUS}`,
    "",
    ...titles("Still listed (suggest again with the same title only if still true):", input.open),
    "",
    ...titles("They started these recently, so they act on this kind:", input.started),
    "",
    ...titles("They dismissed these: never suggest them again, in any wording:", input.dismissed),
    "",
    "End your final message with one fenced ```json block holding an array of suggestions, then the quiet marker. Each suggestion is an object:",
    "- title: what to do, under 80 characters.",
    "- why: one sentence on why now.",
    "- ask: the message your owner would send you to do it, written as them.",
    "- link: the thread, issue or pull request it is about (optional).",
    "Suggest only things with a concrete next step; if nothing is worth it, reply with [].",
    "",
    `When done, end your final message with ${BOT_QUIET_MARKER}.`,
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

const SuggestionDraftSchema = z.object({
  title: z.string().trim().min(1).max(80),
  why: z.string().trim().max(400).default(""),
  ask: z.string().trim().min(1).max(2000),
  link: z.string().trim().max(2000).optional(),
});
export type SuggestionDraft = z.infer<typeof SuggestionDraftSchema>;

/** The last JSON array in the run's final message; invalid entries are dropped, at most 5 kept. */
export function parseSuggestions(text: string): SuggestionDraft[] {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fenced.length ? fenced.toReversed() : [text.slice(text.indexOf("["))];
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate.trim());
      if (!Array.isArray(value)) continue;
      return value
        .flatMap((entry) => {
          const parsed = SuggestionDraftSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
        .filter((entry) => !entry.link || !linkCarriesCredential(entry.link))
        .slice(0, LOOK_AROUND_LIMITS.perRun);
    } catch {
      // Try the next block.
    }
  }
  throw new Error("Look around returned no suggestions list");
}

const CREDENTIAL_PARAM =
  /token|secret|passw|api[_-]?key|access[_-]?key|signature|^sig$|auth|credential|session/i;
export function linkCarriesCredential(link: string): boolean {
  try {
    const url = new URL(link);
    const names = [
      ...url.searchParams.keys(),
      ...new URLSearchParams(url.hash.replace(/^#/, "")).keys(),
    ];
    return (
      url.username !== "" ||
      url.password !== "" ||
      names.some((name) => CREDENTIAL_PARAM.test(name))
    );
  } catch {
    return true;
  }
}

function normalizedLink(link: string): string | null {
  try {
    const url = new URL(link);
    const parts = url.pathname.toLowerCase().split("/").filter(Boolean);
    const github = parts.findIndex((part) => part === "pull" || part === "issues");
    const kept =
      github !== -1 && /^\d+$/.test(parts[github + 1] ?? "") ? parts.slice(0, github + 2) : parts;
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}/${kept.join("/")}`;
  } catch {
    return null;
  }
}

/** What makes two suggestions the same: the thing their link names, else their title. */
export function suggestionKey(suggestion: { title: string; link?: string }): string {
  const link = suggestion.link ? normalizedLink(suggestion.link) : null;
  const key = link
    ? `link:${link}`
    : `title:${suggestion.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

export function suggestionSource(
  link: string | undefined,
): "slack" | "github" | "gitlab" | "telegram" | undefined {
  if (!link) return undefined;
  try {
    const host = new URL(link).hostname;
    if (host === "slack.com" || host.endsWith(".slack.com")) return "slack";
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    if (host === "gitlab.com" || host.startsWith("gitlab.")) return "gitlab";
    if (host === "t.me" || host === "telegram.org") return "telegram";
    return undefined;
  } catch {
    return undefined;
  }
}
