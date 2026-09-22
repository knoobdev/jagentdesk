import { useCallback, useMemo, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { Check, Download, Package, Star, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { npmDownloads, type MarketplacePlugin } from "@/marketplace/catalog";
import type { MarketplaceInstallStatus } from "@/marketplace/marketplace-card";

const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const ThemedPackage = withUnistyles(Package);
const ThemedStar = withUnistyles(Star);
const ThemedDownload = withUnistyles(Download);
const successColor = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentIconColor = (theme: Theme) => ({ color: theme.colors.foreground });

const IMAGE_TRANSITION_MS = 120;

function formatDownloads(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return String(value);
}

interface MetaRowProps {
  label: string;
  value: string;
}

function MetaRow({ label, value }: MetaRowProps) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

interface HealthLineProps {
  label: string;
  ok: boolean;
}

function HealthLine({ label, ok }: HealthLineProps) {
  return (
    <View style={styles.healthLine}>
      {ok ? (
        <ThemedCheck size={14} uniProps={successColor} />
      ) : (
        <ThemedX size={14} uniProps={mutedColor} />
      )}
      <Text style={ok ? styles.healthOk : styles.healthOff}>{label}</Text>
    </View>
  );
}

interface StatPillProps {
  icon: ReactNode;
  value: string;
}

function StatPill({ icon, value }: StatPillProps) {
  return (
    <View style={styles.statPill}>
      {icon}
      <Text style={styles.statPillText}>{value}</Text>
    </View>
  );
}

const starPillIcon = <ThemedStar size={13} uniProps={mutedColor} />;
const downloadPillIcon = <ThemedDownload size={13} uniProps={mutedColor} />;

type Translate = ReturnType<typeof useTranslation>["t"];

function resolveInstallLabel(t: Translate, status: MarketplaceInstallStatus): string {
  if (status === "pending") return t("marketplace.card.installing");
  if (status === "installed") return t("marketplace.card.installed");
  if (status === "failed") return t("marketplace.card.retryInstall");
  return t("marketplace.detail.install");
}

function PluginMetaCard({ plugin, t }: { plugin: MarketplacePlugin; t: Translate }) {
  return (
    <View style={styles.metaCard}>
      {plugin.author ? (
        <MetaRow label={t("marketplace.detail.author")} value={plugin.author} />
      ) : null}
      {plugin.version ? (
        <MetaRow label={t("marketplace.detail.version")} value={plugin.version} />
      ) : null}
      {plugin.license ? (
        <MetaRow label={t("marketplace.detail.license")} value={plugin.license} />
      ) : null}
      {plugin.package ? (
        <MetaRow label={t("marketplace.detail.npmPackage")} value={plugin.package} />
      ) : null}
      <MetaRow label={t("marketplace.detail.repository")} value={plugin.repo || plugin.url} />
      {plugin.paseoVersionRequirement ? (
        <MetaRow
          label={t("marketplace.detail.requirement")}
          value={plugin.paseoVersionRequirement}
        />
      ) : null}
    </View>
  );
}

function PluginHealthSection({ plugin, t }: { plugin: MarketplacePlugin; t: Translate }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t("marketplace.detail.health")}</Text>
      <View style={styles.divider} />
      <View style={styles.healthGrid}>
        <HealthLine
          label={t("marketplace.health.manifestValid")}
          ok={plugin.health.manifestValid}
        />
        <HealthLine label={t("marketplace.health.hasReadme")} ok={plugin.health.hasReadme} />
        <HealthLine label={t("marketplace.health.hasLicense")} ok={plugin.health.hasLicense} />
        <HealthLine label={t("marketplace.health.hasTests")} ok={plugin.health.hasTests} />
        <HealthLine
          label={t("marketplace.health.hasTypecheck")}
          ok={plugin.health.hasTypecheckScript}
        />
        <HealthLine
          label={t("marketplace.health.updatedRecently")}
          ok={plugin.health.updatedRecently}
        />
      </View>
    </View>
  );
}

