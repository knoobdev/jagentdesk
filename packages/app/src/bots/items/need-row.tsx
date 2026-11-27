// One of JAgentDesk's asks in a bot's Needs you group, in an item row's anatomy: a glyph for its kind,
// its title on one line and what it asks under it; hover (always on native) shows its actions.
// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/BotNeedRow.tsx:1-190 and the
// need kinds of BotNeedsYouSection.tsx:58-260. Approvals answer in place with the agent permission RPC
// (`agent_permission_response` on `row.agentId` + `row.requestId`): the Home Chat card, the worker's card
// and this row are the same pending request, so answering one closes all (contract §Approvals).
import { getJAgentDeskToolLabel } from "@jagentdesk/protocol/jagentdesk-tool-presentation/index";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleAlert, CircleHelp, Shield } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotNeedsYouRow } from "@jagentdesk/protocol/bots/views";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { usePermissionResponse } from "@/agent-stream/use-permission-response";
import { useBotPanelStore } from "@/bots/panel-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { Theme } from "@/styles/theme";
import { useHoverReveal } from "./item-parts";

const askColor = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });
const dangerColor = (theme: Theme) => ({ color: theme.colors.statusDanger });
const ThemedShield = withUnistyles(Shield);
const ThemedHelp = withUnistyles(CircleHelp);
const ThemedAlert = withUnistyles(CircleAlert);

/** Display names of the connectors a Needs you row can name. */
const CONNECTOR_NAMES: Record<string, string> = {
  slack: "Slack",
  github: "GitHub",
  gitlab: "GitLab",
  telegram: "Telegram",
};

export function botConnectorName(connector: string | undefined): string {
  return (connector && CONNECTOR_NAMES[connector]) ?? connector ?? "";
}

interface NeedAction {
  label: string;
  onPress: () => void;
  variant?: "ghost" | "outline" | "default";
  loading?: boolean;
  testID?: string;
}

