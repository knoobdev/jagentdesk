import { useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Users } from "lucide-react-native";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHostFeature } from "@/runtime/host-features";
import { useTeamModeStore, teamModeKey } from "@/composer/agent-controls/team-mode-store";

/**
 * "Team mode" toggle for the current agent (docs/plans/active/agent-forum.md). When on, the next chat
 * send opens a forum topic and hands this agent the team-lead brief — it plans the work, splits it
 * into tasks, spawns peers, and runs the shared board on the Team screen. Opt-in per session so a
 * costly team never starts by accident. Shown only when the host advertises the agentForum feature.
 */
export function TeamModeControl({
  agentId,
  serverId,
}: {
  agentId: string;
  serverId: string;
}): ReactElement | null {
  const supported = useHostFeature(serverId, "agentForum");
  const key = teamModeKey(serverId, agentId);
  const enabled = useTeamModeStore((s) => s.enabled[key] === true);
  const toggle = useTeamModeStore((s) => s.toggle);
  const onPress = useCallback(() => toggle(key), [toggle, key]);

  if (!supported) return null;

  const hint = enabled
    ? "Team mode is ON — your next message opens a topic on the Team screen and the agents work it as a team. Tap to turn off."
    : "Turn on Team mode: your next coding request is handled by a team of agents (plan → tasks → assign → build) on the Team screen.";

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        <AgentControlTrigger
          icon={Users}
          iconColor={enabled ? styles.iconOn.color : undefined}
          surface="toolbar"
          label="Team"
          showToolbarLabel={false}
          onPress={onPress}
          accessibilityLabel={enabled ? "Turn off Team mode" : "Turn on Team mode"}
          testID={`composer-team-toggle-${agentId}`}
        />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltip}>
          <Text style={styles.tooltipText}>{hint}</Text>
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  iconOn: { color: theme.colors.accent },
  tooltip: { maxWidth: 260, gap: theme.spacing[1] },
  tooltipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
