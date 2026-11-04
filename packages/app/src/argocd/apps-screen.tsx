import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { Ship, Sparkles } from "lucide-react-native";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ArgoCdInstance } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { PageHeader } from "@/components/headers/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { buildArgoCdRoute } from "@/utils/host-routes";
import { ArgoCdAppsView } from "./apps-view";
import { useArgoCdAskAi } from "./ask-ai";
import { instanceStateLabel, InstanceStateDot } from "./instances-screen";
import { ArgoCdSettingsList, type ArgoCdSettingsKind } from "./settings-lists";
import { ArgoCdSignIn } from "./sign-in";
import { useArgoCdApps } from "./use-apps";
import { isSignedIn, useArgoCdInstances } from "./use-instances";

// One Argo CD instance (spec 30.3): its applications, plus the read-only ApplicationSets,
// Projects, Repositories and Clusters. Signed out → the sign-in form takes the list's place.

type Tab = "apps" | ArgoCdSettingsKind;

const TAB_OPTIONS: SegmentedControlOption<Tab>[] = [
  { value: "apps", label: "Applications", testID: "argocd-tab-apps" },
  { value: "appsets", label: "ApplicationSets", testID: "argocd-tab-appsets" },
  { value: "projects", label: "Projects", testID: "argocd-tab-projects" },
  { value: "repos", label: "Repositories", testID: "argocd-tab-repos" },
  { value: "clusters", label: "Clusters", testID: "argocd-tab-clusters" },
];

function needsSignIn(instance: ArgoCdInstance): boolean {
  return !isSignedIn(instance);
}

export function ArgoCdAppsScreen({
  serverId,
  instanceId,
}: {
  serverId: string;
  instanceId: string;
}) {
  const router = useRouter();
  const isCompact = useIsCompactFormFactor();
  const hostConnected = useHostRuntimeIsConnected(serverId);
  const { client, state, upsert } = useArgoCdInstances(serverId);
  const [tab, setTab] = useState<Tab>("apps");
  const askAi = useArgoCdAskAi(serverId);

  const instance =
    state.status === "loaded"
      ? (state.instances.find((entry) => entry.id === instanceId) ?? null)
      : null;
  const signedIn = Boolean(instance && !needsSignIn(instance));
  const apps = useArgoCdApps({ client, instanceId, enabled: hostConnected && signedIn });

  const goToInstances = useCallback(() => {
    router.push(buildArgoCdRoute(serverId));
  }, [router, serverId]);
  const handleAskAi = useCallback(
    () => askAi({ instanceId, app: null, resource: null }),
    [askAi, instanceId],
  );

  const headerActions = useMemo(
    () => (
      <View style={styles.headerActions}>
        {signedIn ? (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={Sparkles}
            onPress={handleAskAi}
            testID="argocd-apps-ask-ai"
          >
            Ask AI
          </Button>
        ) : null}
        {isCompact ? null : (
          <Button size="sm" variant="outline" onPress={goToInstances}>
            Instances
          </Button>
        )}
      </View>
    ),
    [goToInstances, handleAskAi, isCompact, signedIn],
  );

  if (state.status !== "loaded" || !client) {
    if (state.status === "error") {
      return (
        <View style={styles.page}>
          <PageHeader icon={Ship} title="Argo CD" description="Applications" />
          <View style={styles.padded}>
            <Alert
              variant="error"
              title="Unable to load Argo CD instances"
              description={state.error}
            />
          </View>
        </View>
      );
    }
    return (
      <View style={styles.center}>
        <ThemedSpinner size="large" uniProps={mutedColor} />
      </View>
    );
  }

  if (!instance) {
    return (
      <View style={styles.page}>
        <PageHeader icon={Ship} title="Argo CD" description="Applications" />
        <View style={styles.center}>
          <Text style={styles.empty}>Instance not found</Text>
          <Button size="sm" variant="ghost" onPress={goToInstances}>
            Back to instances
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.page} testID="argocd-apps-screen">
      <PageHeader
        icon={Ship}
        title={instance.displayName || instance.url}
        description={instance.url}
        actions={headerActions}
      />
      <View style={styles.statusLine}>
        <InstanceStateDot state={instance.state} />
        <Text style={styles.statusText} numberOfLines={1}>
          {[
            instanceStateLabel(instance.state),
            instance.username ? `as ${instance.username}` : null,
            instance.serverVersion ? `Argo CD ${instance.serverVersion}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsScroll}
        contentContainerStyle={styles.tabs}
      >
        <SegmentedControl
          size="sm"
          options={TAB_OPTIONS}
          value={tab}
          onValueChange={setTab}
          testID="argocd-tabs"
        />
      </ScrollView>
      <InstanceBody
        serverId={serverId}
        client={client}
        instance={instance}
        tab={tab}
        apps={apps}
        onInstance={upsert}
        onManage={goToInstances}
      />
    </View>
  );
}

interface InstanceBodyProps {
  serverId: string;
  client: DaemonClient;
  instance: ArgoCdInstance;
  tab: Tab;
  apps: ReturnType<typeof useArgoCdApps>;
  onInstance: (instance: ArgoCdInstance) => void;
  onManage: () => void;
}

function InstanceBody({
  serverId,
  client,
  instance,
  tab,
  apps,
  onInstance,
  onManage,
}: InstanceBodyProps) {
  const appsState = apps.state;
  const appsError = appsState.status === "error" ? appsState : null;
  const sessionLost =
    appsError?.errorCode === "needs_reauth" || appsError?.errorCode === "unauthenticated";

  if (needsSignIn(instance) || sessionLost) {
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.padded}>
        <View style={[settingsStyles.card, styles.signInCard]} testID="argocd-apps-signin">
          <Text style={styles.signInTitle}>
            {instance.state === "needs_reauth" || sessionLost
              ? "Your Argo CD session expired. Sign in again to see the applications."
              : "Sign in to see the applications."}
          </Text>
          <ArgoCdSignIn client={client} instance={instance} onInstance={onInstance} />
        </View>
      </ScrollView>
    );
  }

  if (tab !== "apps") {
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.padded}>
        <ArgoCdSettingsList client={client} instanceId={instance.id} kind={tab} />
      </ScrollView>
    );
  }

  if (appsState.status === "error") {
    return (
      <View style={styles.padded}>
        <Alert variant="error" title="Unable to load applications" description={appsState.error}>
          <View style={styles.alertActions}>
            <Button size="sm" variant="outline" onPress={apps.retry}>
              Retry
            </Button>
            {appsState.errorCode === "tls_untrusted" ? (
              <Button size="sm" variant="outline" onPress={onManage}>
                Manage instances
              </Button>
            ) : null}
          </View>
        </Alert>
      </View>
    );
  }

  if (appsState.status === "loading") {
    return (
      <View style={styles.center}>
        <ThemedSpinner size="large" uniProps={mutedColor} />
      </View>
    );
  }

  return (
    <ArgoCdAppsView
      serverId={serverId}
      client={client}
      instanceId={instance.id}
      apps={appsState.apps}
    />
  );
}

const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    backgroundColor: theme.chrome.pageCanvas,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    minHeight: 160,
  },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    marginTop: -theme.spacing[1],
    paddingBottom: theme.spacing[3],
  },
  statusText: {
    flexShrink: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  tabsScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  tabs: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  scroll: { flex: 1, minHeight: 0 },
  padded: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  signInCard: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    maxWidth: 720,
  },
  signInTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  alertActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
}));
