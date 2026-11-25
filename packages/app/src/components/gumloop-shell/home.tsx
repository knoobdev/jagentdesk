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
        <View style={styles.header}>
          <Text style={styles.title}>Home</Text>
          <View style={styles.actions}>{actions}</View>
        </View>
      )}
      <View style={desktop ? styles.desktopBody : styles.body}>
        <Text style={styles.sectionTitle}>Recent activity</Text>
        {recent.length ? (
          <AgentList
            agents={recent}
            showHostColumn={hosts.length > 1}
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
  desktopBody: { flex: 1, paddingHorizontal: 82 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 },
  title: { fontSize: 22, fontWeight: "600", color: theme.colors.foreground },
  actions: { flexDirection: "row", gap: 10 },
  body: { flex: 1, marginTop: 16 },
  sectionTitle: {
    fontSize: 20,
    color: theme.colors.foregroundMuted,
    fontWeight: "500",
    marginBottom: 24,
  },
  empty: { paddingTop: 32, alignItems: "flex-start", gap: 16 },
  emptyTitle: { fontSize: 18, fontWeight: "500", color: theme.colors.foreground },
  muted: { fontSize: 16, color: theme.colors.foregroundMuted },
}));
