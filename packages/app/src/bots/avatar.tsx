// The bot's picture, ported from Orca dfdb4fda (MIT) `mobile/src/bots/MobileBotAvatar.tsx` (the
// transparent mascot render on the bot's tile color, its light rim on a dark color, any outfit on
// top) and `src/renderer/src/components/bots/BotAvatar.tsx` (the fallback initial). One component
// for desktop, web and phone.
import { memo, useMemo } from "react";
import { Image, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  BOT_MASCOT_IDS,
  DEFAULT_BOT_AVATAR_COLOR,
  type BotMascotId,
} from "@jagentdesk/protocol/bots/rules";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { useBotsRead } from "./queries";
import {
  OUTFIT_SHEET_COLUMNS,
  OUTFIT_SHEET_ROWS,
  botMascotAsset,
  botMascotRimAsset,
  botOutfitAsset,
  botOutfitReplacesPicture,
  isBotAvatarOutfitId,
  type BotAvatarOutfitId,
} from "./mascots";

function channel(hex: string): number {
  const c = Number.parseInt(hex, 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** `shared/bots/bot-avatar-color.ts`: dark enough that a dark mascot would sink into it. */
export function isDarkBotAvatarColor(color: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => channel(color.slice(i, i + 2)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.18;
}

/** `mascot:<id>` → the id, when it is one of the 20 mascots. */
export function parseBotMascot(avatar: string | null | undefined): BotMascotId | null {
  if (!avatar?.startsWith("mascot:")) return null;
  const id = avatar.slice("mascot:".length);
  return BOT_MASCOT_IDS.find((entry) => entry === id) ?? null;
}

/** `shared/bots/bot-avatar-fallback.ts` botInitial. */
export function botInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

export interface BotPicture {
  mascot: BotMascotId | null;
  /** An uploaded picture (`upload:<sha16>`), as a data URI, once read. */
  uri?: string | null;
  color: string;
  outfit: BotAvatarOutfitId | null;
  initial: string;
}

export function botPicture(
  bot: Pick<Bot, "name" | "avatar" | "avatarColor" | "avatarOutfit">,
): BotPicture {
  return {
    mascot: parseBotMascot(bot.avatar),
    color: bot.avatarColor ?? DEFAULT_BOT_AVATAR_COLOR,
    outfit: isBotAvatarOutfitId(bot.avatarOutfit) ? bot.avatarOutfit : null,
    initial: botInitial(bot.name),
  };
}

export const BotAvatar = memo(function BotAvatar({
  bot,
  serverId,
  size = 16,
  radius,
  style,
  testID,
}: {
  bot: Pick<Bot, "name" | "avatar" | "avatarColor" | "avatarOutfit"> & { id?: string };
  /** With the bot's id: reads an uploaded picture (`bots.avatar.read`). */
  serverId?: string;
  size?: number;
  /** Defaults to a quarter of the size (4 px at 16 px, `BORDER_RADIUS.base`). */
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { id, name, avatar, avatarColor, avatarOutfit } = bot;
  const uploaded = Boolean(avatar?.startsWith("upload:") && serverId && id);
  const upload = useBotsRead(
    serverId ?? "",
    "bots.avatar.read.request",
    { botId: id ?? "" },
    { enabled: uploaded, select: (payload) => payload.png },
  );
  const uri = uploaded && upload.data ? `data:image/png;base64,${upload.data}` : null;
  const picture = useMemo(
    () => ({ ...botPicture({ name, avatar, avatarColor, avatarOutfit }), uri }),
    [name, avatar, avatarColor, avatarOutfit, uri],
  );
  return (
    <BotAvatarTile picture={picture} size={size} radius={radius} style={style} testID={testID} />
  );
});

/** The tile itself, also for a picture not yet saved to a bot (the New bot dialog). */
export function BotAvatarTile({
  picture,
  size,
  radius,
  style,
  testID,
}: {
  picture: BotPicture;
  size: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const frame = useMemo(
    () => ({ width: size, height: size, borderRadius: radius ?? size / 4 }),
    [size, radius],
  );
  const layer = useMemo(() => ({ width: size, height: size }), [size]);
  const { mascot, color, outfit } = picture;
  const tileStyle = useMemo(
    () => [styles.tile, frame, mascot ? { backgroundColor: color } : null, style],
    [frame, mascot, color, style],
  );
  const letterStyle = useMemo(
    () => [styles.letter, { fontSize: Math.max(8, Math.round(size * 0.6)) }],
    [size],
  );
  if (picture.uri) {
    return <UploadedTile uri={picture.uri} tileStyle={tileStyle} layer={layer} testID={testID} />;
  }
  if (!mascot) {
    return (
      <View style={tileStyle} testID={testID} accessibilityElementsHidden>
        <Text style={letterStyle}>{picture.initial}</Text>
      </View>
    );
  }
  return (
    <View
      style={tileStyle}
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {isDarkBotAvatarColor(color) ? (
        <Image source={botMascotRimAsset(mascot)} style={[styles.layer, layer]} />
      ) : null}
      {outfit && botOutfitReplacesPicture(outfit) ? null : (
        <Image source={botMascotAsset(mascot)} style={[styles.layer, layer]} />
      )}
      {outfit ? <OutfitLayer outfit={outfit} id={mascot} size={size} /> : null}
    </View>
  );
}

function UploadedTile({
  uri,
  tileStyle,
  layer,
  testID,
}: {
  uri: string;
  tileStyle: StyleProp<ViewStyle>;
  layer: { width: number; height: number };
  testID?: string;
}) {
  const source = useMemo(() => ({ uri }), [uri]);
  const imageStyle = useMemo(() => [styles.layer, layer], [layer]);
  return (
    <View style={tileStyle} testID={testID} accessibilityElementsHidden>
      <Image source={source} style={imageStyle} />
    </View>
  );
}

/** The mascot's cell of its outfit's sheet: the sheet drawn at `size` per cell, shifted under a `size` window. */
function OutfitLayer({
  outfit,
  id,
  size,
}: {
  outfit: BotAvatarOutfitId;
  id: BotMascotId;
  size: number;
}) {
  const { sheet, column, row } = botOutfitAsset(outfit, id);
  const sheetStyle = useMemo(
    () => ({
      position: "absolute" as const,
      left: -column * size,
      top: -row * size,
      width: size * OUTFIT_SHEET_COLUMNS,
      height: size * OUTFIT_SHEET_ROWS,
    }),
    [column, row, size],
  );
  return (
    <View style={styles.window}>
      <Image source={sheet} style={sheetStyle} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tile: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: 0,
    backgroundColor: theme.colors.surface2,
  },
  layer: { position: "absolute", left: 0, top: 0 },
  window: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, overflow: "hidden" },
  letter: { color: theme.colors.foregroundMuted, fontWeight: "600" },
}));
