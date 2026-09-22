import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import type { Theme } from "@/styles/theme";
import { MARKETPLACE_CATEGORIES, type MarketplaceSort } from "@/marketplace/catalog";

const SORT_OPTIONS: MarketplaceSort[] = [
  "popular",
  "recentlyAdded",
  "recentlyReleased",
  "alphabetical",
];

interface ChipProps {
  value: string;
  label: string;
  active: boolean;
  onToggle: (value: string) => void;
}

function FilterChip({ value, label, active, onToggle }: ChipProps) {
  const handlePress = useCallback(() => onToggle(value), [onToggle, value]);
  const state = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      onPress={handlePress}
      style={active ? styles.chipActiveWrap : styles.chip}
      accessibilityRole="button"
      accessibilityState={state}
    >
      <Text style={active ? styles.chipTextActive : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

interface SortOptionProps {
  value: MarketplaceSort;
  label: string;
  active: boolean;
  onSelect: (value: MarketplaceSort) => void;
}

function SortOption({ value, label, active, onSelect }: SortOptionProps) {
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  const state = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      onPress={handlePress}
      style={active ? styles.sortTabActiveWrap : styles.sortTab}
      accessibilityRole="button"
      accessibilityState={state}
    >
      <Text style={active ? styles.sortTabTextActive : styles.sortTabText}>{label}</Text>
    </Pressable>
  );
}

export interface MarketplaceControlsProps {
  search: string;
  searchResetKey: number;
  onSearchChange: (value: string) => void;
  sort: MarketplaceSort;
  onSortChange: (value: MarketplaceSort) => void;
  selectedCategories: string[];
  onToggleCategory: (value: string) => void;
  platforms: string[];
  selectedPlatforms: string[];
  onTogglePlatform: (value: string) => void;
  onClearFilters: () => void;
  resultCount: number;
}

export function MarketplaceControls({
  search,
  searchResetKey,
  onSearchChange,
  sort,
  onSortChange,
  selectedCategories,
  onToggleCategory,
  platforms,
  selectedPlatforms,
  onTogglePlatform,
  onClearFilters,
  resultCount,
}: MarketplaceControlsProps) {
  const { t } = useTranslation();
  const sortLabels = useMemo<Record<MarketplaceSort, string>>(
    () => ({
      popular: t("marketplace.sort.popular"),
      recentlyAdded: t("marketplace.sort.recentlyAdded"),
      recentlyReleased: t("marketplace.sort.recentlyReleased"),
      alphabetical: t("marketplace.sort.alphabetical"),
    }),
    [t],
  );
  const hasFilters = selectedCategories.length > 0 || selectedPlatforms.length > 0;

  return (
    <View style={styles.container}>
      <AdaptiveTextInput
        style={styles.search}
        initialValue={search}
        resetKey={`marketplace-search-${searchResetKey}`}
        onChangeText={onSearchChange}
        placeholder={t("marketplace.search.placeholder")}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={styles.sortRow}>
        {SORT_OPTIONS.map((option) => (
          <SortOption
            key={option}
            value={option}
            label={sortLabels[option]}
            active={sort === option}
            onSelect={onSortChange}
          />
        ))}
      </View>

      <Text style={styles.groupLabel}>{t("marketplace.filters.categories")}</Text>
      <View style={styles.chips}>
        {MARKETPLACE_CATEGORIES.map((category) => (
          <FilterChip
            key={category}
            value={category}
            label={category}
            active={selectedCategories.includes(category)}
            onToggle={onToggleCategory}
          />
        ))}
      </View>

      {platforms.length > 0 ? (
        <>
          <Text style={styles.groupLabel}>{t("marketplace.filters.platforms")}</Text>
          <View style={styles.chips}>
            {platforms.map((platform) => (
              <FilterChip
                key={platform}
                value={platform}
                label={platform}
                active={selectedPlatforms.includes(platform)}
                onToggle={onTogglePlatform}
              />
            ))}
          </View>
        </>
      ) : null}

      <View style={styles.footerRow}>
        <Text style={styles.count}>
          {t("marketplace.filters.resultCount", { count: resultCount })}
        </Text>
        {hasFilters ? (
          <Pressable onPress={onClearFilters} accessibilityRole="button">
            <Text style={styles.clear}>{t("marketplace.filters.clear")}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { gap: theme.spacing[2] },
  search: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  sortRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  sortTab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  sortTabActiveWrap: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  sortTabText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  sortTabTextActive: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  groupLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[1],
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  chip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipActiveWrap: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  chipText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  chipTextActive: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme.spacing[1],
  },
  count: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  clear: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accent,
  },
}));
