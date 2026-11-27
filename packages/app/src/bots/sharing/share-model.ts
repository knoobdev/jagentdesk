// Pure pieces of the Share and Receive flows (spec 37.13): picks, safety-check summary, error copy.
// After Orca dfdb4fda src/renderer/src/components/bots/sharing/bot-share-flags.ts,
// bot-share-error-copy.ts and BotShareOverview.tsx (MIT).
import type {
  BotShareCandidate,
  BotShareFlag,
  BotShareLeftOut,
  BotShareSelection,
} from "@jagentdesk/protocol/bots/share-schemas";

type Translate = (key: string, options?: Record<string, unknown>) => string;

const FLAG_KEYS: Record<string, string> = {
  secret: "bots.share.flag.secret",
  "pipe-to-shell": "bots.share.flag.pipeToShell",
  sudo: "bots.share.flag.sudo",
  "sends-file": "bots.share.flag.sendsFile",
  "hidden-unicode": "bots.share.flag.hiddenUnicode",
  runnable: "bots.share.flag.runnable",
};

export function flagLabel(kind: string, t: Translate): string {
  return t(FLAG_KEYS[kind] ?? "bots.share.flag.secret");
}

/** "Nothing found", "1 secret found", "3 warnings": secrets first, since they block publishing. */
export function checkSummary(flags: readonly BotShareFlag[], t: Translate): string {
  const secrets = flags.filter((flag) => flag.kind === "secret").length;
  if (secrets === 1) return t("bots.share.secretFound");
  if (secrets > 1) return t("bots.share.secretsFound", { count: secrets });
  if (flags.length === 1) return t("bots.share.oneWarning");
  if (flags.length > 1) return t("bots.share.warnings", { count: flags.length });
  return t("bots.share.nothingFound");
}

/** Where a flag is, as the owner reads it: `bot.json#setupNote` is the setup note. */
export function flagWhere(flag: BotShareFlag, t: Translate): string {
  const where = flag.where === "bot.json#setupNote" ? t("bots.share.setupNote") : flag.where;
  return flag.line === null ? where : t("bots.share.whereLine", { where, line: flag.line });
}

/** The part a flagged path opens in the dialog's part view. */
export function flagPart(flag: BotShareFlag): string {
  if (flag.where === "bot.json#setupNote") return "note";
  const skill = /^skills\/([^/]+)\//.exec(flag.where);
  if (skill) return `skill:${skill[1]}`;
  const memory = /^memory\/([^/]+)\.md$/.exec(flag.where);
  if (memory) return `memory:${memory[1]}`;
  return flag.where === "SOUL.md" ? "soul" : flag.where;
}

/** Why a part never goes out, in the dialog's words. */
export function leftOutWhy(entry: BotShareLeftOut, t: Translate): string {
  switch (entry.why) {
    case "linked":
    case "link":
      return t("bots.share.fileLinkNotShared");
    case "size":
      return t("bots.share.tooLargeNotShared");
    case "limit":
      return t("bots.share.overLimitNotShared");
    case "unreadable":
    case "invalid":
      return t("bots.share.unreadableNotShared");
    default:
      return t("bots.share.notShared");
  }
}

/** All picked lists the names; some picked reads "2 of 3". */
export function partValue(picked: readonly string[], all: number, t: Translate): string {
  if (all === 0) return t("bots.share.none");
  return picked.length === all
    ? picked.join(", ")
    : t("bots.share.countOf", { picked: picked.length, all });
}

/** The names a list has ticked: absent means every one. */
export function pickedOf(
  selected: readonly string[] | undefined,
  all: readonly string[],
): string[] {
  if (selected === undefined) return [...all];
  const wanted = new Set(selected);
  return all.filter((name) => wanted.has(name));
}

/** Ticks or unticks one name; a list back to every name goes back to absent ("all"). */
export function toggled(
  selected: readonly string[] | undefined,
  all: readonly string[],
  name: string,
  on: boolean,
): string[] | undefined {
  const current = new Set(pickedOf(selected, all));
  if (on) current.add(name);
  else current.delete(name);
  const next = all.filter((entry) => current.has(entry));
  return next.length === all.length ? undefined : next;
}

/** The selection a candidate was built from, as the next prepare sends it. */
export function selectionWith(
  selection: BotShareSelection,
  patch: Partial<BotShareSelection>,
): BotShareSelection {
  const next: BotShareSelection = { ...selection, ...patch };
  for (const key of Object.keys(next) as (keyof BotShareSelection)[])
    if (next[key] === undefined) delete next[key];
  return next;
}

const ERROR_KEYS: Record<string, string> = {
  bot_share_secret_found: "bots.share.error.blocked",
  bot_share_note_secret: "bots.share.error.noteSecret",
  bot_share_preview_expired: "bots.share.error.expired",
  bot_share_too_large: "bots.share.error.tooLarge",
  bot_share_relay_off: "bots.share.relayOff",
  bot_share_limit: "bots.share.error.limit",
  bot_share_unavailable: "bots.share.error.unavailable",
  bot_share_bad_link: "bots.share.error.badLink",
  bot_share_stopped: "bots.share.error.stopped",
  bot_share_invalid: "bots.share.error.invalid",
  bot_share_review_expired: "bots.share.error.reviewExpired",
};

/** The rpc error's code (`bot_share_*`), stripped of the client's `requestType=` suffix. */
export function shareErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b(bot_share_[a-z_]+)\b/.exec(message)?.[1] ?? null;
}

/** The owner-facing copy for a share error; other messages pass through without the RPC suffix. */
export function shareErrorCopy(error: unknown, t: Translate): string {
  const code = shareErrorCode(error);
  const key = code ? ERROR_KEYS[code] : undefined;
  if (key) return t(key);
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.replace(/\s+requestType=\S+(?:\s+code=\S+)?$/, "");
}

/** Whether the dialog may publish: built, under the limits, no secret. */
export function canPublish(candidate: BotShareCandidate | null): boolean {
  return Boolean(candidate && !candidate.blocked && !candidate.tooLarge);
}
