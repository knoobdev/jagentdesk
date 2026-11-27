import { ChevronRight, Server } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HostStatusDot } from "@/components/host-status-dot";
import { SettingsAddRow, SettingsCard, SettingsSection } from "@/components/settings";
import type { EnableBuiltInDaemonOption } from "@/desktop/hooks/use-enable-built-in-daemon-option";
import { useIsLocalDaemon, useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { resolveHostIcon } from "@/hosts/appearance";
import { describeActiveConnection, describeHostConnection } from "@/hosts/connection-display";
import { HostIconGlyph } from "@/hosts/host-icon-glyph";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { HostAppearanceSection } from "@/screens/settings/host-appearance-section";
import {
  ConnectionsSection,
  HostConnectionError,
  RemoveHostSection,
} from "@/screens/settings/host-page";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { orderHostsLocalFirst, type HostProfile } from "@/types/host-connection";
import { formatLatency } from "@/utils/latency";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedServer = withUnistyles(Server);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function formatDaemonVersion(version: string | null): string | undefined {
  const trimmed = version?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function rowStyle({ pressed }: { pressed: boolean }) {
  return [settingsStyles.row, styles.rowGap, pressed && styles.rowPressed];
}

function ClientHostListRow({
  host,
  isLocalHost,
  hosts,
  onSelectHost,
}: {
  host: HostProfile;
  isLocalHost: boolean;
  hosts: readonly HostProfile[];
  onSelectHost: (serverId: string) => void;
}) {
  const { t } = useTranslation();
  const snapshot = useHostRuntimeSnapshot(host.serverId);
  const serverInfo = useSessionStore((state) => state.sessions[host.serverId]?.serverInfo);
  const detectedMachineKind = serverInfo?.machineKind ?? null;
  const resolvedIcon = resolveHostIcon({ appearance: host.appearance, detectedMachineKind });

  const handleOpen = useCallback(() => {
    onSelectHost(host.serverId);
  }, [host.serverId, onSelectHost]);

  const status = snapshot?.connectionStatus;
  const activeConnection = snapshot?.activeConnection ?? null;
  const activeConnectionId = snapshot?.activeConnectionId;
  const activeProbe = activeConnectionId
    ? snapshot?.probeByConnectionId.get(activeConnectionId)
    : undefined;
  const latencyMs =
    status === "online" && activeProbe?.status === "available" ? activeProbe.latencyMs : null;

  const fallbackConnection = useMemo(() => {
    if (activeConnection || host.connections.length === 0) return null;
    if (host.preferredConnectionId) {
      const preferred = host.connections.find((c) => c.id === host.preferredConnectionId);
      if (preferred) return preferred;
    }
    return host.connections[0] ?? null;
  }, [activeConnection, host.connections, host.preferredConnectionId]);

  const hint = useMemo(() => {
    let described: ReturnType<typeof describeHostConnection> | null = null;
    if (activeConnection) {
      described = describeActiveConnection(activeConnection, { isLocalHost });
    } else if (fallbackConnection) {
      described = describeHostConnection(fallbackConnection, { isLocalHost });
    }
    const parts: string[] = [];
    if (described) {
      parts.push(t(`settings.host.connectionKinds.${described.kind}`));
      if (described.endpoint) {
        const endpoint =
          described.kind === "routed"
            ? (hosts.find((candidate) => candidate.serverId === described.endpoint)?.label ??
              described.endpoint)
            : described.endpoint;
        parts.push(endpoint);
      }
    }
    if (latencyMs !== null) {
      parts.push(formatLatency(latencyMs));
    }
    return parts.join(" · ") || undefined;
  }, [activeConnection, fallbackConnection, hosts, isLocalHost, latencyMs, t]);

  let summary: string | undefined;
  if (status === "online") {
    summary = formatDaemonVersion(serverInfo?.version ?? null);
  } else if (status === "offline" || status === "error") {
    summary = t("settings.clientHosts.offline");
  }

  return (
    <Pressable
      onPress={handleOpen}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={summary ? `${host.label}, ${summary}` : host.label}
      testID={`client-host-row-${host.serverId}`}
    >
      <View style={styles.leading}>
        <HostStatusDot serverId={host.serverId} />
        <HostIconGlyph icon={resolvedIcon} color={host.appearance.color} size={ICON_SIZE.md} />
      </View>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {host.label}
        </Text>
        {hint ? (
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {hint}
          </Text>
        ) : null}
      </View>
      <View style={styles.trailing}>
        {summary ? <Text style={styles.summary}>{summary}</Text> : null}
        <ThemedChevronRight size={14} uniProps={mutedColorMapping} />
      </View>
    </Pressable>
  );
}

/** Settings -> Hosts: the hosts this device has saved, and adding another. */
export function ClientHostsSection({
  onSelectHost,
  onAddHost,
  enableBuiltInDaemonOption,
}: {
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  enableBuiltInDaemonOption: EnableBuiltInDaemonOption;
}) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );

  return (
    <SettingsSection
      title={t("settings.clientHosts.title")}
      info={t("settings.clientHosts.info")}
      testID="client-hosts-section"
    >
      <SettingsCard testID="client-hosts-card">
        {sortedHosts.map((host) => (
          <ClientHostListRow
            key={host.serverId}
            host={host}
            isLocalHost={host.serverId === localServerId}
            hosts={sortedHosts}
            onSelectHost={onSelectHost}
          />
        ))}
        <SettingsAddRow
          label={t("settings.addHost")}
          onPress={onAddHost}
          testID="client-hosts-add-row"
        />
        {enableBuiltInDaemonOption.visible ? (
          <Pressable
            onPress={enableBuiltInDaemonOption.onPress}
            style={rowStyle}
            accessibilityRole="button"
            accessibilityLabel={t("settings.enableBuiltInDaemon")}
            testID="client-hosts-enable-built-in-daemon"
          >
            <ThemedServer size={ICON_SIZE.md} uniProps={mutedColorMapping} />
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.enableBuiltInDaemon")}</Text>
            </View>
          </Pressable>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * This device's page for one saved host: how it reaches the host, how the host looks in this
 * device's sidebar, and removing it from this device. The host's own settings stay under Host.
 */
export function ClientHostDetailPage({
  serverId,
  onAddConnection,
  onHostRemoved,
}: {
  serverId: string;
  onAddConnection: () => void;
  onHostRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const host = hosts.find((entry) => entry.serverId === serverId) ?? null;
  const isLocalDaemon = useIsLocalDaemon(serverId);

  if (!host) {
    return (
      <View testID="client-host-detail-page">
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={styles.emptyText}>{t("settings.host.notFound")}</Text>
        </View>
      </View>
    );
  }

  return (
    <View testID="client-host-detail-page">
      <HostConnectionError serverId={serverId} />
      <ConnectionsSection host={host} onAddConnection={onAddConnection} />
      <HostAppearanceSection host={host} />
      <RemoveHostSection host={host} isLocalDaemon={isLocalDaemon} onRemoved={onHostRemoved} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  leading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // The leading status dot and host icon sit apart from the label, like the add row's plus.
  rowGap: {
    gap: theme.spacing[3],
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
