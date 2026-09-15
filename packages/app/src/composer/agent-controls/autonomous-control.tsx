import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Infinity as InfinityIcon } from "lucide-react-native";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { AutorunState } from "@jagentdesk/protocol/messages";

/**
 * Autonomous-mode toggle for the CURRENT agent (spec §20). A switch in the composer
 * toolbar: turn it on and the daemon keeps re-invoking this same agent/session
 * turn-after-turn — keeping its open browser tab + context — so it keeps working toward
 * what you last asked, until it reports done / nothing new, or you turn it off. There is
 * no form: the goal is the conversation. Only rendered when the host advertises the
 * `autorun` feature. Reflects live state via `autorun.stream`.
 */
export function AutonomousControl({
  agentId,
  serverId,
}: {
  agentId: string;
  serverId: string;
}): ReactElement | null {
  const supported = useHostFeature(serverId, "autorun");
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const anchorRef = useRef<View>(null);
  const [state, setState] = useState<AutorunState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!client || !supported) return;
    let alive = true;
    void (async () => {
      try {
        const initial = await client.autorunGet(agentId);
        if (alive) setState(initial);
      } catch {
        // No prior state / transient error — the toggle just shows "off".
      }
    })();
    const unsubscribe = client.subscribeAutorunStream((s) => {
      if (s.agentId === agentId) setState(s);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [client, supported, agentId]);

  const running = state?.status === "running";

  const handlePress = useCallback(async () => {
    if (!client || pending) return;
    setPending(true);
    try {
      const next = running ? await client.autorunStop(agentId) : await client.autorunStart(agentId);
      setState(next);
    } catch {
      // Errors surface via the shared rpc-error path; keep the button responsive.
    } finally {
      setPending(false);
    }
  }, [client, pending, running, agentId]);

  const onPress = useCallback(() => {
    void handlePress();
  }, [handlePress]);

  if (!supported) return null;

  const hint = running
    ? "Autonomous mode is ON — tap to stop. The agent keeps working on its own toward your last request."
    : "Let this agent keep working on its own toward your last request, until it's done.";

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        <AgentControlTrigger
          ref={anchorRef}
          icon={InfinityIcon}
          iconColor={running ? styles.iconOn.color : undefined}
          surface="toolbar"
          label="Autonomous"
          showToolbarLabel={false}
          disabled={!isConnected || pending}
          onPress={onPress}
          accessibilityLabel={running ? "Turn off autonomous mode" : "Turn on autonomous mode"}
          testID={`composer-autonomous-toggle-${agentId}`}
        />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltip}>
          <Text style={styles.tooltipText}>{hint}</Text>
          {running && state?.iteration ? (
            <Text style={styles.tooltipMeta}>
              {state.iteration} turns
              {state.doneItems.length > 0 ? ` · ${state.doneItems.length} done` : ""}
            </Text>
          ) : null}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Icon tint when autonomous mode is on (read as a value; avoids the banned useUnistyles).
  iconOn: {
    color: theme.colors.accent,
  },
  tooltip: {
    maxWidth: 260,
    gap: theme.spacing[1],
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tooltipMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
