import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import {
  categoryDistribution,
  topPluginsByStars,
  type MarketplacePlugin,
} from "@/marketplace/catalog";

// Validated categorical palette (dataviz skill, dark-safe, CVD-checked). Two
// fixed hues assigned in rank order — stars use the blue mark, category counts
// the green mark — so the two ranked lists never blur into one rainbow.
const STARS_BAR_COLOR = "#3f8fd6";
const CATEGORY_BAR_COLOR = "#2aa876";
const TOP_STARS_LIMIT = 5;
const TOP_CATEGORIES_LIMIT = 6;

function trackWidth(value: number, max: number): `${number}%` {
  if (max <= 0) {
    return "0%";
  }
  const pct = Math.max(2, Math.round((value / max) * 100));
  return `${pct}%`;
}

interface RankedBarProps {
  label: string;
  value: string;
  width: `${number}%`;
  color: string;
}

function RankedBar({ label, value, width, color }: RankedBarProps) {
  const fillStyle = useMemo(
    () => [styles.barFill, { width, backgroundColor: color }],
    [width, color],
  );
  return (
    <View style={styles.barRow}>
      <View style={styles.barHeader}>
        <Text style={styles.barLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.barValue}>{value}</Text>
      </View>
      <View style={styles.barTrack}>
        <View style={fillStyle} />
      </View>
    </View>
  );
}

interface StatTileProps {
  value: string;
  label: string;
}

function StatTile({ value, label }: StatTileProps) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export function MarketplaceOverview({ plugins }: { plugins: MarketplacePlugin[] }) {
  const { t } = useTranslation();
  const topStars = useMemo(() => topPluginsByStars(plugins, TOP_STARS_LIMIT), [plugins]);
  const categories = useMemo(
    () => categoryDistribution(plugins).slice(0, TOP_CATEGORIES_LIMIT),
    [plugins],
  );
  const themeCount = useMemo(
    () => plugins.filter((plugin) => plugin.categories.includes("theme")).length,
    [plugins],
  );
  const maxStars = topStars[0]?.repoMeta.stars ?? 0;
  const maxCategory = categories[0]?.count ?? 0;

  return (
    <View style={styles.container}>
      <View style={styles.statRow}>
        <StatTile value={String(plugins.length)} label={t("marketplace.overview.totalPlugins")} />
        <StatTile value={String(categories.length)} label={t("marketplace.overview.categories")} />
        <StatTile value={String(themeCount)} label={t("marketplace.overview.themes")} />
      </View>
      <View style={styles.panels}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>{t("marketplace.overview.topByStars")}</Text>
          {topStars.map((plugin) => (
            <RankedBar
              key={plugin.id}
              label={plugin.name}
              value={String(plugin.repoMeta.stars)}
              width={trackWidth(plugin.repoMeta.stars, maxStars)}
              color={STARS_BAR_COLOR}
            />
          ))}
        </View>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>{t("marketplace.overview.categoryDistribution")}</Text>
          {categories.map((entry) => (
            <RankedBar
              key={entry.category}
              label={entry.category}
              value={String(entry.count)}
              width={trackWidth(entry.count, maxCategory)}
              color={CATEGORY_BAR_COLOR}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { gap: theme.spacing[3] },
  statRow: { flexDirection: "row", gap: theme.spacing[3] },
  statTile: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[1],
  },
  statValue: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  statLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  panels: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  panel: {
    flexGrow: 1,
    flexBasis: 260,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  panelTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  barRow: { gap: theme.spacing[1] },
  barHeader: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[2] },
  barLabel: { flex: 1, fontSize: theme.fontSize.xs, color: theme.colors.foreground },
  barValue: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  barFill: { height: 8, borderRadius: 4 },
}));
