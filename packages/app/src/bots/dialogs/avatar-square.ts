// iOS and Android: the picker already cropped to a square (`allowsEditing`, 1:1); the centered square
// is taken again in case it didn't, then scaled to 512 px and saved as PNG.
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { ImagePickerAsset } from "expo-image-picker";
import { BOT_AVATAR_SIZE, BotAvatarIntakeFailure } from "./avatar-intake";

export async function squarePngFromPicked(asset: ImagePickerAsset): Promise<string> {
  const side = Math.min(asset.width, asset.height);
  const context = ImageManipulator.manipulate(asset.uri);
  if (side > 0 && asset.width !== asset.height) {
    context.crop({
      originX: (asset.width - side) / 2,
      originY: (asset.height - side) / 2,
      width: side,
      height: side,
    });
  }
  context.resize({ width: BOT_AVATAR_SIZE, height: BOT_AVATAR_SIZE });
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
  try {
    image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.PNG, base64: true });
    if (!saved.base64) throw new BotAvatarIntakeFailure("type");
    return saved.base64;
  } finally {
    image?.release();
    context.release();
  }
}
