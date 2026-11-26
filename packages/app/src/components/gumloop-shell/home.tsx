import { gumloopListStyles } from "./list-styles";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { History, House, Plus } from "lucide-react-native";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/headers/page-header";
import { useGumloopDesktopShell } from "./use-gumloop-chrome";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useHosts } from "@/runtime/host-runtime";
import { useNewWorkspaceNavigate } from "@/components/sidebar/use-app-nav";
import { AgentList } from "@/components/agent-list";
import { buildSessionsRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";

function viewHistory() {
  router.push(buildSessionsRoute());
}
export function GumloopHome() {
  const hosts = useHosts();
  const { agents } = useAggregatedAgents();
  const recent = useMemo(() => agents.slice(0, 8), [agents]);
  const newAgent = useNewWorkspaceNavigate();
  const desktop = useGumloopDesktopShell(true);
  const actions = (
    <>
      <Button variant="outline" size="md" onPress={viewHistory} leftIcon={History}>
        History
      </Button>
      <Button variant="default" size="md" onPress={newAgent} leftIcon={Plus}>
        New agent
      </Button>
    </>
  );
  return (
    <View style={desktop ? styles.desktopPage : styles.page} testID="gumloop-home">
      {desktop ? (
        <PageHeader icon={House} title="Home" actions={actions} testID="gumloop-home-header" />
      ) : (
        // The compact header (spec 38 §5) already shows "Home"; the page only carries its actions.
        <View style={styles.header}>
          <View style={styles.actions}>{actions}</View>
        </View>
      )}
      <View style={desktop ? styles.desktopBody : styles.body}>
        <Text style={styles.sectionTitle}>Recent activity</Text>
        {recent.length ? (
          <AgentList
            agents={recent}
            showHostColumn={hosts.length > 1}
            placement="embedded"
            contentContainerStyle={gumloopListStyles.embeddedContent}
          />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Your development environment, in your pocket.</Text>
            <Text style={styles.muted}>
              Start an agent in one of your projects to see its activity here.
            </Text>
            <Button variant="outline" onPress={newAgent}>
              New agent
            </Button>
          </View>
        )}
      </View>
    </View>
  );
}
const styles = StyleSheet.create((theme: Theme) => ({
  page: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: 12,
    paddingTop: 16,
  },
  desktopPage: { flex: 1, backgroundColor: theme.colors.surface0 },
  // The page header keeps 16px under its title row for every page; Home's label sits 8px under
  // it (spec 38 §4.1).
  desktopBody: { flex: 1, paddingHorizontal: 82, marginTop: -theme.spacing[2] },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 },
  actions: { flexDirection: "row", gap: 10 },
  body: { flex: 1, marginTop: theme.spacing[2] },
  sectionTitle: {
    fontSize: 16,
    lineHeight: 22,
    color: theme.colors.foregroundMuted,
    fontWeight: "500",
  },
  empty: { paddingTop: 32, alignItems: "flex-start", gap: 16 },
  emptyTitle: { fontSize: 18, fontWeight: "500", color: theme.colors.foreground },
  muted: { fontSize: 16, color: theme.colors.foregroundMuted },
}));