function NeedRowView({
  kind,
  title,
  detail,
  actions,
  testID,
}: {
  kind: "approval" | "question" | "connector";
  title: string;
  detail: string;
  actions: readonly NeedAction[];
  testID?: string;
}) {
  const { revealed, hovered, handlers } = useHoverReveal();
  const primary = actions[actions.length - 1];
  return (
    <View style={styles.hoverTarget} {...handlers} testID={testID}>
      <View style={[styles.row, hovered && styles.rowActive]}>
        <View style={styles.lead}>
          {kind === "approval" ? (
            <ThemedShield size={12} strokeWidth={2.25} uniProps={askColor} />
          ) : null}
          {kind === "question" ? (
            <ThemedHelp size={12} strokeWidth={2.25} uniProps={askColor} />
          ) : null}
          {kind === "connector" ? (
            <ThemedAlert size={12} strokeWidth={2.25} uniProps={dangerColor} />
          ) : null}
        </View>
        <Pressable
          style={styles.body}
          onPress={primary?.onPress}
          disabled={!primary}
          accessibilityRole="button"
          accessibilityLabel={title}
        >
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.detail} numberOfLines={revealed ? 2 : 1}>
            {detail}
          </Text>
        </Pressable>
        {revealed && actions.length > 0 ? (
          <View style={styles.actions}>
            {actions.map((action) => (
              <Button
                key={action.label}
                size="xs"
                variant={action.variant ?? "ghost"}
                onPress={action.onPress}
                loading={action.loading}
                testID={action.testID}
              >
                {action.label}
              </Button>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** "Permission · Bash" when the tool is known, else what any approval says. */
function permissionLine(
  t: (key: string, values?: Record<string, unknown>) => string,
  tool?: string,
) {
  return tool
    ? t("bots.needs.permissionTool", { tool: getJAgentDeskToolLabel(tool) ?? tool })
    : t("bots.needs.permission");
}

function ApprovalNeedRow({
  serverId,
  bot,
  row,
}: {
  serverId: string;
  bot: Bot;
  row: BotNeedsYouRow;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const noop = useCallback(() => {}, []);
  const permission = usePermissionResponse({
    client,
    agentId: row.agentId ?? "",
    requestId: row.requestId ?? "",
    unavailableMessage: t("common.errors.daemonClientUnavailable"),
    onExpired: noop,
  });
  const ask = permissionLine(t, row.tool);
  let detail = row.detail ? `${ask} · ${row.detail}` : ask;
  if (row.workerName) detail = `${t("bots.needs.worker", { name: row.workerName })} · ${ask}`;
  const canAnswer = Boolean(row.agentId && row.requestId);
  const homeAgentId = bot.homeAgentId ?? bot.agentId;
  const actions = useMemo<NeedAction[]>(() => {
    const list: NeedAction[] = [];
    // A worker's card also shows in its own agent; the bot's own sits in the Home Chat beside this.
    if (row.agentId && row.agentId !== homeAgentId)
      list.push({
        label: t("bots.needs.open"),
        onPress: () => navigateToAgent({ serverId, agentId: row.agentId ?? "" }),
      });
    if (canAnswer) {
      list.push({
        label: t("agentStream.permission.deny"),
        onPress: () => permission.respond({ behavior: "deny" }, "deny"),
        loading: permission.respondingActionId === "deny",
        testID: "bot-need-deny",
      });
      list.push({
        label: t("agentStream.permission.accept"),
        variant: "default",
        onPress: () => permission.respond({ behavior: "allow" }, "allow"),
        loading: permission.respondingActionId === "allow",
        testID: "bot-need-allow",
      });
    }
    return list;
  }, [row.agentId, homeAgentId, canAnswer, t, serverId, permission]);
  return (
    <NeedRowView
      kind="approval"
      title={row.title}
      detail={permission.error ?? detail}
      actions={actions}
      testID={`bot-need-${row.key}`}
    />
  );
}

export function BotNeedRow({
  serverId,
  bot,
  row,
}: {
  serverId: string;
  bot: Bot;
  row: BotNeedsYouRow;
}) {
  const { t } = useTranslation();
  const openConnectors = useCallback(() => {
    useBotPanelStore.getState().setTab(bot.id, "connectors");
  }, [bot.id]);
  if (row.kind === "approval") return <ApprovalNeedRow serverId={serverId} bot={bot} row={row} />;
  if (row.kind === "connector") {
    const name = botConnectorName(row.connector) || row.title;
    return (
      <NeedRowView
        kind="connector"
        title={name}
        detail={row.detail ?? t("bots.needs.connector", { name })}
        actions={[{ label: t("bots.needs.fixConnector", { name }), onPress: openConnectors }]}
        testID={`bot-need-${row.key}`}
      />
    );
  }
  return <QuestionNeedRow serverId={serverId} bot={bot} row={row} />;
}

/**
 * A question waiting in one of its chats (spec 37.4.4 b). Skip settles it here, as the chat's own
 * question card dismisses it (Orca BotNeedsYouSection.tsx:89-111).
 */
function QuestionNeedRow({
  serverId,
  bot,
  row,
}: {
  serverId: string;
  bot: Bot;
  row: BotNeedsYouRow;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const noop = useCallback(() => {}, []);
  const permission = usePermissionResponse({
    client,
    agentId: row.agentId ?? "",
    requestId: row.requestId ?? "",
    unavailableMessage: t("common.errors.daemonClientUnavailable"),
    onExpired: noop,
  });
  const homeAgentId = bot.homeAgentId ?? bot.agentId;
  const title = row.chatTitle ?? row.title ?? t("bots.needs.chat", { name: bot.name });
  const opensElsewhere = Boolean(row.agentId && row.agentId !== homeAgentId);
  const canSkip = Boolean(row.agentId && row.requestId);
  const actions = useMemo<NeedAction[]>(() => {
    const list: NeedAction[] = [];
    if (opensElsewhere)
      list.push({
        label: t("bots.needs.open"),
        onPress: () => navigateToAgent({ serverId, agentId: row.agentId ?? "" }),
      });
    if (canSkip)
      list.push({
        label: t("bots.jad.items.skipQuestion"),
        onPress: () =>
          permission.respond({ behavior: "deny", message: "Dismissed by user" }, "skip"),
        loading: permission.respondingActionId === "skip",
        testID: "bot-need-skip",
      });
    return list;
  }, [canSkip, opensElsewhere, permission, row.agentId, serverId, t]);
  return (
    <NeedRowView
      kind="question"
      title={title}
      detail={permission.error ?? row.detail ?? t("bots.needs.waiting")}
      actions={actions}
      testID={`bot-need-${row.key}`}
    />
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  hoverTarget: { position: "relative" },
  row: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  rowActive: { backgroundColor: theme.colors.surface2 },
  lead: { width: 16, height: 20, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 13, lineHeight: 20, color: theme.colors.foreground },
  detail: { fontSize: 12, lineHeight: 16, color: theme.colors.foregroundMuted },
  actions: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "center" },
}));
