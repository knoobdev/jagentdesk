// How a mascot is drawn from bt1's bundled files (`mascot-assets.ts`), ported from Orca dfdb4fda
// (MIT) `mobile/src/bots/mobile-bot-mascot-assets.ts` and `mobile-bot-outfit-assets.ts`.
import type { ImageSourcePropType } from "react-native";
import { BOT_MASCOT_ASSETS, BOT_OUTFIT_ASSETS } from "./mascot-assets";
import { BOT_MASCOT_IDS, type BotMascotId } from "@jagentdesk/protocol/bots/rules";

export type BotAvatarOutfitId =
  | "tie"
  | "detective"
  | "hard-hat"
  | "reviewer"
  | "night-shift"
  | "artist"
  | "scientist"
  | "party"
  | "security";

/** The transparent render, drawn on the bot's tile color. */
export function botMascotAsset(id: BotMascotId): ImageSourcePropType {
  return BOT_MASCOT_ASSETS[id].image;
}

/** The mascot's light rim alone, drawn under it on a dark tile so a dark mascot doesn't sink into it. */
export function botMascotRimAsset(id: BotMascotId): ImageSourcePropType {
  return BOT_MASCOT_ASSETS[id].rim;
}

// One sheet per outfit, each mascot's transparent render in BOT_MASCOT_IDS order.
const OUTFIT_IDS: readonly BotAvatarOutfitId[] = [
  "tie",
  "detective",
  "hard-hat",
  "reviewer",
  "night-shift",
  "artist",
  "scientist",
  "party",
  "security",
];

/** Mascots per row of an outfit sheet. */
export const OUTFIT_SHEET_COLUMNS = 5;
export const OUTFIT_SHEET_ROWS = Math.ceil(BOT_MASCOT_IDS.length / OUTFIT_SHEET_COLUMNS);

export function isBotAvatarOutfitId(value: string | null | undefined): value is BotAvatarOutfitId {
  return OUTFIT_IDS.some((id) => id === value);
}

/** The reviewer looks down at its page, so its render is the whole mascot, drawn instead of the picture. */
export function botOutfitReplacesPicture(outfit: BotAvatarOutfitId): boolean {
  return outfit === "reviewer";
}

/** The outfit's sheet and the column and row of `id`'s render on it. */
export function botOutfitAsset(
  outfit: BotAvatarOutfitId,
  id: BotMascotId,
): { sheet: ImageSourcePropType; column: number; row: number } {
  const index = BOT_MASCOT_IDS.indexOf(id);
  return {
    sheet: BOT_OUTFIT_ASSETS[outfit],
    column: index % OUTFIT_SHEET_COLUMNS,
    row: Math.floor(index / OUTFIT_SHEET_COLUMNS),
  };
}
