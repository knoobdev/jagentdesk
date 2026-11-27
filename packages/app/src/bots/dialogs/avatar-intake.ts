// Why a picked picture was refused, and the limits (Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/bot-avatar-intake.ts, shared/bot-avatar.ts).
/** Orca `BotAvatarIntakeError`. */
export type BotAvatarIntakeError = "too_big" | "type" | "too_small";

export class BotAvatarIntakeFailure extends Error {
  constructor(readonly error: BotAvatarIntakeError) {
    super(`bot_avatar_${error}`);
  }
}

/** Orca `MAX_BOT_AVATAR_SOURCE_BYTES`. */
export const MAX_BOT_AVATAR_SOURCE_BYTES = 10 * 1024 * 1024;
/** Orca `BOT_AVATAR_TOO_SMALL`: a source under 128 px is refused rather than blown up. */
export const MIN_BOT_AVATAR_SOURCE_SIZE = 128;
/** Orca `BOT_AVATAR_SIZE`. */
export const BOT_AVATAR_SIZE = 512;

/** `bots.avatar.intake.*` for each refusal (Orca `useIntakeErrorMessage`). */
export function intakeErrorKey(error: unknown): string {
  const kind = error instanceof BotAvatarIntakeFailure ? error.error : "type";
  switch (kind) {
    case "too_big":
      return "bots.avatar.intake.tooBig";
    case "too_small":
      return "bots.avatar.intake.tooSmall";
    case "type":
      return "bots.avatar.intake.type";
  }
}
