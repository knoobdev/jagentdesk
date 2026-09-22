import { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { Check, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { npmDownloads, type MarketplacePlugin } from "@/marketplace/catalog";
import type { MarketplaceInstallStatus } from "@/marketplace/marketplace-card";

const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const successColor = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const IMAGE_TRANSITION_MS = 120;

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
  const header = useMemo<SheetHeader>(
    () => ({ title: plugin.name, back: { onPress: onClose } }),
    [plugin.name, onClose],
  );

  let installLabel = t("marketplace.detail.install");
  if (installStatus === "pending") installLabel = t("marketplace.card.installing");
  else if (installStatus === "installed") installLabel = t("marketplace.card.installed");
  else if (installStatus === "failed") installLabel = t("marketplace.card.retryInstall");

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="marketplace-detail-sheet">
      <ScrollView contentContainerStyle={styles.body}>
        {plugin.images.length > 0 ? (
          <ScrollView
            horizontal
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
          <MetaRow label={t("marketplace.detail.stars")} value={String(plugin.repoMeta.stars)} />
          {downloads !== undefined ? (
            <MetaRow label={t("marketplace.detail.downloads")} value={String(downloads)} />
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

        {plugin.categories.length > 0 ? (
          <View style={styles.chips}>
            {plugin.categories.map((category) => (
              <Text key={category} style={styles.chip}>
                {category}
              </Text>
            ))}
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>{t("marketplace.detail.health")}</Text>
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

        {description ? (
          <>
            <Text style={styles.sectionTitle}>{t("marketplace.detail.description")}</Text>
            <Text style={styles.description}>{description}</Text>
          </>
        ) : null}

        {plugin.caveats ? (
          <Alert
            variant="warning"
            title={t("marketplace.detail.caveats")}
            description={plugin.caveats}
          />
        ) : null}

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
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[6] },
  gallery: { gap: theme.spacing[2] },
  screenshot: {
    width: 280,
    height: 168,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
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
  description: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, lineHeight: 20 },
  installRow: { flexDirection: "row", marginTop: theme.spacing[2] },
}));
