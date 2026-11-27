// The Items tab's Needs you group on a phone (spec 37.6, order and fold as 37.4.4): approvals first and
// never folded, then chat questions, connectors to fix, then the items set to Needs you; max(5,
// approvals) rows, then "Show N more" when two or more are hidden. An approval answers in place when
// its card is in one of the bot's chats; any other says "{{need}} · open it where it runs" and opens
// the agent it waits in.
// Ported from Orca dfdb4fda (MIT) mobile/src/bots/items/MobileBotNeedsYouGroup.tsx:37-345, on the
// JAgentDesk asks (`bots.needs_you.list`, contract §Approvals: one pending request, answered with
// `agent_permission_response` on `row.agentId` + `row.requestId`).
import { getJAgentDeskToolLabel } from "@jagentdesk/protocol/jagentdesk-tool-presentation/index";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleHelp, KeyRound, Shield } from "lucide-react-native";
import { needsYouFold } from "@jagentdesk/protocol/bots/rules";
import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import type { BotNeedsYouRow } from "@jagentdesk/protocol/bots/views";
import { Button } from "@/components/ui/button";
import { usePermissionResponse } from "@/agent-stream/use-permission-response";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { Theme } from "@/styles/theme";
import { useBotPanelStore } from "@/bots/panel-store";
import { botConnectorName } from "@/bots/items/need-row";
import { botItemStatusName, botNeedsYouRows } from "@/bots/items/item-rules";
import { closePhoneBotPanel } from "./panel-store";
import { PhoneSectionHeader } from "./section-header";

const askColor = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });
const ThemedShield = withUnistyles(Shield);
const ThemedHelp = withUnistyles(CircleHelp);
const ThemedKey = withUnistyles(KeyRound);
const SHIELD = <ThemedShield size={17} strokeWidth={2.1} uniProps={askColor} />;
const HELP = <ThemedHelp size={17} strokeWidth={2.1} uniProps={askColor} />;
const KEY = <ThemedKey size={17} strokeWidth={2.1} uniProps={askColor} />;

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** The bot's own chats: its card is right there in the chat, so it answers here too. */
function answersInPlace(row: BotNeedsYouRow, homeAgentId: string | undefined): boolean {
  if (!row.agentId || !row.requestId) return false;
  return row.agentId === homeAgentId || Boolean(row.chatAgentId);
}

/** The agent opens in the centre, so the panel closes first. */
function closePanelAnd(botId: string, open: () => void): void {
  closePhoneBotPanel(botId);
  open();
}

