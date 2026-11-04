import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { RefreshCw } from "lucide-react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient, SideloadApp } from "@jagentdesk/client/internal/daemon-client";
import { Alert } from "@/components/ui/alert";
import { MutationButton } from "./buttons";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  sideloadKey,
  unwrap,
  useSideloadAccounts,
  useSideloadApps,
  useSideloadDevices,
} from "./queries";
import { sideloadStyles as styles } from "./styles";

// 26.6 / 26.9 Installed apps, grouped by device: expiry countdown, auto refresh, and
// Refresh now / Remove from list / Uninstall; Refresh all per device.

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

export function countdown(expiresAt_ms: number, now: number): string {
  const remaining = expiresAt_ms - now;
  if (remaining <= 0) return "Expired";
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  if (days > 0) return `Expires in ${days}d ${hours}h`;
  if (hours > 0) return `Expires in ${hours}h ${minutes}m`;
  return `Expires in ${minutes}m`;
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function InstalledSection({ client, serverId }: { client: DaemonClient; serverId: string }) {
  const apps = useSideloadApps(client, serverId);
  const devices = useSideloadDevices(client, serverId);
  const accounts = useSideloadAccounts(client, serverId);
  const now = useMinuteClock();
  const groups = useMemo(() => {
    const byDevice = new Map<string, SideloadApp[]>();
    for (const app of apps.data ?? [])
      byDevice.set(app.deviceUdid, [...(byDevice.get(app.deviceUdid) ?? []), app]);
    return [...byDevice.entries()];
  }, [apps.data]);
  const deviceNames = useMemo(
    () => new Map((devices.data?.devices ?? []).map((device) => [device.id, device.name])),
    [devices.data],
  );
  const appleIds = useMemo(
    () => new Map((accounts.data ?? []).map((account) => [account.id, account.appleId])),
    [accounts.data],
  );

  return (
    <ScrollView contentContainerStyle={styles.section} testID="sideload-installed">
      <Text style={styles.sectionTitle}>Installed apps</Text>
      {apps.error ? (
        <Alert variant="error" title="Could not load apps" description={errorText(apps.error)} />
      ) : null}
      {apps.data && apps.data.length === 0 ? (
        <View style={styles.card}>
          <View style={styles.empty}>
            <Text style={styles.title}>Nothing sideloaded yet</Text>
            <Text style={styles.muted}>
              Apps you install from the Install tab show here with their expiry.
            </Text>
          </View>
        </View>
      ) : null}
      {groups.map(([udid, list]) => (
        <DeviceGroup
          key={udid}
          client={client}
          serverId={serverId}
          udid={udid}
          name={deviceNames.get(udid) ?? "iOS device"}
          connected={deviceNames.has(udid)}
          apps={list}
          appleIds={appleIds}
          now={now}
        />
      ))}
    </ScrollView>
  );
}

function DeviceGroup(props: {
  client: DaemonClient;
  serverId: string;
  udid: string;
  name: string;
  connected: boolean;
  apps: SideloadApp[];
  appleIds: Map<string, string>;
  now: number;
}) {
  const refreshAll = useMutation({
    mutationFn: async () =>
      unwrap(
        await props.client.sideloadCall("sideload.apps.refresh_all.request", {
          deviceUdid: props.udid,
        }),
      ),
  });
  return (
    <View style={styles.card} testID={`sideload-device-group-${props.udid}`}>
      <View style={styles.rowBetween}>
        <View style={styles.grow}>
          <Text style={styles.title}>{props.name}</Text>
          <Text style={styles.mono} numberOfLines={1}>
            {props.udid} · {props.connected ? "connected" : "not connected"}
          </Text>
        </View>
        <MutationButton
          size="sm"
          variant="outline"
          leftIcon={RefreshCw}
          mutation={refreshAll}
          variables={undefined}
        >
          Refresh all
        </MutationButton>
      </View>
      {refreshAll.error ? (
        <Text style={styles.errorText}>{errorText(refreshAll.error)}</Text>
      ) : null}
      {props.apps.map((app) => (
        <AppRow
          key={app.id}
          client={props.client}
          serverId={props.serverId}
          app={app}
          appleId={props.appleIds.get(app.accountId) ?? "removed account"}
          now={props.now}
        />
      ))}
    </View>
  );
}

function AppRow({
  client,
  serverId,
  app,
  appleId,
  now,
}: {
  client: DaemonClient;
  serverId: string;
  app: SideloadApp;
  appleId: string;
  now: number;
}) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: sideloadKey(serverId, "apps") });
  const refresh = useMutation({
    mutationFn: async () =>
      unwrap(await client.sideloadCall("sideload.apps.refresh.request", { appId: app.id })),
  });
  const forget = useMutation({
    mutationFn: async () =>
      unwrap(await client.sideloadCall("sideload.apps.forget.request", { appId: app.id })),
    onSuccess: invalidate,
  });
  const uninstall = useMutation({
    mutationFn: async () =>
      unwrap(await client.sideloadCall("sideload.apps.uninstall.request", { appId: app.id })),
    onSuccess: invalidate,
  });
  const expiring = app.expiresAt_ms - now < 2 * 86_400_000;
  const error = errorText(refresh.error ?? forget.error ?? uninstall.error);
  return (
    <View style={styles.field} testID={`sideload-app-${app.id}`}>
      <View style={styles.divider} />
      <View style={styles.rowBetween}>
        <View style={styles.grow}>
          <Text style={styles.text} numberOfLines={1}>
            {app.name} <Text style={styles.muted}>{app.version}</Text>
          </Text>
          <Text style={styles.mono} numberOfLines={1}>
            {app.bundleId} · {appleId}
          </Text>
        </View>
        <View style={styles.row}>
          <StatusBadge
            label={countdown(app.expiresAt_ms, now)}
            variant={expiring ? "error" : "muted"}
          />
          <StatusBadge
            label={app.autoRefresh ? "Auto refresh" : "Manual"}
            variant={app.autoRefresh ? "success" : "muted"}
          />
        </View>
      </View>
      {app.lastError ? (
        <Text style={styles.errorText}>Last refresh failed: {app.lastError}</Text>
      ) : null}
      <View style={styles.wrapRow}>
        <MutationButton size="sm" variant="outline" mutation={refresh} variables={undefined}>
          Refresh now
        </MutationButton>
        <MutationButton size="sm" variant="ghost" mutation={forget} variables={undefined}>
          Remove from list
        </MutationButton>
        <MutationButton size="sm" variant="ghost" mutation={uninstall} variables={undefined}>
          Uninstall
        </MutationButton>
      </View>
      {refresh.data?.jobId ? (
        <Text style={styles.muted}>Refreshing… progress shows in the Install tab log.</Text>
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}
