import { useCallback } from "react";
import { Text, View } from "react-native";
import {
  Switch,
  settingsStyles,
  useDaemonConfig,
  useHostRuntimeIsConnected,
  type BuiltinClientProps,
} from "../../../../packages/app/src/plugins/builtin/host-api";

// Spec 29.4: while the host has a Jira connection, agents use JAgentDesk's jira_* tools. This
// switch also removes the provider's own Jira/Atlassian connectors from agent launches where the
// provider's CLI supports it; elsewhere only the agent instruction applies.
const TITLE = "Hide the provider's own Jira/Atlassian connectors from agents";
const HINT =
  "Agents use JAgentDesk's Jira tools for your connected sites. Claude Code and Codex also lose their own Atlassian connectors in new and resumed sessions; other providers only get the instruction.";

export function JiraProviderConnectorsCard({ serverId }: BuiltinClientProps) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const handleValueChange = useCallback(
    (next: boolean) => {
      void patchConfig({ jira: { hideProviderConnectors: next } });
    },
    [patchConfig],
  );
  // COMPAT(jiraConnectorSetting): added in v0.10.2, remove after 2027-05-26; older daemons omit the setting.
  if (!isConnected || !config?.jira) return null;
  return (
    <View style={settingsStyles.card} testID="host-page-jira-provider-connectors-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{TITLE}</Text>
          <Text style={settingsStyles.rowHint}>{HINT}</Text>
        </View>
        <Switch
          value={config.jira.hideProviderConnectors !== false}
          onValueChange={handleValueChange}
          accessibilityLabel={TITLE}
          testID="host-page-jira-provider-connectors-switch"
        />
      </View>
    </View>
  );
}