export function PhoneNeedsYouGroup({
  serverId,
  bot,
  asks,
  items,
  disabled,
  renderItem,
}: {
  serverId: string;
  bot: Bot;
  asks: readonly BotNeedsYouRow[];
  items: readonly BotItem[];
  /** Offline: rows stay, taps wait. */
  disabled: boolean;
  renderItem: (item: BotItem) => ReactNode;
}) {
  const { t } = useTranslation();
  const [folded, setFolded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setFolded((value) => !value), []);
  const expand = useCallback(() => setExpanded(true), []);
  const rows = useMemo(() => botNeedsYouRows(asks, items), [asks, items]);
  if (rows.length === 0) return null;
  const fold = needsYouFold(rows, { expanded: expanded || disabled });
  const shown = new Set(fold.visible);
  return (
    <View testID="phone-bot-needs-you">
      <PhoneSectionHeader
        title={`${botItemStatusName("needs_you", t)} ${rows.length}`}
        expanded={!folded}
        onToggle={toggle}
        testID="phone-bot-items-group-needs_you"
      />
      {folded ? null : (
        <View>
          {fold.ordered.map((row) => {
            if (!shown.has(row.key)) return null;
            if (row.kind === "item") return <View key={row.key}>{renderItem(row.item)}</View>;
            return (
              <AskRow
                key={row.key}
                serverId={serverId}
                bot={bot}
                row={row.need}
                disabled={disabled}
              />
            );
          })}
          {fold.hidden > 0 ? (
            <Pressable
              onPress={expand}
              style={styles.more}
              accessibilityRole="button"
              testID="phone-bot-needs-you-more"
            >
              <Text style={styles.moreText}>
                {t("bots.phone.bots.items.group.showMore", { count: fold.hidden })}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

function AskRow({
  serverId,
  bot,
  row,
  disabled,
}: {
  serverId: string;
  bot: Bot;
  row: BotNeedsYouRow;
  disabled: boolean;
}) {
  if (row.kind === "approval")
    return <ApprovalRow serverId={serverId} bot={bot} row={row} disabled={disabled} />;
  if (row.kind === "connector") return <ConnectorRow bot={bot} row={row} disabled={disabled} />;
  return <QuestionRow serverId={serverId} bot={bot} row={row} disabled={disabled} />;
}

function approvalNeed(t: Translate, row: BotNeedsYouRow): string {
  return row.tool
    ? t("bots.phone.bots.needs.permissionTool", {
        tool: getJAgentDeskToolLabel(row.tool) ?? row.tool,
      })
    : t("bots.phone.bots.needs.permission");
}

function ApprovalRow({
  serverId,
  bot,
  row,
  disabled,
}: {
  serverId: string;
  bot: Bot;
  row: BotNeedsYouRow;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const homeAgentId = bot.homeAgentId ?? bot.agentId;
  const inPlace = answersInPlace(row, homeAgentId);
  const noop = useCallback(() => {}, []);
  const permission = usePermissionResponse({
    client,
    agentId: row.agentId ?? "",
    requestId: row.requestId ?? "",
    unavailableMessage: t("common.errors.daemonClientUnavailable"),
    onExpired: noop,
  });
  const need = approvalNeed(t, row);
  const where = inPlace ? need : t("bots.phone.bots.needs.whereItRuns", { need });
  const line = row.workerName
    ? `${t("bots.phone.bots.needs.worker", { name: row.workerName })} · ${where}`
    : where;
  const open = useCallback(() => {
    const agentId = row.agentId;
    // The bot's own card is in the Home Chat under the sheet.
    if (!agentId || agentId === homeAgentId) closePhoneBotPanel(bot.id);
    else closePanelAnd(bot.id, () => navigateToAgent({ serverId, agentId }));
  }, [row.agentId, homeAgentId, serverId, bot.id]);
  const allow = useCallback(() => permission.respond({ behavior: "allow" }, "allow"), [permission]);
  const deny = useCallback(() => permission.respond({ behavior: "deny" }, "deny"), [permission]);
  return (
    <View style={styles.askRow} testID={`phone-bot-need-${row.key}`}>
      <Pressable
        onPress={open}
        disabled={disabled}
        style={styles.askPress}
        accessibilityRole="button"
        accessibilityLabel={t("bots.phone.bots.needs.actionFor", {
          action: t("bots.phone.bots.needs.open"),
          title: row.title,
        })}
      >
        <View style={styles.lead}>{SHIELD}</View>
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={1}>
            {row.title}
          </Text>
          <Text style={styles.line} numberOfLines={2} testID={`phone-bot-need-line-${row.key}`}>
            {permission.error ?? line}
          </Text>
          {row.detail ? (
            <Text style={styles.command} numberOfLines={1}>
              {row.detail}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {inPlace ? (
        <View style={styles.answers}>
          <Button
            size="sm"
            variant="outline"
            onPress={deny}
            disabled={disabled}
            loading={permission.respondingActionId === "deny"}
            testID="phone-bot-need-deny"
          >
            {t("bots.phone.chat.workerApproval.deny")}
          </Button>
          <Button
            size="sm"
            variant="default"
            onPress={allow}
            disabled={disabled}
            loading={permission.respondingActionId === "allow"}
            testID="phone-bot-need-allow"
          >
            {t("bots.phone.chat.workerApproval.allow")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function QuestionRow({
  serverId,
  bot,
  row,
  disabled,
}: {
  serverId: string;
  bot: Bot;
  row: BotNeedsYouRow;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const homeAgentId = bot.homeAgentId ?? bot.agentId;
  const home = !row.agentId || row.agentId === homeAgentId;
  const title = home
    ? t("bots.phone.bots.needs.chat", { name: bot.name })
    : (row.chatTitle ?? row.title);
  const open = useCallback(() => {
    const agentId = row.agentId;
    // Home Chat is under the sheet.
    if (home || !agentId) closePhoneBotPanel(bot.id);
    else closePanelAnd(bot.id, () => navigateToAgent({ serverId, agentId }));
  }, [home, row.agentId, serverId, bot.id]);
  return (
    <Pressable
      onPress={open}
      disabled={disabled}
      style={styles.askPress}
      accessibilityRole="button"
      accessibilityLabel={t("bots.phone.bots.needs.actionFor", {
        action: t("bots.phone.bots.needs.open"),
        title,
      })}
      testID={`phone-bot-need-${row.key}`}
    >
      <View style={styles.lead}>{HELP}</View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.line} numberOfLines={1}>
          {row.detail ?? t("bots.phone.bots.needs.waiting")}
        </Text>
      </View>
    </Pressable>
  );
}

function ConnectorRow({
  bot,
  row,
  disabled,
}: {
  bot: Bot;
  row: BotNeedsYouRow;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const name = botConnectorName(row.connector) || row.title;
  // Settings › Access › Connectors on a phone (Orca opens the connector's Settings page).
  const open = useCallback(
    () => useBotPanelStore.getState().setTab(bot.id, "connectors"),
    [bot.id],
  );
  return (
    <Pressable
      onPress={open}
      disabled={disabled}
      style={styles.askPress}
      accessibilityRole="button"
      accessibilityLabel={t("bots.phone.bots.needs.fixConnector", { name })}
      testID={`phone-bot-need-${row.key}`}
    >
      <View style={styles.lead}>{KEY}</View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.line} numberOfLines={2}>
          {row.detail ?? t("bots.phone.bots.needs.connector", { name })}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  askRow: { paddingVertical: 2 },
  askPress: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 8,
  },
  lead: { width: 18, paddingTop: 1, alignItems: "center" },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, lineHeight: 20, color: theme.colors.foreground },
  line: { fontSize: 13, lineHeight: 18, color: theme.colors.foregroundMuted },
  command: {
    marginTop: 2,
    fontSize: 12,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  answers: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  more: { minHeight: 44, justifyContent: "center", paddingLeft: 36 },
  moreText: { fontSize: 14, color: theme.colors.foregroundMuted },
}));
