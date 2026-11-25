import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useToast } from "@/contexts/toast-api-context";
import { settingsStyles } from "@/styles/settings";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import {
  buildAcpProviderConfigPatch,
  type AcpProviderCatalogItem,
} from "@/hooks/use-acp-provider-catalog";
import { ProviderCatalogList } from "@/components/provider-catalog-list";
import { getProviderIcon } from "@/components/provider-icons";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { BuiltinClientItems } from "@/plugins/builtin/surfaces";
import { useProviderInstallation } from "@/components/provider-installation";
import { readRowSummary, rowHasSwitch, type RowSummary } from "@/components/provider-row-summary";
import { ChevronRight, MoreHorizontal, Trash2 } from "lucide-react-native";

type ProviderDefinition = ReturnType<typeof buildProviderDefinitions>[number];
type ProviderEntry = NonNullable<ReturnType<typeof useProvidersSnapshot>["entries"]>[number];

interface ProviderRowProps {
  serverId: string;
  def: ProviderDefinition;
  entry: ProviderEntry;
  enabled: boolean;
  isToggling: boolean;
  isRemoving: boolean;
  canRemove: boolean;
  isFirst: boolean;
  onPress: (providerId: string) => void;
  onToggleEnabled: (providerId: string, enabled: boolean) => void;
  onRemove: (providerId: string, providerLabel: string) => void;
}

function stopPressInPropagation(event: GestureResponderEvent) {
  event.stopPropagation();
}

interface ProviderActionsMenuProps {
  providerId: string;
  providerLabel: string;
  isRemoving: boolean;
  iconSize: number;
  foregroundColor: string;
  foregroundMutedColor: string;
  dangerColor: string;
  onRemove: (providerId: string, providerLabel: string) => void;
}

