import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import type { Theme } from "@/styles/theme";
import {
  displayThemeName,
  type MarketplacePlugin,
  type ThemeAppearanceFilter,
  type ThemeVariant,
} from "@/marketplace/catalog";
import type { MarketplaceInstallStatus } from "@/marketplace/marketplace-card";

const PREVIEW_HEIGHT = 124;

/**
 * A miniature app window painted with the variant's own palette — sidebar, title, secondary
 * text, a raised card, an accent button and an input — so a theme can be judged before it is
 * installed. Every color comes from the catalog entry; nothing is invented.
 */
export function ThemePreview({ colors }: { colors: ThemeVariant["colors"] }) {
  const s = useMemo(
    () => ({
      frame: [styles.frame, { backgroundColor: colors.background, borderColor: colors.border }],
      sidebar: [
        styles.sidebar,
        { backgroundColor: colors.raised, borderRightColor: colors.border },
      ],
      navActive: [styles.navItem, { backgroundColor: colors.control }],
      navDot: [styles.navDot, { backgroundColor: colors.accent }],
      navText: [styles.navLine, { backgroundColor: colors.foreground }],
      navMuted: [styles.navLine, styles.navLineShort, { backgroundColor: colors.mutedForeground }],
      title: [styles.titleLine, { backgroundColor: colors.foreground }],
      muted: [styles.textLine, { backgroundColor: colors.mutedForeground }],
      mutedShort: [
        styles.textLine,
        styles.textLineShort,
        { backgroundColor: colors.mutedForeground },
      ],
      card: [styles.card, { backgroundColor: colors.raised, borderColor: colors.border }],
      cardLine: [styles.textLine, { backgroundColor: colors.foreground }],
      button: [styles.button, { backgroundColor: colors.accent }],
      input: [styles.input, { backgroundColor: colors.control, borderColor: colors.border }],
    }),
    [colors],
  );
  return (
    <View style={s.frame}>
      <View style={s.sidebar}>
        <View style={s.navActive}>
          <View style={s.navDot} />
          <View style={s.navText} />
        </View>
        <View style={styles.navItem}>
          <View style={s.navMuted} />
        </View>
        <View style={styles.navItem}>
          <View style={s.navMuted} />
        </View>
      </View>
      <View style={styles.main}>
        <View style={s.title} />
        <View style={s.muted} />
        <View style={s.mutedShort} />
        <View style={s.card}>
          <View style={s.cardLine} />
          <View style={s.mutedShort} />
        </View>
        <View style={styles.actionRow}>
          <View style={s.button} />
          <View style={s.input} />
        </View>
      </View>
    </View>
  );
}

