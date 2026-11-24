import { useMutation } from "@tanstack/react-query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useToast } from "@/contexts/toast-context";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import {
  Bot,
  Files,
  GitCompareArrows,
  ListFilter,
  Search,
  SquareTerminal,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { GumloopRow } from "./sidebar";

const ThemedSearch = withUnistyles(Search, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

function AgentRow({ agent }: { agent: AggregatedAgent }) {
  const open = useCallback(
    () => navigateToAgent({ serverId: agent.serverId, agentId: agent.id }),
    [agent.id, agent.serverId],
  );
  const dot = useMemo(() => <AgentDot status={agent.status} />, [agent.status]);
  return (
    <GumloopRow
      label={agent.title ?? agent.provider}
      onPress={open}
      testID={`gumloop-recent-${agent.id}`}
      leading={dot}
    />
  );
}
function AgentDot({ status }: { status: AggregatedAgent["status"] }) {
  let dotStyle = styles.dotIdle;
  if (status === "running") dotStyle = styles.dotRunning;
  if (status === "error") dotStyle = styles.dotFailed;
  return <View style={[styles.dot, dotStyle]} />;
}

export function WorkspaceSidebar({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { agents } = useAggregatedAgents();
  const client = useHostRuntimeClient(serverId);
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const recents = useMemo(
    () =>
      agents.filter(
        (agent) =>
          agent.serverId === serverId &&
          agent.workspaceId === workspaceId &&
          (!runningOnly || agent.status === "running") &&
          (agent.title ?? agent.provider).toLowerCase().includes(query.toLowerCase()),
      ),
    [agents, query, runningOnly, serverId, workspaceId],
  );
  const openAgents = useCallback(
    () => navigateToWorkspace({ serverId, workspaceId }),
    [serverId, workspaceId],
  );
  const openFiles = useCallback(() => {
    navigateToWorkspace({ serverId, workspaceId, target: { kind: "files" } });
  }, [serverId, workspaceId]);
  const openChanges = useCallback(() => {
    navigateToWorkspace({ serverId, workspaceId, target: { kind: "changes_tree" } });
  }, [serverId, workspaceId]);
  const terminals = useMutation({
    mutationFn: async () => {
      if (!client || !cwd) throw new Error("Host is disconnected.");
      const list = await client.listTerminals(cwd, undefined, { workspaceId });
      let terminal = list.terminals[0];
      if (!terminal) {
        const created = await client.createTerminal(cwd, undefined, undefined, { workspaceId });
        if (!created.terminal) throw new Error(created.error ?? "Could not create terminal.");
        terminal = created.terminal;
      }
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "terminal", terminalId: terminal.id },
      });
    },
    onError: (error) => toast.error(error.message),
  });
  const openTerminals = useCallback(() => terminals.mutate(), [terminals]);
  const filter = useCallback(() => setRunningOnly((value) => !value), []);
  return (
    <ScrollView style={styles.container} testID="gumloop-workspace-panel">
      <GumloopRow icon={Bot} label="Agents" onPress={openAgents} />
      <GumloopRow icon={SquareTerminal} label="Terminals" onPress={openTerminals} />
      <GumloopRow icon={Files} label="Files" onPress={openFiles} />
      <GumloopRow icon={GitCompareArrows} label="Changes" onPress={openChanges} />
      <Text style={styles.heading}>Recents</Text>
      <View style={styles.searchRow}>
        <View style={styles.search}>
          <ThemedSearch size={16} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            style={styles.input}
            accessibilityLabel="Search agents"
          />
        </View>
        <Button
          variant={runningOnly ? "secondary" : "outline"}
          size="sm"
          leftIcon={ListFilter}
          onPress={filter}
          accessibilityLabel="Filter running agents"
        />
      </View>
      {recents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
    </ScrollView>
  );
}
const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, paddingHorizontal: 10 },
  heading: {
    fontSize: 14,
    color: theme.colors.foregroundMuted,
    marginTop: 24,
    marginBottom: 8,
    paddingHorizontal: 10,
  },
  searchRow: { flexDirection: "row", gap: 6, marginBottom: 8 },
  search: {
    flex: 1,
    height: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: 32,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    fontSize: 16,
  },
  dotIdle: { backgroundColor: theme.colors.foregroundExtraMuted },
  dotRunning: { backgroundColor: theme.colors.palette.amber[500] },
  dotFailed: { backgroundColor: theme.colors.palette.red[500] },
  dot: { width: 7, height: 7, borderRadius: 4 },
}));
