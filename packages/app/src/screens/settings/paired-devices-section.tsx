import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatTimeAgo } from "@/utils/time";
import { filterPairedDevices, sortPairedDevices, type PairedDevice } from "./paired-devices";

function usePairedDevices(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: ["paired-devices", serverId] as const,
    queryFn: async () => {
      if (!client) throw new Error("Host is offline");
      const result = await client.pairingDeviceList();
      return sortPairedDevices(result.devices);
    },
    enabled: Boolean(client && connected),
    dataShape: "list",
    staleTimeMs: 5_000,
  });
}

/**
 * Settings → Host → Pair device: every device paired with this host, with Revoke (spec 05 §5,
 * spec 15 §11.1). The device the app runs on is marked "This device".
 */
export function PairedDevicesSection({
  serverId,
  hostName,
}: {
  serverId: string;
  hostName: string;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const devices = usePairedDevices(serverId);
  const [query, setQuery] = useState("");
  const ownKey = client?.getDevicePublicKeyB64() ?? null;
  const visible = useMemo(
    () => filterPairedDevices(devices.data ?? [], query),
    [devices.data, query],
  );
  const revoke = useCallback(
    async (device: PairedDevice) => {
      if (!client) return;
      const name = device.deviceName ?? t("settings.host.pairedDevices.unnamed");
      const isSelf = ownKey !== null && device.devicePublicKeyB64 === ownKey;
      const confirmed = await confirmDialog({
        title: t("settings.host.pairedDevices.revokeTitle", { name }),
        message: isSelf
          ? t("settings.host.pairedDevices.revokeSelfMessage", { hostName })
          : t("settings.host.pairedDevices.revokeMessage"),
        confirmLabel: t("settings.host.pairedDevices.revoke"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) return;
      try {
        const result = await client.pairingDeviceRevoke(device.deviceId);
        if (!result.ok) throw new Error(result.error ?? "Revoke failed");
        await devices.refetch();
      } catch (error) {
        toast.error(
          t("settings.host.pairedDevices.revokeFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    },
    [client, devices, hostName, ownKey, t, toast],
  );

  const total = devices.data?.length ?? 0;
  return (
    <SettingsSection
      title={
        total > 0
          ? t("settings.host.pairedDevices.titleWithCount", { count: total })
          : t("settings.host.pairedDevices.title")
      }
    >
      {total > 5 ? (
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("settings.host.pairedDevices.search")}
            accessibilityLabel={t("settings.host.pairedDevices.search")}
            clearAccessibilityLabel={t("settings.host.pairedDevices.clearSearch")}
            testID="paired-devices-search"
          />
        </View>
      ) : null}
      <View style={settingsStyles.card} testID="paired-devices-list">
        {devices.isLoading ? (
          <View style={styles.message}>
            <Text style={styles.messageText}>{t("settings.host.pairedDevices.loading")}</Text>
          </View>
        ) : null}
        {devices.error ? (
          <View style={styles.message}>
            <Text style={styles.messageText}>
              {t("settings.host.pairedDevices.loadFailed", { message: devices.error.message })}
            </Text>
          </View>
        ) : null}
        {devices.data && total === 0 ? (
          <View style={styles.message} testID="paired-devices-empty">
            <Text style={styles.emptyTitle}>{t("settings.host.pairedDevices.emptyTitle")}</Text>
            <Text style={styles.messageText}>{t("settings.host.pairedDevices.emptyBody")}</Text>
          </View>
        ) : null}
        {devices.data && total > 0 && visible.length === 0 ? (
          <View style={styles.message}>
            <Text style={styles.messageText}>{t("settings.host.pairedDevices.noMatches")}</Text>
          </View>
        ) : null}
        {visible.map((device, index) => (
          <PairedDeviceRow
            key={device.deviceId}
            device={device}
            isFirst={index === 0}
            isSelf={ownKey !== null && device.devicePublicKeyB64 === ownKey}
            onRevoke={revoke}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

function PairedDeviceRow({
  device,
  isFirst,
  isSelf,
  onRevoke,
}: {
  device: PairedDevice;
  isFirst: boolean;
  isSelf: boolean;
  onRevoke: (device: PairedDevice) => void;
}): ReactElement {
  const { t } = useTranslation();
  const revoke = useCallback(() => onRevoke(device), [device, onRevoke]);
  const name = device.deviceName ?? t("settings.host.pairedDevices.unnamed");
  let kind: string | null = null;
  if (device.kind === "desktop") kind = t("settings.host.pairedDevices.kindDesktop");
  if (device.kind === "mobile") kind = t("settings.host.pairedDevices.kindMobile");
  if (device.kind === "daemon") kind = t("settings.host.pairedDevices.kindHost");
  const paired = t("settings.host.pairedDevices.pairedOn", {
    date: new Date(device.pairedAtMs).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
  });
  let activity: string | null = null;
  if (!device.connected && device.lastSeenMs !== undefined)
    activity = t("settings.host.pairedDevices.lastActive", {
      time: formatTimeAgo(new Date(device.lastSeenMs)),
    });
  return (
    <View
      style={isFirst ? settingsStyles.row : [settingsStyles.row, settingsStyles.rowBorder]}
      testID={`paired-device-${device.deviceId}`}
    >
      <View style={settingsStyles.rowContent}>
        <View style={styles.titleLine}>
          <Text style={[settingsStyles.rowTitle, styles.name]} numberOfLines={1}>
            {name}
          </Text>
          {kind ? <Chip label={kind} /> : null}
          {isSelf ? (
            <Chip label={t("settings.host.pairedDevices.thisDevice")} tone="accent" />
          ) : null}
          {device.connected ? (
            <Chip label={t("settings.host.pairedDevices.connected")} tone="success" />
          ) : null}
        </View>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {activity ? `${paired} · ${activity}` : paired}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        onPress={revoke}
        accessibilityLabel={t("settings.host.pairedDevices.revokeNamed", { name })}
        testID={`paired-device-revoke-${device.deviceId}`}
      >
        {t("settings.host.pairedDevices.revoke")}
      </Button>
    </View>
  );
}

function Chip({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "accent" | "success";
}): ReactElement {
  let textStyle = styles.chipText;
  if (tone === "accent") textStyle = styles.chipTextAccent;
  if (tone === "success") textStyle = styles.chipTextSuccess;
  return (
    <View style={styles.chip}>
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const chipBase = {
  height: 20,
  paddingHorizontal: 8,
  borderRadius: 10,
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
} as const;

const styles = StyleSheet.create((theme) => ({
  search: { marginBottom: theme.spacing[3] },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  name: { flexShrink: 1, minWidth: 0 },
  chip: { ...chipBase, backgroundColor: theme.colors.surface2 },
  chipText: { fontSize: 12, color: theme.colors.foregroundMuted },
  chipTextAccent: { fontSize: 12, fontWeight: "500", color: theme.colors.foreground },
  chipTextSuccess: { fontSize: 12, fontWeight: "500", color: theme.colors.palette.green[500] },
  // Messages sit inside the card, 16 px off every edge (spec 38 §4.4c).
  message: { padding: theme.spacing[4], gap: theme.spacing[1] },
  emptyTitle: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  messageText: { fontSize: 14, color: theme.colors.foregroundMuted },
}));
