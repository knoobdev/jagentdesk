// A bot's picture: the mascot carousel, its tile color and its outfit. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/BotPicturePicker.tsx:64-353 (picker), BotPictureCarousel.tsx:36-218
// (the current face large, its wrapped neighbours dimmed, "Previous picture" / "Next picture",
// "Mascot {{n}} of {{total}}") and BotPictureLook.tsx (color swatches, "Custom color", outfits).
// Left out: the upload / paste / drop line and Generate (no avatar upload RPC in the bots contract,
// AI avatars deferred by spec 37.2.2).
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Check, ChevronLeft, ChevronRight, Plus } from "lucide-react-native";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_OUTFITS,
  PICKABLE_BOT_MASCOT_IDS,
} from "@jagentdesk/protocol/bots/rules";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { Theme } from "@/styles/theme";
import { BotAvatarTile, botPicture } from "@/bots/avatar";
import {
  BOT_AVATAR_COLOR_NAME_KEYS,
  BOT_AVATAR_OUTFIT_NAME_KEYS,
  isBotAvatarColor,
  mascotAvatar,
  pickableMascotIndex,
  wrapIndex,
} from "./new-bot-model";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCheck = withUnistyles(Check);
const ThemedPlus = withUnistyles(Plus);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });

export interface BotPictureValue {
  avatar: string;
  avatarColor: string;
  avatarOutfit: string | null;
}

const COUNT = PICKABLE_BOT_MASCOT_IDS.length;
// The current face 112 px, its neighbours 72 px (`BotPictureCarousel.tsx` NEIGHBOUR_SCALE).
const CURRENT_SIZE = 112;
const NEIGHBOUR_SIZE = 72;

function tile(index: number, color: string, outfit: string | null) {
  return botPicture({
    name: "",
    avatar: mascotAvatar(index),
    avatarColor: color,
    avatarOutfit: outfit,
  });
}

