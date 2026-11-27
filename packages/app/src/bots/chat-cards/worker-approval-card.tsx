// A worker's approval in the chat of the bot that started it (spec 37.3.3): the worker's name, "Open
// worker", "Not now", then the same permission card the worker's own agent shows; answering here or
// there closes both. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/native-chat/prompts/NativeChatApprovalCard.tsx:180-239.
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { PermissionRequestCard } from "@/agent-stream/view";
import type { PendingPermission } from "@/types/shared";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export function BotWorkerApprovalCard({
  serverId,
  client,
  permission,
  workerName,
  onNotNow,
}: {
  serverId: string;
  client: DaemonClient | null;
  permission: PendingPermission;
  workerName: string;
  /** Folds the card away here; the request stays in Needs you and in the worker. */
  onNotNow: (key: string) => void;
}) {
  const { t } = useTranslation();
  const openWorker = useCallback(
    () => navigateToAgent({ serverId, agentId: permission.agentId }),
    [permission.agentId, serverId],
  );
  const notNow = useCallback(() => onNotNow(permission.key), [onNotNow, permission.key]);
  return (
    <View style={styles.card} testID={`bot-worker-approval-${permission.key}`}>
      <View style={styles.header}>
        <Text style={styles.worker} numberOfLines={1}>
          {t("bots.jad.panels.approval.worker", { name: workerName })}
        </Text>
        <Text style={styles.dot}>·</Text>
        <Pressable onPress={openWorker} accessibilityRole="link" testID="bot-worker-approval-open">
          <Text style={styles.link}>{t("bots.jad.panels.approval.openWorker")}</Text>
        </Pressable>
        <View style={styles.spacer} />
        <Pressable onPress={notNow} accessibilityRole="button" style={styles.notNow}>
          <Text style={styles.notNowText}>{t("bots.jad.panels.approval.notNow")}</Text>
        </Pressable>
      </View>
      <PermissionRequestCard permission={permission} client={client} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { gap: 4 },
  header: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28 },
  worker: { flexShrink: 1, fontSize: 12, color: theme.colors.foregroundMuted },
  dot: { fontSize: 12, color: theme.colors.foregroundMuted },
  link: { fontSize: 12, fontWeight: "500", color: theme.colors.foreground },
  spacer: { flex: 1 },
  notNow: { minHeight: 28, justifyContent: "center", paddingHorizontal: 8, borderRadius: 8 },
  notNowText: { fontSize: 12, color: theme.colors.foregroundMuted },
}));
