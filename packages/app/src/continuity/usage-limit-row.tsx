import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageLimitNotice } from "@jagentdesk/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { providerDisplayLabel } from "./use-agent-ledger";

/**
 * Spec 40 §4: a usage limit that did not fail over. "Continue with …" moves the agent to the
 * suggested provider and resends the failed turn's message.
 */
export function UsageLimitRow({
  serverId,
  agentId,
  message,
  notice,
}: {
  serverId: string;
  agentId: string;
  message: string;
  notice: UsageLimitNotice;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<"idle" | "pending" | "done">("idle");
  const suggestion = notice.suggestion;
  const handleContinue = useCallback(async () => {
    if (!client || !suggestion) return;
    setState("pending");
    try {
      await client.continueAgentWithProvider(agentId, suggestion);
      setState("done");
    } catch (error) {
      setState("idle");
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [agentId, client, suggestion, toast]);
  return (
    <View style={styles.card} testID="usage-limit-row">
      <Text style={styles.title}>{message}</Text>
      <Text style={styles.hint}>
        {t(
          notice.failover === "off"
            ? "continuity.usageLimit.hintOff"
            : "continuity.usageLimit.hintUsedUp",
        )}
      </Text>
      {suggestion && state !== "done" ? (
        <View style={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            onPress={handleContinue}
            disabled={state === "pending" || !client}
            testID="usage-limit-continue"
          >
            {t("continuity.usageLimit.continueWith", {
              provider: providerDisplayLabel(suggestion.provider),
            })}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[2],
    marginVertical: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
  },
}));
