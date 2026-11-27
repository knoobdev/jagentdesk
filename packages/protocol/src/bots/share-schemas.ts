// Bot sharing by link (spec 37.13, ADR-0061 §5). Kept apart from rpc-schemas.ts so the sharing
// contract reads in one place; rpc-schemas.ts spreads these into the bots request/response lists.
import { z } from "zod";
import { BotInputSchema, BotSchema } from "./types.js";

export const BOT_SHARE_FLAG_KINDS = [
  "secret",
  "pipe-to-shell",
  "sudo",
  "sends-file",
  "hidden-unicode",
  "runnable",
] as const;
export const BotShareFlagSchema = z.object({
  /** A package path, or `bot.json#<field>` for a manifest string. */
  where: z.string(),
  line: z.number().int().nullable(),
  kind: z.string(),
});
/** A part that never goes out, and why (`linked`, `size`, `unreadable`, `name`, `imported`, …). */
export const BotShareLeftOutSchema = z.object({
  kind: z.string(),
  name: z.string(),
  why: z.string(),
});
/** The owner's picks. Absent lists share everything but memory, which is off unless named. */
export const BotShareSelectionSchema = z.object({
  skills: z.array(z.string().max(64)).max(256).optional(),
  schedules: z.array(z.string().max(128)).max(64).optional(),
  memory: z.array(z.string().max(64)).max(256).optional(),
  setupNote: z.string().max(4000).optional(),
});
export const BotSharePackageSchema = z.object({
  schemaVersion: z.number().int(),
  name: z.string(),
  avatar: z.object({ mascot: z.string().optional(), image: z.string().optional() }).optional(),
  purpose: z.string(),
  agentHint: z.string(),
  skills: z.array(z.object({ name: z.string() })),
  connectors: z.array(z.object({ kind: z.string() })),
  schedules: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      prompt: z.string(),
      cron: z.string(),
      timezone: z.string().optional(),
    }),
  ),
  memory: z.array(z.object({ topic: z.string() })),
  setupNote: z.string().optional(),
});
/** Everything the bot could share, ticked or not, for the Share dialog's lists. */
export const BotShareAvailableSchema = z.object({
  soulLines: z.number().int(),
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
  schedules: z.array(z.object({ scheduleId: z.string(), name: z.string(), cron: z.string() })),
  memory: z.array(z.object({ topic: z.string(), lines: z.number().int() })),
});
export const BotShareCandidateSchema = z.object({
  previewId: z.string(),
  botDigest: z.string(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  bot: BotSharePackageSchema,
  files: z.array(z.object({ path: z.string(), role: z.string(), size: z.number().int() })),
  leftOut: z.array(BotShareLeftOutSchema),
  notIncluded: z.array(z.string()),
  available: BotShareAvailableSchema,
  flags: z.array(BotShareFlagSchema),
  /** A secret was found: publishing is refused until the owner removes it. */
  blocked: z.boolean(),
  /** Over the size or file limits: publishing is refused. */
  tooLarge: z.boolean(),
  expiresAt_ms: z.number().int(),
});
export const BotSharePartFileSchema = z.object({
  path: z.string(),
  text: z.string().nullable(),
  flags: z.array(z.object({ line: z.number().int(), kind: z.string() })),
});
/** Where a copy came from. The link is stored without its key. */
export const BotSharedFromSchema = z.object({
  shareId: z.string(),
  link: z.string(),
  sharedBy: z.string().nullable(),
  sharedAt_ms: z.number().int(),
  updatedAt_ms: z.number().int(),
});
export const BotShareStatusSchema = z.object({
  /** The relay Worker is on and its control socket is up: publishing can work. */
  relayConnected: z.boolean(),
  /** The bot's live link, with its `#k=` key; only sent to a paired client. */
  link: z.string().optional(),
  publishedAt_ms: z.number().int().optional(),
  updatedAt_ms: z.number().int().optional(),
  /** The bot's shareable parts differ from what the link serves (with the last picks). */
  changedSince: z.boolean().optional(),
  sharedFrom: BotSharedFromSchema.optional(),
  /** The copy's original link answers 410. */
  originalGone: z.boolean().optional(),
});
export const BotShareReviewSchema = z.object({
  reviewId: z.string(),
  shareId: z.string(),
  link: z.string(),
  sharedBy: z.string().nullable(),
  sharedAt_ms: z.number().int(),
  bot: BotSharePackageSchema,
  /** Every file Create writes, exactly as written; `MEMORY.md` is the new home's index. */
  files: z.array(BotSharePartFileSchema),
  flags: z.array(BotShareFlagSchema),
  leftOut: z.array(z.string()),
  avatarDataUrl: z.string().nullable(),
});
export const BotShareExistingSchema = z.object({
  botId: z.string(),
  name: z.string(),
  createdAt_ms: z.number().int(),
});

const request = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), requestId: z.string(), ...shape });
const response = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), payload: z.object({ requestId: z.string(), ...shape }) });
const botId = { botId: z.string() };