interface MarketplaceDetailProps {
  plugin: MarketplacePlugin;
  installStatus: MarketplaceInstallStatus;
  onClose: () => void;
  onInstall: (plugin: MarketplacePlugin) => void;
}

export function MarketplaceDetail({
  plugin,
  installStatus,
  onClose,
  onInstall,
}: MarketplaceDetailProps) {
  const { t } = useTranslation();
  const handleInstall = useCallback(() => onInstall(plugin), [onInstall, plugin]);
  const downloads = npmDownloads(plugin);
  const description = plugin.readmeText || plugin.description;
  const authorLine = plugin.author
    ? t("marketplace.card.by", { author: plugin.author })
    : plugin.repo;
  const header = useMemo<SheetHeader>(
    () => ({ title: plugin.name, back: { onPress: onClose } }),
    [plugin.name, onClose],
  );

  const installLabel = resolveInstallLabel(t, installStatus);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      testID="marketplace-detail-sheet"
      contentStyle={styles.body}
    >
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <ThemedPackage size={22} uniProps={accentIconColor} />
        </View>
        <View style={styles.heroText}>
          <Text style={styles.heroName} numberOfLines={2}>
            {plugin.name}
          </Text>
          <Text style={styles.heroAuthor} numberOfLines={1}>
            {authorLine}
          </Text>
        </View>
      </View>

      <View style={styles.statRow}>
        <StatPill icon={starPillIcon} value={String(plugin.repoMeta.stars)} />
        {downloads !== undefined ? (
          <StatPill icon={downloadPillIcon} value={formatDownloads(downloads)} />
        ) : null}
        {plugin.version ? (
          <View style={styles.versionPill}>
            <Text style={styles.versionPillText}>v{plugin.version}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.installRow}>
        <Button
          variant={installStatus === "installed" ? "outline" : "default"}
          onPress={handleInstall}
          loading={installStatus === "pending"}
          disabled={installStatus === "pending" || installStatus === "installed"}
          leftIcon={installStatus === "installed" ? Check : undefined}
        >
          {installLabel}
        </Button>
      </View>

      {plugin.images.length > 0 ? (
        <ScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.gallery}
        >
          {plugin.images.map((image) => (
            <ExpoImage
              key={image}
              source={image}
              contentFit="cover"
              transition={IMAGE_TRANSITION_MS}
              style={styles.screenshot}
            />
          ))}
        </ScrollView>
      ) : null}

      {plugin.categories.length > 0 ? (
        <View style={styles.chips}>
          {plugin.categories.map((category) => (
            <Text key={category} style={styles.chip}>
              {category}
            </Text>
          ))}
        </View>
      ) : null}

      {description ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("marketplace.detail.description")}</Text>
          <View style={styles.divider} />
          <MarkdownRenderer text={description} />
        </View>
      ) : null}

      <PluginHealthSection plugin={plugin} t={t} />

      <PluginMetaCard plugin={plugin} t={t} />

      {plugin.caveats ? (
        <Alert
          variant="warning"
          title={t("marketplace.detail.caveats")}
          description={plugin.caveats}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[4], paddingBottom: theme.spacing[6] },
  hero: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  heroText: { flex: 1, minWidth: 0, gap: 2 },
  heroName: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  heroAuthor: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  statRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  statPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  statPillText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  versionPill: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  versionPillText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  gallery: { gap: theme.spacing[2] },
  screenshot: {
    width: 280,
    height: 168,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  section: { gap: theme.spacing[2] },
  divider: { height: theme.borderWidth[1], backgroundColor: theme.colors.border },
  metaCard: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  metaRow: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[3] },
  metaLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  metaValue: {
    flex: 1,
    textAlign: "right",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  chip: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  healthGrid: { gap: theme.spacing[1.5] },
  healthLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  healthOk: { fontSize: theme.fontSize.xs, color: theme.colors.foreground },
  healthOff: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  installRow: { flexDirection: "row" },
}));