function ProviderActionsMenu({
  providerId,
  providerLabel,
  isRemoving,
  iconSize,
  foregroundColor,
  foregroundMutedColor,
  dangerColor,
  onRemove,
}: ProviderActionsMenuProps) {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => {
    onRemove(providerId, providerLabel);
  }, [onRemove, providerId, providerLabel]);
  const triggerStyle = useCallback(
    ({
      pressed,
      hovered,
      open,
    }: PressableStateCallbackType & { hovered?: boolean; open?: boolean }) => [
      styles.menuButton,
      (hovered || open) && styles.menuButtonHovered,
      pressed && styles.menuButtonPressed,
    ],
    [],
  );
  const trashLeading = useMemo(() => <Trash2 size={16} color={dangerColor} />, [dangerColor]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={isRemoving}
        hitSlop={8}
        onPressIn={stopPressInPropagation}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.providers.actions.menu", { name: providerLabel })}
        testID={`provider-actions-${providerId}`}
      >
        {({ hovered, open }) => (
          <MoreHorizontal
            size={iconSize}
            color={hovered || open ? foregroundColor : foregroundMutedColor}
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        <DropdownMenuItem
          destructive
          leading={trashLeading}
          onSelect={handleRemove}
          status={isRemoving ? "pending" : "idle"}
          pendingLabel={t("settings.providers.actions.removing")}
          testID={`provider-remove-${providerId}`}
        >
          {t("settings.providers.actions.remove")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderRow({
  serverId,
  def,
  entry,
  enabled,
  isToggling,
  isRemoving,
  canRemove,
  isFirst,
  onPress,
  onToggleEnabled,
  onRemove,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const ProviderIcon = getProviderIcon(def.id);
  const installation = useProviderInstallation({ serverId, provider: def.id, visible: true });
  const summary = readRowSummary(entry, installation);

  const handlePress = useCallback(() => {
    onPress(def.id);
  }, [def.id, onPress]);
  const handleToggleValueChange = useCallback(
    (value: boolean) => {
      onToggleEnabled(def.id, value);
    },
    [def.id, onToggleEnabled],
  );
  return (
    <View
      style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder, styles.row]}
      testID={`provider-row-${def.id}`}
    >
      <Pressable
        style={styles.rowPressTarget}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={t("settings.providers.providerDetails", { name: def.label })}
      />
      <View style={styles.rowContent} pointerEvents="none">
        <ProviderIcon size={theme.iconSize.md} color={theme.colors.foreground} />
        <View style={styles.textColumn}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {def.label}
          </Text>
          <StatusIndicator summary={summary} />
        </View>
      </View>
      <View style={styles.trailingControls}>
        {rowHasSwitch(summary) ? (
          <Switch
            value={enabled}
            onValueChange={handleToggleValueChange}
            disabled={isToggling || isRemoving}
            accessibilityLabel={t("settings.providers.enableProvider", { name: def.label })}
          />
        ) : null}
        <View style={styles.menuSlot}>
          {canRemove ? (
            <ProviderActionsMenu
              providerId={def.id}
              providerLabel={def.label}
              isRemoving={isRemoving}
              iconSize={theme.iconSize.sm}
              foregroundColor={theme.colors.foreground}
              foregroundMutedColor={theme.colors.foregroundMuted}
              dangerColor={theme.colors.statusDanger}
              onRemove={onRemove}
            />
          ) : null}
        </View>
        <ChevronRight
          size={theme.iconSize.sm}
          color={theme.colors.foregroundMuted}
          pointerEvents="none"
        />
      </View>
    </View>
  );
}

function StatusIndicator({ summary }: { summary: RowSummary }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  let text: string;
  switch (summary.kind) {
    case "pending":
      text = t("settings.providers.statuses.loading");
      break;
    case "ready": {
      const models =
        summary.models === 1
          ? t("settings.providers.models.one")
          : t("settings.providers.models.many", { count: summary.models });
      text =
        [summary.version, summary.models > 0 ? models : null].filter(Boolean).join(" · ") ||
        t("settings.providers.statuses.available");
      break;
    }
    case "updateAvailable":
      text = [summary.version, t("settings.providers.installation.updateAvailable")]
        .filter(Boolean)
        .join(" · ");
      break;
    case "updating":
      text = t("settings.providers.installation.updating");
      break;
    case "failing":
      text = summary.message ?? t("settings.providers.diagnostic.unknownError");
      break;
    case "notInstalled":
      text = t("settings.providers.statuses.notInstalled");
      break;
    case "disabled":
      text = t("settings.providers.statuses.disabled");
      break;
  }
  return (
    <View style={styles.statusRow}>
      {summary.kind === "pending" || summary.kind === "updating" ? (
        <LoadingSpinner size={10} color={theme.colors.foregroundMuted} />
      ) : null}
      {summary.kind === "failing" ? <View style={styles.errorDot} /> : null}
      <Text style={styles.statusLabel} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

export interface ProvidersSectionProps {
  serverId: string;
}

export function ProvidersSection({ serverId }: ProvidersSectionProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsProviderRemoval = useHostFeature(serverId, "providerRemoval");
  const { entries, isLoading, refresh } = useProvidersSnapshot(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const openProviderSettings = useProviderSettingsStore((state) => state.open);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [removingProviderId, setRemovingProviderId] = useState<string | null>(null);
  const removingProviderIdRef = useRef<string | null>(null);
  const [installingProviderId, setInstallingProviderId] = useState<string | null>(null);

  const providerDefinitions = useMemo(() => buildProviderDefinitions(entries), [entries]);
  const hasServer = serverId.length > 0;

  /** Custom providers are deletable only when config.json holds their `extends` definition. */
  const isConfigOwnedProvider = useCallback(
    (providerId: string) => Boolean(config?.providers?.[providerId]?.extends),
    [config],
  );

  const handleOpenProviderSettings = useCallback(
    (providerId: string) => {
      openProviderSettings({ serverId, provider: providerId });
    },
    [openProviderSettings, serverId],
  );

  const handleToggleEnabled = useCallback(
    async (providerId: string, enabled: boolean) => {
      setPendingProviderId(providerId);
      try {
        await patchConfig({ providers: { [providerId]: { enabled } } });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setPendingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [patchConfig, toast],
  );

  const handleRemoveProvider = useCallback(
    async (providerId: string, providerLabel: string) => {
      if (removingProviderIdRef.current) return;
      removingProviderIdRef.current = providerId;
      setRemovingProviderId(providerId);
      try {
        const confirmed = await confirmDialog({
          title: t("settings.providers.remove.confirmTitle", { name: providerLabel }),
          message: t("settings.providers.remove.confirmMessage"),
          confirmLabel: t("settings.providers.remove.confirm"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }

        await patchConfig({ removeProviders: [providerId] });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        if (removingProviderIdRef.current === providerId) {
          removingProviderIdRef.current = null;
        }
        setRemovingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [patchConfig, t, toast],
  );

  const handleInstall = useCallback(
    async (entry: AcpProviderCatalogItem) => {
      if (installingProviderId) return;
      setInstallingProviderId(entry.id);
      try {
        await patchConfig(buildAcpProviderConfigPatch(entry));
        await refresh([entry.id]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setInstallingProviderId((current) => (current === entry.id ? null : current));
      }
    },
    [installingProviderId, patchConfig, refresh, toast],
  );

  return (
    <>
      <SettingsSection
        title={t("settings.providers.title")}
        testID="host-page-providers-card"
        style={styles.sectionSpacing}
      >
        {!hasServer || !isConnected ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>{t("settings.providers.unavailable")}</Text>
          </View>
        ) : null}
        {hasServer && isConnected && isLoading ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>{t("settings.providers.loading")}</Text>
          </View>
        ) : null}
        {hasServer && isConnected && !isLoading && providerDefinitions.length > 0 ? (
          <View style={settingsStyles.card}>
            {providerDefinitions.map((def, index) => {
              const entry = entries?.find((candidate) => candidate.provider === def.id);
              if (!entry) return null;
              return (
                <ProviderRow
                  key={def.id}
                  serverId={serverId}
                  def={def}
                  entry={entry}
                  enabled={entry.enabled ?? true}
                  isToggling={pendingProviderId === def.id}
                  isRemoving={removingProviderId === def.id}
                  canRemove={
                    supportsProviderRemoval &&
                    entry.source === "custom" &&
                    isConfigOwnedProvider(def.id)
                  }
                  isFirst={index === 0}
                  onPress={handleOpenProviderSettings}
                  onToggleEnabled={handleToggleEnabled}
                  onRemove={handleRemoveProvider}
                />
              );
            })}
          </View>
        ) : null}
      </SettingsSection>

      {hasServer && isConnected ? (
        <BuiltinClientItems serverId={serverId} kind="providerSettings" />
      ) : null}

      {hasServer && isConnected ? (
        <SettingsSection
          title={t("settings.providers.addProvider")}
          testID="host-page-add-provider-card"
          style={styles.addProviderSection}
        >
          <ProviderCatalogList
            serverId={serverId}
            installingProviderId={installingProviderId}
            onInstall={handleInstall}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionSpacing: {
    marginBottom: theme.spacing[4],
  },
  addProviderSection: {
    marginTop: theme.spacing[4],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  row: {
    gap: theme.spacing[3],
    minHeight: 56,
  },
  rowPressTarget: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  errorDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.statusDanger },
  rowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  separator: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  trailingControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  menuButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  menuSlot: {
    width: 32,
    height: 32,
  },
  menuButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  menuButtonPressed: {
    backgroundColor: theme.colors.surface3,
  },
}));