function VariantDot({
  variant,
  index,
  active,
  onSelect,
}: {
  variant: ThemeVariant;
  index: number;
  active: boolean;
  onSelect: (index: number) => void;
}) {
  const handlePress = useCallback(() => onSelect(index), [index, onSelect]);
  const dotStyle = useMemo(
    () => [
      styles.dot,
      active ? styles.dotActive : null,
      { backgroundColor: variant.colors.background, borderColor: variant.colors.accent },
    ],
    [active, variant.colors.accent, variant.colors.background],
  );
  return (
    <Pressable
      onPress={handlePress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={variant.name}
      style={dotStyle}
    />
  );
}

interface ThemeCardProps {
  plugin: MarketplacePlugin;
  variants: ThemeVariant[];
  installStatus: MarketplaceInstallStatus;
  onOpenDetail: (plugin: MarketplacePlugin) => void;
  onInstall: (plugin: MarketplacePlugin) => void;
}

export function ThemeCard({
  plugin,
  variants,
  installStatus,
  onOpenDetail,
  onInstall,
}: ThemeCardProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [activeIndex, setActiveIndex] = useState(0);
  const active = variants[Math.min(activeIndex, variants.length - 1)];
  const handleOpen = useCallback(() => onOpenDetail(plugin), [onOpenDetail, plugin]);
  const handleInstall = useCallback(() => onInstall(plugin), [onInstall, plugin]);
  const appearances = useMemo(
    () => [...new Set(variants.map((variant) => variant.appearance))].sort(),
    [variants],
  );

  let installLabel = t("marketplace.card.install");
  if (installStatus === "pending") installLabel = t("marketplace.card.installing");
  else if (installStatus === "installed") installLabel = t("marketplace.card.installed");
  else if (installStatus === "failed") installLabel = t("marketplace.card.retryInstall");

  // The card is a plain container: the preview and name open the detail sheet, while the
  // variant dots and install button are sibling controls (no nested buttons on web).
  return (
    <View style={styles.cardRoot} testID={`marketplace-theme-${plugin.id}`}>
      <Pressable onPress={handleOpen} accessibilityRole="button" accessibilityLabel={plugin.name}>
        {active ? (
          <ThemePreview colors={active.colors} />
        ) : (
          <View style={styles.previewMissing}>
            <Text style={styles.previewMissingText}>{t("marketplace.themes.noPreview")}</Text>
          </View>
        )}
      </Pressable>
      <View style={styles.body}>
        <View style={styles.headRow}>
          <Pressable style={styles.nameButton} onPress={handleOpen}>
            <Text style={styles.name} numberOfLines={1}>
              {displayThemeName(plugin)}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {active && variants.length > 1 ? active.name : plugin.author || plugin.repo}
            </Text>
          </Pressable>
          {variants.length > 1 ? (
            <View style={styles.dots}>
              {variants.map((variant, index) => (
                <VariantDot
                  key={variant.id || index}
                  variant={variant}
                  index={index}
                  active={variant === active}
                  onSelect={setActiveIndex}
                />
              ))}
            </View>
          ) : null}
        </View>
        <View style={isCompact ? styles.footerCompact : styles.footer}>
          <View style={styles.tags}>
            {appearances.map((appearance) => (
              <Text key={appearance} style={styles.tag}>
                {t(`marketplace.themes.appearance.${appearance}`)}
              </Text>
            ))}
            {variants.length > 1 && !isCompact ? (
              <Text style={styles.tagMuted}>
                {t("marketplace.themes.variants", { count: variants.length })}
              </Text>
            ) : null}
          </View>
          <Button
            size="sm"
            variant={installStatus === "installed" ? "ghost" : "outline"}
            onPress={handleInstall}
            loading={installStatus === "pending"}
            disabled={installStatus === "pending" || installStatus === "installed"}
            leftIcon={installStatus === "installed" ? Check : undefined}
            testID={`marketplace-theme-install-${plugin.id}`}
          >
            {installLabel}
          </Button>
        </View>
      </View>
    </View>
  );
}

/** Search + appearance filter for the Themes tab. */
export function ThemeControls({
  search,
  searchResetKey,
  onSearchChange,
  appearance,
  onAppearanceChange,
  resultCount,
}: {
  search: string;
  searchResetKey: number;
  onSearchChange: (value: string) => void;
  appearance: ThemeAppearanceFilter;
  onAppearanceChange: (value: ThemeAppearanceFilter) => void;
  resultCount: number;
}) {
  const { t } = useTranslation();
  const options = useMemo<SegmentedControlOption<ThemeAppearanceFilter>[]>(
    () => [
      { value: "all", label: t("marketplace.themes.filter.all"), testID: "marketplace-themes-all" },
      {
        value: "dark",
        label: t("marketplace.themes.appearance.dark"),
        testID: "marketplace-themes-dark",
      },
      {
        value: "light",
        label: t("marketplace.themes.appearance.light"),
        testID: "marketplace-themes-light",
      },
    ],
    [t],
  );
  return (
    <View style={styles.controls}>
      <AdaptiveTextInput
        style={styles.search}
        initialValue={search}
        resetKey={`marketplace-theme-search-${searchResetKey}`}
        onChangeText={onSearchChange}
        placeholder={t("marketplace.themes.searchPlaceholder")}
        autoCapitalize="none"
        autoCorrect={false}
        testID="marketplace-themes-search"
      />
      <View style={styles.controlsRow}>
        <SegmentedControl
          options={options}
          value={appearance}
          onValueChange={onAppearanceChange}
          size="sm"
        />
        <Text style={styles.resultCount}>
          {t("marketplace.themes.count", { count: resultCount })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  cardRoot: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  frame: {
    height: PREVIEW_HEIGHT,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    flexDirection: "row",
  },
  sidebar: {
    width: "30%",
    borderRightWidth: 1,
    paddingTop: 10,
    paddingHorizontal: 6,
    gap: 4,
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 14,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  navDot: { width: 5, height: 5, borderRadius: 3 },
  navLine: { height: 4, borderRadius: 2, flex: 1, opacity: 0.9 },
  navLineShort: { opacity: 0.55, maxWidth: "70%" },
  main: { flex: 1, padding: 10, gap: 5 },
  titleLine: { height: 6, width: "55%", borderRadius: 3 },
  textLine: { height: 4, width: "82%", borderRadius: 2, opacity: 0.7 },
  textLineShort: { width: "60%" },
  card: {
    marginTop: 2,
    padding: 6,
    gap: 4,
    borderWidth: 1,
    borderRadius: 5,
  },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: "auto" },
  button: { width: "34%", height: 12, borderRadius: 4 },
  input: { flex: 1, height: 12, borderRadius: 4, borderWidth: 1 },
  previewMissing: {
    height: PREVIEW_HEIGHT,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  previewMissingText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  body: { gap: theme.spacing[1.5], paddingHorizontal: theme.spacing[1] },
  headRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  nameButton: { flex: 1, minWidth: 0, gap: 2 },
  // Narrow two-column grids stack the tags above a full-width install button.
  footerCompact: { gap: theme.spacing[2] },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  name: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  dots: { flexDirection: "row", gap: 5 },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  dotActive: { transform: [{ scale: 1.2 }] },
  meta: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  tags: { flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  tag: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  controls: { gap: theme.spacing[2] },
  controlsRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  search: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  resultCount: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  tagMuted: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
    paddingVertical: 2,
  },
}));