/** The picker itself, for any surface (New bot shows it inline under the picture). */
export function BotPicturePickerContent({
  value,
  onChange,
}: {
  value: BotPictureValue;
  onChange: (next: BotPictureValue) => void;
}) {
  const { t } = useTranslation();
  const found = pickableMascotIndex(value.avatar);
  const index = found === -1 ? 0 : found;
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState(value.avatarColor);
  const go = useCallback(
    (delta: number) => onChange({ ...value, avatar: mascotAvatar(index + delta) }),
    [index, onChange, value],
  );
  const previous = useCallback(() => go(-1), [go]);
  const next = useCallback(() => go(1), [go]);
  const isSwatch = (BOT_AVATAR_COLORS as readonly string[]).includes(value.avatarColor);
  const setColor = useCallback(
    (avatarColor: string) => onChange({ ...value, avatarColor }),
    [onChange, value],
  );
  const setOutfit = useCallback(
    (avatarOutfit: string | null) => onChange({ ...value, avatarOutfit }),
    [onChange, value],
  );
  const toggleCustom = useCallback(() => setCustomOpen((open) => !open), []);
  const editCustom = useCallback(
    (text: string) => {
      setCustomText(text);
      const normalized = text.trim().toLowerCase();
      const hex = normalized.startsWith("#") ? normalized : `#${normalized}`;
      if (isBotAvatarColor(hex)) setColor(hex);
    },
    [setColor],
  );
  const description = t("bots.new.pictureMascot", { n: index + 1, total: COUNT });
  return (
    <View style={styles.picker} testID="bot-picture-picker">
      <View style={styles.carousel}>
        <Pressable
          onPress={previous}
          accessibilityRole="button"
          accessibilityLabel={t("bots.new.previousPicture")}
          style={styles.arrow}
          testID="bot-picture-previous"
        >
          <ThemedChevronLeft size={18} uniProps={foreground} />
        </Pressable>
        <Pressable onPress={previous} style={styles.neighbour} accessibilityElementsHidden>
          <BotAvatarTile
            picture={tile(wrapIndex(index - 1, COUNT), value.avatarColor, value.avatarOutfit)}
            size={NEIGHBOUR_SIZE}
            radius={16}
          />
        </Pressable>
        <View accessibilityLabel={description} accessibilityLiveRegion="polite">
          <BotAvatarTile
            picture={tile(index, value.avatarColor, value.avatarOutfit)}
            size={CURRENT_SIZE}
            radius={24}
            testID={`bot-picture-current-${PICKABLE_BOT_MASCOT_IDS[index]}`}
          />
        </View>
        <Pressable onPress={next} style={styles.neighbour} accessibilityElementsHidden>
          <BotAvatarTile
            picture={tile(wrapIndex(index + 1, COUNT), value.avatarColor, value.avatarOutfit)}
            size={NEIGHBOUR_SIZE}
            radius={16}
          />
        </Pressable>
        <Pressable
          onPress={next}
          accessibilityRole="button"
          accessibilityLabel={t("bots.new.nextPicture")}
          style={styles.arrow}
          testID="bot-picture-next"
        >
          <ThemedChevronRight size={18} uniProps={foreground} />
        </Pressable>
      </View>
      <Text style={styles.caption} testID="bot-picture-description">
        {description}
      </Text>
      <Text style={styles.heading}>{t("bots.new.pictureColor")}</Text>
      <View style={styles.swatches} accessibilityRole="radiogroup">
        {BOT_AVATAR_COLORS.map((color) => (
          <Swatch
            key={color}
            color={color}
            label={t(BOT_AVATAR_COLOR_NAME_KEYS[color])}
            selected={value.avatarColor === color}
            onSelect={setColor}
          />
        ))}
        <Pressable
          onPress={toggleCustom}
          accessibilityRole="button"
          accessibilityLabel={t("bots.new.pictureColorCustom")}
          style={[styles.swatch, styles.customSwatch, !isSwatch && styles.swatchSelected]}
          testID="bot-picture-color-custom"
        >
          <ThemedPlus size={14} uniProps={foreground} />
        </Pressable>
      </View>
      {customOpen ? (
        <FormTextInput
          value={customText}
          initialValue={customText}
          webControlled
          onChangeText={editCustom}
          size="sm"
          autoCapitalize="none"
          accessibilityLabel={t("bots.new.pictureColorCustom")}
          placeholder="#rrggbb"
          testID="bot-picture-color-input"
        />
      ) : null}
      <Text style={styles.heading}>{t("bots.new.pictureOutfit")}</Text>
      <ScrollView horizontal contentContainerStyle={styles.outfits}>
        <OutfitOption
          index={index}
          color={value.avatarColor}
          outfit={null}
          label={t("bots.new.outfitNone")}
          selected={value.avatarOutfit === null}
          onSelect={setOutfit}
        />
        {BOT_AVATAR_OUTFITS.map((outfit) => (
          <OutfitOption
            key={outfit}
            index={index}
            color={value.avatarColor}
            outfit={outfit}
            label={t(BOT_AVATAR_OUTFIT_NAME_KEYS[outfit] ?? outfit)}
            selected={value.avatarOutfit === outfit}
            onSelect={setOutfit}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function Swatch({
  color,
  label,
  selected,
  onSelect,
}: {
  color: string;
  label: string;
  selected: boolean;
  onSelect: (color: string) => void;
}) {
  const press = useCallback(() => onSelect(color), [color, onSelect]);
  const fill = useMemo(() => ({ backgroundColor: color }), [color]);
  return (
    <Pressable
      onPress={press}
      accessibilityRole="radio"
      accessibilityLabel={label}
      aria-checked={selected}
      style={[styles.swatch, fill, selected && styles.swatchSelected]}
      testID={`bot-picture-color-${color.slice(1)}`}
    >
      {selected ? <ThemedCheck size={12} uniProps={foreground} /> : null}
    </Pressable>
  );
}

function OutfitOption({
  index,
  color,
  outfit,
  label,
  selected,
  onSelect,
}: {
  index: number;
  color: string;
  outfit: string | null;
  label: string;
  selected: boolean;
  onSelect: (outfit: string | null) => void;
}) {
  const press = useCallback(() => onSelect(outfit), [onSelect, outfit]);
  return (
    <Pressable
      onPress={press}
      accessibilityRole="radio"
      accessibilityLabel={label}
      aria-checked={selected}
      style={[styles.outfit, selected && styles.outfitSelected]}
      testID={`bot-picture-outfit-${outfit ?? "none"}`}
    >
      <BotAvatarTile picture={tile(index, color, outfit)} size={40} radius={10} />
    </Pressable>
  );
}

/** The picker in its own sheet, for a saved bot's picture (Settings header). */
export function BotPicturePicker({
  value,
  onChange,
  onClose,
}: {
  value: BotPictureValue;
  onChange: (next: BotPictureValue) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const header = useMemo(() => ({ title: t("bots.new.picture") }), [t]);
  const save = useCallback(() => {
    onChange(draft);
    onClose();
  }, [draft, onChange, onClose]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="outline" size="sm" onPress={onClose}>
          {t("bots.new.cancel")}
        </Button>
        <Button variant="default" size="sm" onPress={save} testID="bot-picture-save">
          {t("bots.groups.save")}
        </Button>
      </View>
    ),
    [onClose, save, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      footer={footer}
      desktopMaxWidth={400}
      testID="bot-picture-sheet"
    >
      <BotPicturePickerContent value={draft} onChange={setDraft} />
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  picker: { gap: 10 },
  carousel: {
    height: CURRENT_SIZE + 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  arrow: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  neighbour: { opacity: 0.4 },
  caption: { textAlign: "center", fontSize: 12, color: theme.colors.foregroundMuted },
  heading: { fontSize: 12, fontWeight: "600", color: theme.colors.foregroundMuted },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  swatch: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  customSwatch: { backgroundColor: theme.colors.surface2 },
  swatchSelected: { borderWidth: 2, borderColor: theme.colors.foreground },
  outfits: { gap: 8, paddingVertical: 2 },
  outfit: { borderRadius: 12, borderWidth: 2, borderColor: "transparent", padding: 1 },
  outfitSelected: { borderColor: theme.colors.foreground },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
}));