export const BotsShareRequestSchemas = [
  request("bots.share.status.request", botId),
  request("bots.share.prepare.request", {
    ...botId,
    selection: BotShareSelectionSchema,
    /** Start from the picks the link was last published with, when there are any. */
    last: z.boolean().optional(),
  }),
  request("bots.share.view.request", {
    ...botId,
    previewId: z.string(),
    /** `soul`, `skill:<name>`, `memory:<topic>`, `note` or a package path. */
    part: z.string().max(1100),
  }),
  request("bots.share.publish.request", { ...botId, previewId: z.string() }),
  request("bots.share.stop.request", botId),
  request("bots.share.open.request", { link: z.string().min(1).max(2048) }),
  /** "View original": a copy's original as its link serves it now. */
  request("bots.share.original.request", botId),
  request("bots.share.create.request", { reviewId: z.string(), bot: BotInputSchema }),
] as const;
export const BotsShareResponseSchemas = [
  response("bots.share.status.response", { status: BotShareStatusSchema }),
  response("bots.share.prepare.response", {
    candidate: BotShareCandidateSchema,
    /** The picks the candidate was built from, when `last` found some. */
    last: BotShareSelectionSchema.optional(),
  }),
  response("bots.share.view.response", { files: z.array(BotSharePartFileSchema) }),
  response("bots.share.publish.response", { status: BotShareStatusSchema }),
  response("bots.share.stop.response", { status: BotShareStatusSchema }),
  response("bots.share.open.response", {
    review: BotShareReviewSchema.optional(),
    existing: BotShareExistingSchema.optional(),
  }),
  response("bots.share.original.response", { review: BotShareReviewSchema.optional() }),
  response("bots.share.create.response", { bot: BotSchema }),
] as const;

/** Codes the `bots.share.*` methods fail with, as the rpc error's message; clients map them to copy. */
export const BOT_SHARE_ERRORS = {
  blocked: "bot_share_secret_found",
  noteSecret: "bot_share_note_secret",
  expired: "bot_share_preview_expired",
  tooLarge: "bot_share_too_large",
  relayOff: "bot_share_relay_off",
  limit: "bot_share_limit",
  unavailable: "bot_share_unavailable",
  badLink: "bot_share_bad_link",
  stopped: "bot_share_stopped",
  updated: "bot_share_updated",
  reviewExpired: "bot_share_review_expired",
  invalid: "bot_share_invalid",
} as const;
export type BotShareErrorCode = (typeof BOT_SHARE_ERRORS)[keyof typeof BOT_SHARE_ERRORS];

export type BotShareFlag = z.infer<typeof BotShareFlagSchema>;
export type BotShareLeftOut = z.infer<typeof BotShareLeftOutSchema>;
export type BotShareSelection = z.infer<typeof BotShareSelectionSchema>;
export type BotSharePackage = z.infer<typeof BotSharePackageSchema>;
export type BotShareAvailable = z.infer<typeof BotShareAvailableSchema>;
export type BotShareCandidate = z.infer<typeof BotShareCandidateSchema>;
export type BotSharePartFile = z.infer<typeof BotSharePartFileSchema>;
export type BotSharedFrom = z.infer<typeof BotSharedFromSchema>;
export type BotShareStatus = z.infer<typeof BotShareStatusSchema>;
export type BotShareReview = z.infer<typeof BotShareReviewSchema>;
export type BotShareExisting = z.infer<typeof BotShareExistingSchema>;
