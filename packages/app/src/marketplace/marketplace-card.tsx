import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { Star, Download, Check } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { npmDownloads, type MarketplacePlugin } from "@/marketplace/catalog";

const ThemedStar = withUnistyles(Star);
const ThemedDownload = withUnistyles(Download);
const ThemedCheck = withUnistyles(Check);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successColor = (theme: Theme) => ({ color: theme.colors.statusSuccess });

const MAX_CATEGORY_CHIPS = 3;

export type MarketplaceInstallStatus = "idle" | "pending" | "installed" | "failed";

function formatDownloads(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return String(value);
}

interface HealthBadgeProps {
  label: string;
}

function HealthBadge({ label }: HealthBadgeProps) {
  return (
    <View style={styles.healthBadge}>
      <ThemedCheck size={11} uniProps={successColor} />
      <Text style={styles.healthBadgeText}>{label}</Text>
    </View>
  );
}

interface MarketplaceCardProps {
  plugin: MarketplacePlugin;
  installStatus: MarketplaceInstallStatus;
  onOpenDetail: (plugin: MarketplacePlugin) => void;
  onInstall: (plugin: MarketplacePlugin) => void;
}

export function MarketplaceCard({
  plugin,
  installStatus,
  onOpenDetail,
  onInstall,
}: MarketplaceCardProps) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => onOpenDetail(plugin), [onOpenDetail, plugin]);
  const handleInstall = useCallback(() => onInstall(plugin), [onInstall, plugin]);
  const downloads = npmDownloads(plugin);
  const chips = useMemo(() => plugin.categories.slice(0, MAX_CATEGORY_CHIPS), [plugin.categories]);
  const healthLabels = useMemo(() => {
    const labels: string[] = [];
    if (plugin.health.updatedRecently) labels.push(t("marketplace.health.updatedRecently"));
    if (plugin.health.hasTests) labels.push(t("marketplace.health.hasTests"));
    if (plugin.health.hasLicense) labels.push(t("marketplace.health.hasLicense"));
    return labels;
  }, [plugin.health, t]);

  let installLabel = t("marketplace.card.install");
  if (installStatus === "pending") installLabel = t("marketplace.card.installing");
  else if (installStatus === "installed") installLabel = t("marketplace.card.installed");
  else if (installStatus === "failed") installLabel = t("marketplace.card.retryInstall");
  const installVariant = installStatus === "installed" ? "outline" : "default";

  return (
    <Pressable style={styles.card} onPress={handleOpen}>
      <View style={styles.head}>
        <Text style={styles.name} numberOfLines={1}>
          {plugin.name}
        </Text>
        <Text style={styles.version}>{plugin.version ? `v${plugin.version}` : ""}</Text>
      </View>
      <Text style={styles.description} numberOfLines={2}>
        {plugin.description || t("marketplace.card.noDescription")}
      </Text>
      <View style={styles.metaRow}>
        <Text style={styles.author} numberOfLines={1}>
          {plugin.author ? t("marketplace.card.by", { author: plugin.author }) : plugin.repo}
        </Text>
        <View style={styles.metric}>
          <ThemedStar size={12} uniProps={mutedColor} />
          <Text style={styles.metricText}>{plugin.repoMeta.stars}</Text>
        </View>
        {downloads !== undefined ? (
          <View style={styles.metric}>
            <ThemedDownload size={12} uniProps={mutedColor} />
            <Text style={styles.metricText}>{formatDownloads(downloads)}</Text>
          </View>
        ) : null}
      </View>
      {chips.length > 0 ? (
        <View style={styles.chips}>
          {chips.map((category) => (
            <Text key={category} style={styles.chip}>
              {category}
            </Text>
          ))}
        </View>
      ) : null}
      {healthLabels.length > 0 ? (
        <View style={styles.health}>
          {healthLabels.map((label) => (
            <HealthBadge key={label} label={label} />
          ))}
        </View>
      ) : null}
      <View style={styles.footer}>
        <Button
          variant={installVariant}
          size="sm"
          onPress={handleInstall}
          loading={installStatus === "pending"}
          disabled={installStatus === "pending" || installStatus === "installed"}
          leftIcon={installStatus === "installed" ? Check : undefined}
        >
          {installLabel}
        </Button>
        <Button variant="outline" size="sm" onPress={handleOpen}>
          {t("marketplace.card.details")}
        </Button>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  head: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  name: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  version: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  description: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
    minHeight: 36,
  },
  metaRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  author: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  metric: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  metricText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  chip: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  health: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  healthBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  healthBadgeText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  footer: { flexDirection: "row", gap: theme.spacing[2], marginTop: theme.spacing[1] },
}));
