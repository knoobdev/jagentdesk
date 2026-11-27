// A picked image as a bot picture: cropped square from its center and scaled to 512 px, as base64 PNG
// (`bots.avatar.upload` takes 512-2000 px square PNGs). Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/bot-avatar-upload.ts and bot-avatar-intake.ts (the 10 MB and 128 px
// limits). The pixels are read per platform: `avatar-square.web.ts` (canvas) and `avatar-square.ts`
// (expo-image-manipulator).
import * as ImagePicker from "expo-image-picker";
import {
  BotAvatarIntakeFailure,
  MAX_BOT_AVATAR_SOURCE_BYTES,
  MIN_BOT_AVATAR_SOURCE_SIZE,
} from "./avatar-intake";
import { squarePngFromPicked } from "./avatar-square";

/** The library chooser, then the square PNG; null when nothing was picked. */
export async function pickBotAvatarPng(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: false,
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  if (asset.fileSize !== undefined && asset.fileSize > MAX_BOT_AVATAR_SOURCE_BYTES) {
    throw new BotAvatarIntakeFailure("too_big");
  }
  if (
    asset.width > 0 &&
    asset.height > 0 &&
    Math.min(asset.width, asset.height) < MIN_BOT_AVATAR_SOURCE_SIZE
  ) {
    throw new BotAvatarIntakeFailure("too_small");
  }
  try {
    return await squarePngFromPicked(asset);
  } catch (error) {
    if (error instanceof BotAvatarIntakeFailure) throw error;
    throw new BotAvatarIntakeFailure("type");
  }
}
