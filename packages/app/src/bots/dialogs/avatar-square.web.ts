// Web (browser and Electron): Orca's canvas crop (`bot-avatar-upload.ts` squareAvatarPng and
// `shared/bots/bot-avatar-square.ts`): the centered square, drawn at 512 px, read back as PNG.
import type { ImagePickerAsset } from "expo-image-picker";
import {
  BOT_AVATAR_SIZE,
  BotAvatarIntakeFailure,
  MIN_BOT_AVATAR_SOURCE_SIZE,
} from "./avatar-intake";

export async function squarePngFromPicked(asset: ImagePickerAsset): Promise<string> {
  const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
  const bitmap = await createImageBitmap(blob);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side < MIN_BOT_AVATAR_SOURCE_SIZE) throw new BotAvatarIntakeFailure("too_small");
    const canvas = document.createElement("canvas");
    canvas.width = BOT_AVATAR_SIZE;
    canvas.height = BOT_AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new BotAvatarIntakeFailure("type");
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      BOT_AVATAR_SIZE,
      BOT_AVATAR_SIZE,
    );
    const url = canvas.toDataURL("image/png");
    return url.slice(url.indexOf(",") + 1);
  } finally {
    bitmap.close();
  }
}
