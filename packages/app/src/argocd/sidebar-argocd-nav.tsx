import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft, Search, Ship } from "lucide-react-native";
import { router, useGlobalSearchParams } from "expo-router";
import type { ArgoCdAppSummary, ArgoCdInstance } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import {
  buildArgoCdAppRoute,
  buildArgoCdInstanceRoute,
  buildArgoCdRoute,
} from "@/utils/host-routes";
import { appKey, EMPTY_APP_FILTERS, filterApps } from "./app-list";
import { InstanceStateDot } from "./instances-screen";
import { ArgoCdToneDot, healthTone, syncTone } from "./status";
import { useArgoCdApps } from "./use-apps";
import { isSignedIn, useArgoCdInstances } from "./use-instances";

// The left column while an Argo CD route is open (spec 30.3), like the Servers section's: the
// instances with their sign-in dot, and under the instance in the route its applications with
// health and sync dots and a search box. Shares the Applications screen's apps feed.

const ThemedSearch = withUnistyles(Search);
const ThemedShip = withUnistyles(Ship);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedTextInput = withUnistyles(TextInput);
const mutedTint = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const placeholderTint = (theme: Theme) => ({ placeholderTextColor: theme.colors.foregroundMuted });

function firstParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first ?? null;
}

const InstanceRow = memo(function InstanceRow({
  serverId,
  instance,
  active,
}: {
  serverId: string;
  instance: ArgoCdInstance;
  active: boolean;
}) {
  const handlePress = useCallback(
    () => router.push(buildArgoCdInstanceRoute(serverId, instance.id)),
    [instance.id, serverId],
  );
  return (
    <Pressable
      style={active ? styles.rowActive : styles.row}
      onPress={handlePress}
      accessibilityRole="button"
      testID={`sidebar-argocd-instance-${instance.id}`}
    >
      <InstanceStateDot state={instance.state} />
      <Text style={styles.rowLabel} numberOfLines={1}>
        {instance.displayName || instance.url}
      </Text>
    </Pressable>
  );
});

const AppRow = memo(function AppRow({
  serverId,
  instanceId,
  app,
  active,
}: {
  serverId: string;
  instanceId: string;
  app: ArgoCdAppSummary;
  active: boolean;
}) {
  const handlePress = useCallback(
    () =>
      router.push(
        buildArgoCdAppRoute(serverId, instanceId, {
          name: app.name,
          appNamespace: app.appNamespace,
        }),
      ),
    [app.appNamespace, app.name, instanceId, serverId],
  );
  return (
    <Pressable
      style={active ? styles.appRowActive : styles.appRow}
      onPress={handlePress}
      accessibilityRole="button"
      testID={`sidebar-argocd-app-${app.name}`}
    >
      <View style={styles.dots}>
        <ArgoCdToneDot tone={healthTone(app.health)} label={app.health} />
        <ArgoCdToneDot tone={syncTone(app.sync)} label={app.sync} />
      </View>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {app.name}
      </Text>
    </Pressable>
  );
});

function InstanceApps({
  serverId,
  instance,
  query,
  activeApp,
}: {
  serverId: string;
  instance: ArgoCdInstance;
  query: string;
  activeApp: string | null;
}) {
  const hostConnected = useHostRuntimeIsConnected(serverId);
  const { client } = useArgoCdInstances(serverId);
  const signedIn = isSignedIn(instance);
  const { state } = useArgoCdApps({
    client,
    instanceId: instance.id,
    enabled: hostConnected && signedIn,
  });
  const apps = useMemo(
    () =>
      state.status === "loaded" ? filterApps(state.apps, { ...EMPTY_APP_FILTERS, query }) : [],
    [query, state],
  );

  if (!signedIn) return <Text style={styles.note}>Sign in to see applications</Text>;
  if (state.status === "loading") return <Text style={styles.note}>Loading...</Text>;
  if (state.status === "error") return <Text style={styles.noteError}>{state.error}</Text>;
  if (apps.length === 0) {
    return (
      <Text style={styles.note}>{query ? "No matching applications" : "No applications"}</Text>
    );
  }
  return (
    <>
      {apps.map((app) => (
        <AppRow
          key={appKey(app)}
          serverId={serverId}
          instanceId={instance.id}
          app={app}
          active={app.name === activeApp}
        />
      ))}
    </>
  );
}

export function SidebarArgoCdNav({
  serverId,
  instanceId,
}: {
  serverId: string;
  instanceId: string | null;
}) {
  const { state } = useArgoCdInstances(serverId);
  const params = useGlobalSearchParams<{ name?: string | string[] }>();
  const activeApp = firstParam(params.name);
  const [query, setQuery] = useState("");
  const instances = state.status === "loaded" ? state.instances : [];

  const showAll = useCallback(() => router.push(buildArgoCdRoute(serverId)), [serverId]);
  // The section owns the column, so leaving it is explicit (like the Servers nav).
  const leave = useCallback(() => router.push("/"), []);

  return (
    <View style={styles.root} testID="sidebar-argocd-nav-panel">
      <View style={styles.header}>
        <Pressable
          style={styles.back}
          onPress={leave}
          accessibilityRole="button"
          accessibilityLabel="Leave Argo CD"
          testID="sidebar-argocd-leave"
        >
          <ThemedChevronLeft size={16} uniProps={mutedTint} />
        </Pressable>
        <Pressable
          style={styles.headerTitleRow}
          onPress={showAll}
          accessibilityRole="button"
          accessibilityLabel="All Argo CD instances"
        >
          <ThemedShip size={14} uniProps={mutedTint} />
          <Text style={styles.headerTitle}>Argo CD</Text>
        </Pressable>
      </View>
      {instanceId ? (
        <View style={styles.search}>
          <ThemedSearch size={13} uniProps={mutedTint} />
          <ThemedTextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search applications"
            uniProps={placeholderTint}
            autoCapitalize="none"
            autoCorrect={false}
            testID="sidebar-argocd-search"
          />
        </View>
      ) : null}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.sectionLabel}>Instances</Text>
        {instances.map((instance) => (
          <View key={instance.id}>
            <InstanceRow
              serverId={serverId}
              instance={instance}
              active={instance.id === instanceId && !activeApp}
            />
            {instance.id === instanceId ? (
              <InstanceApps
                serverId={serverId}
                instance={instance}
                query={query}
                activeApp={activeApp}
              />
            ) : null}
          </View>
        ))}
        {state.status === "loaded" && instances.length === 0 ? (
          <Text style={styles.note}>No instances yet</Text>
        ) : null}
        {state.status === "error" ? <Text style={styles.noteError}>{state.error}</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  back: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  headerTitleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  headerTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    height: 30,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  searchInput: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingBottom: theme.spacing[3] },
  sectionLabel: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    marginHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  rowActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    marginHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surfaceSidebarHover ?? theme.colors.surface2,
  },
  // Apps indent past the instance dot so their dots sit under the instance name.
  appRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3] + theme.spacing[4],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    marginHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  appRowActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3] + theme.spacing[4],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    marginHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surfaceSidebarHover ?? theme.colors.surface2,
  },
  dots: { flexDirection: "row", alignItems: "center", gap: 3 },
  rowLabel: { flex: 1, minWidth: 0, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  note: {
    paddingLeft: theme.spacing[1.5] + theme.spacing[3] + theme.spacing[4],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  noteError: {
    paddingLeft: theme.spacing[1.5] + theme.spacing[3] + theme.spacing[4],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
}));
