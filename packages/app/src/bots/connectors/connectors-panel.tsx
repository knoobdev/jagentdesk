// The bot's Connectors tab (spec 37.4.7): Slack, GitHub, GitLab and Telegram, each "Add {{name}}" or
// "Manage {{name}}", a connector that needs the owner says so and counts on the tab's badge. Ported
// from Orca dfdb4fda (MIT) src/renderer/src/components/bots/BotConnectorsPanel.tsx:1-26,
// BotConnectorRow.tsx:60-198 and bot-connector-row-parts.tsx (row, fix line, status).
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { Button } from "@/components/ui/button";
import { useBotsHooksSupported } from "./hooks-rpc";
import { BotConnectorSetupDialog } from "./setup-dialogs";
import {
  BOT_CONNECTOR_DESCRIPTION_KEYS,
  botConnectorRows,
  botConnectorsNeedFix,
  type BotConnectorId,
  type BotConnectorRowView,
} from "./connector-rows";

/** The Connectors tab badge: connectors that need the owner to sign in again or fix them. */
export function useBotConnectorsNeedFix(bot: Bot): number {
  return botConnectorsNeedFix(bot);
}

function ConnectorRow({
  row,
  folder,
  available,
  onOpen,
}: {
  row: BotConnectorRowView;
  folder: string;
  /** GitHub, GitLab and Telegram need a host with `botsHooks`. */
  available: boolean;
  onOpen: (id: BotConnectorId) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(row.id), [onOpen, row.id]);
  const label = row.connected
    ? t("bots.connectors.manageNamed", { name: row.name })
    : t("bots.connectors.addNamed", { name: row.name });
  return (
    <View style={styles.row} testID={`bot-connector-${row.id}`}>
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {row.connected && row.label ? `${row.name} · ${row.label}` : row.name}
        </Text>
        {row.needsFix ? (
          <Text style={styles.fix} numberOfLines={2}>
            {t("bots.needs.connector", { name: row.name })}
          </Text>
        ) : (
          <Text style={styles.description} numberOfLines={2}>
            {available
              ? t(BOT_CONNECTOR_DESCRIPTION_KEYS[row.id], { folder })
              : t("bots.jad.panels.connectors.updateHost")}
          </Text>
        )}
      </View>
      <Button
        size="sm"
        variant="outline"
        onPress={open}
        disabled={!available}
        testID={`bot-connector-${row.id}-open`}
      >
        {label}
      </Button>
    </View>
  );
}

export function BotConnectorsPanel({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const hooks = useBotsHooksSupported(serverId);
  const [open, setOpen] = useState<BotConnectorId | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const folder = bot.folder ?? bot.slug;
  const rows = botConnectorRows(bot);
  return (
    <ScrollView contentContainerStyle={styles.panel} testID="bot-connectors-panel">
      <View style={styles.card}>
        {rows.map((row, index) => (
          <View key={row.id} style={index > 0 ? styles.rowBorder : null}>
            <ConnectorRow
              row={row}
              folder={folder}
              available={row.id === "slack" || hooks}
              onOpen={setOpen}
            />
          </View>
        ))}
      </View>
      <Text style={styles.note}>
        {t("bots.jad.panels.connectors.emptyNote", { name: bot.name })}
      </Text>
      <BotConnectorSetupDialog serverId={serverId} bot={bot} connector={open} onClose={close} />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  rowBorder: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  row: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  description: { fontSize: 13, color: theme.colors.foregroundMuted },
  fix: { fontSize: 13, color: theme.colors.statusWarning },
  note: { fontSize: 13, color: theme.colors.foregroundMuted },
}));
