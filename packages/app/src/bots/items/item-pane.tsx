// One item, in the list's place (spec 37.4.5): the back row, its place in the list with Previous /
// Next, then the item — number and title, status, "Item N · chat", links — the description (folded
// behind "Show more"), Done means, the Activity, the waiting question one step at a time, and the
// comment box. Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/items/BotItemPane.tsx,
// BotItemStepper.tsx, BotItemView.tsx:150-430, BotItemHeader.tsx:21-189, BotItemClampedText.tsx and
// BotItemCommentBox.tsx (the box's placeholder and submit), on `bots.items.show`.
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react-native";
import {
  botItemStaleDays,
  groupBotItems,
  isBotItemSnoozed,
  isOpenBotItemStatus,
} from "@jagentdesk/protocol/bots/rules";
import type { Bot, BotItem, BotItemEvent, BotItemStatus } from "@jagentdesk/protocol/bots/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { botErrorCode, useBotsRead, useItems } from "@/bots/queries";
import { useBotPanel, useBotPanelStore } from "@/bots/panel-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { Theme } from "@/styles/theme";
import { BotItemActivityList } from "./item-activity";
import { useBotItemActions } from "./item-actions";
import { BotItemCancelDialog } from "./cancel-dialog";
import {
  BotItemStatusIcon,
  BotItemStatusMenuItem,
  foregroundColor,
  itemStyles,
  mutedColor,
} from "./item-parts";
import {
  BOT_ITEM_PICKER_STATUSES,
  botItemChatName,
  botItemStatusName,
  botItemsInListOrder,
  filterBotItems,
  formatBotItemNumber,
  formatBotItemSnoozeTime,
  isBotItemAwaitingReview,
  isBotItemLive,
} from "./item-rules";
import { BotItemLinkChips } from "./link-chips";
import { BotItemQuestionStep, MARK_DONE_ANYWAY } from "./question-step";
import { SNOOZE_PAGE, botItemSnoozePage, useBotItemSnoozing, type BotItemSnoozing } from "./snooze";
import { useNow } from "./use-now";
import { useIsCompactFormFactor } from "@/constants/layout";
import { PhoneItemAskCard } from "@/bots/phone/ask-card";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedLeft = withUnistyles(ChevronLeft);
const ThemedRight = withUnistyles(ChevronRight);
const ThemedDown = withUnistyles(ChevronDown);

/** The rows Previous / Next walk: the list as the panel shows it, filters and groups applied. */
function useItemWalk(serverId: string, bot: Bot, itemId: string) {
  const items = useItems(serverId, bot.id).data;
  const { filters } = useBotPanel(bot.id);
  const now = useNow(60_000);
  return useMemo(() => {
    const shown = filterBotItems(items ?? [], {
      needsYouOnly: filters.needsYouOnly,
      chatId: filters.chatId,
    });
    const ordered = botItemsInListOrder(
      groupBotItems(shown, botItemStaleDays(bot.itemsStale), now),
    );
    const index = ordered.findIndex((item) => item.id === itemId);
    return {
      listed: (items ?? []).find((item) => item.id === itemId),
      index,
      total: ordered.length,
      previous: index > 0 ? ordered[index - 1] : undefined,
      next: index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : undefined,
    };
  }, [items, filters.needsYouOnly, filters.chatId, bot.itemsStale, now, itemId]);
}

export function BotItemPane({
  serverId,
  bot,
  itemId,
}: {
  serverId: string;
  bot: Bot;
  itemId: string;
}) {
  const { t } = useTranslation();
  const walk = useItemWalk(serverId, bot, itemId);
  const read = useBotsRead(serverId, "bots.items.show.request", { botId: bot.id, itemId });
  const back = useCallback(() => useBotPanelStore.getState().backToActivity(bot.id), [bot.id]);
  const step = useCallback(
    (to: BotItem | undefined) => {
      if (to) useBotPanelStore.getState().openItem(bot.id, to.id);
    },
    [bot.id],
  );
  const stepPrevious = useCallback(() => step(walk.previous), [step, walk.previous]);
  const stepNext = useCallback(() => step(walk.next), [step, walk.next]);
  const { refetch } = read;
  const retry = useCallback(() => void refetch(), [refetch]);
  const deleted = read.isError && botErrorCode(read.error) === "not_found";
  const item = read.data?.item ?? walk.listed;
  // A phone's panel calls the list Items (Orca `bots.items.tab` on mobile); the desktop's tab is Home.
  const compact = useIsCompactFormFactor();
  const backLabel = compact ? t("bots.phone.bots.items.tab") : t("bots.items.tab");
  return (
    <View style={styles.pane} testID="bot-item-pane">
      <View style={styles.backRow}>
        <Pressable
          onPress={back}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          testID="bot-item-back"
        >
          <ThemedArrowLeft size={16} uniProps={foregroundColor} />
          <Text style={styles.backText}>{backLabel}</Text>
        </Pressable>
        {walk.index >= 0 && walk.total > 0 ? (
          <View
            style={styles.stepper}
            accessibilityLabel={t("bots.items.view.navigation", {
              index: walk.index + 1,
              total: walk.total,
            })}
          >
            <Pressable
              disabled={!walk.previous}
              onPress={stepPrevious}
              style={[styles.stepButton, !walk.previous && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel={t("bots.items.view.previous")}
              testID="bot-item-previous"
            >
              <ThemedLeft size={14} uniProps={mutedColor} />
            </Pressable>
            <Text style={styles.place} testID="bot-item-place">
              {t("bots.items.view.place", { index: walk.index + 1, total: walk.total })}
            </Text>
            <Pressable
              disabled={!walk.next}
              onPress={stepNext}
              style={[styles.stepButton, !walk.next && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel={t("bots.items.view.next")}
              testID="bot-item-next"
            >
              <ThemedRight size={14} uniProps={mutedColor} />
            </Pressable>
          </View>
        ) : null}
      </View>
      {deleted ? (
        <Text style={[itemStyles.muted, styles.notice]}>{t("bots.items.view.deleted")}</Text>
      ) : null}
      {!item && read.isError && !deleted ? (
        <View style={styles.notice}>
          <Text style={itemStyles.muted}>{t("bots.items.readFailed")}</Text>
          <Button size="xs" variant="outline" onPress={retry}>
            {t("bots.items.retry")}
          </Button>
        </View>
      ) : null}
      {!item && !read.isError ? (
        <Text style={[itemStyles.muted, styles.notice]}>{t("bots.items.view.loading")}</Text>
      ) : null}
      {item ? (
        <BotItemBody
          key={item.id}
          serverId={serverId}
          bot={bot}
          item={item}
          events={read.data?.events}
          deleted={deleted}
        />
      ) : null}
    </View>
  );
}

function BotItemBody({
  serverId,
  bot,
  item,
  events,
  deleted,
}: {
  serverId: string;
  bot: Bot;
  item: BotItem;
  /** Undefined while the item's read is under way: no false "No comments yet." */
  events: readonly BotItemEvent[] | undefined;
  deleted: boolean;
}) {
  const { t } = useTranslation();
  const actions = useBotItemActions(serverId, bot);
  const snoozing = useBotItemSnoozing(actions);
  const [canceling, setCanceling] = useState(false);
  const [comment, setComment] = useState("");
  const [commentKey, setCommentKey] = useState(0);
  const chatTitle = botItemChatName(item.chat, t);
  const question = item.status === "needs_you" ? item.question : undefined;

  const setStatus = useCallback(
    (status: BotItemStatus) => {
      if (status === "canceled") setCanceling(true);
      else void actions.move([item], status);
    },
    [actions, item],
  );
  const sendComment = useCallback(async () => {
    const text = comment.trim();
    if (!text) return;
    if (await actions.comment(item, text)) {
      setComment("");
      setCommentKey((value) => value + 1);
    }
  }, [comment, actions, item]);
  const submitComment = useCallback(() => void sendComment(), [sendComment]);
  const confirmCancel = useCallback(
    (reason: string) => {
      setCanceling(false);
      void actions.cancel([item], reason);
    },
    [actions, item],
  );
  const closeCancel = useCallback(() => setCanceling(false), []);
  const cancelItems = useMemo(() => (canceling ? [item] : null), [canceling, item]);
  const sendAnswers = useCallback(
    (text: string, answers: readonly (string | null)[]) => {
      // After two review rounds the owner may wave the reviews through (spec 37.3.7 step 3).
      if (item.review && answers.includes(MARK_DONE_ANYWAY)) {
        void actions.done([item], true);
        return;
      }
      void actions.comment(item, text);
    },
    [actions, item],
  );
  const openChat = useCallback(() => {
    const chat = item.chat;
    if (chat && chat.kind !== "home") navigateToAgent({ serverId, agentId: chat.id });
  }, [item.chat, serverId]);

  return (
    <>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <BotItemHeader
          serverId={serverId}
          bot={bot}
          item={item}
          chatTitle={chatTitle}
          deleted={deleted}
          onStatus={setStatus}
          snoozing={snoozing}
        />
        {item.description ? <ClampedText text={item.description} /> : null}
        {(item.status === "done" || item.status === "canceled") && item.closeNote ? (
          <Text style={styles.closeNote}>
            <Text style={styles.closeLabel}>
              {item.status === "done"
                ? t("bots.items.view.doneNote")
                : t("bots.items.view.canceledNote")}
            </Text>{" "}
            {item.closeNote}
          </Text>
        ) : null}
        <View style={styles.fields}>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t("bots.items.field.chat")}</Text>
            <Pressable
              onPress={openChat}
              disabled={!item.chat || item.chat.kind === "home"}
              accessibilityRole="button"
              style={styles.fieldValue}
            >
              <Text style={styles.fieldText} numberOfLines={1}>
                {chatTitle}
              </Text>
            </Pressable>
          </View>
          {item.doneMeans ? (
            <View style={styles.doneMeans} testID="bot-item-done-means">
              <Text style={styles.fieldLabel}>{t("bots.items.field.doneMeans")}</Text>
              <Text selectable style={styles.fieldText}>
                {item.doneMeans}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.activity}>
          <Text style={styles.sectionTitle}>{t("bots.items.view.activity")}</Text>
          {events ? <BotItemActivityList bot={bot} item={item} events={events} /> : null}
        </View>
        <ItemAsk
          question={deleted ? undefined : question}
          docked={false}
          disabled={actions.pending}
          onSend={sendAnswers}
        />
      </ScrollView>
      <ItemAsk
        question={deleted ? undefined : question}
        docked
        disabled={actions.pending}
        onSend={sendAnswers}
      />
      {deleted ? null : (
        <View style={styles.commentBox}>
          <FormTextInput
            key={commentKey}
            value={comment}
            initialValue=""
            webControlled
            multiline
            onChangeText={setComment}
            placeholder={
              question ? t("bots.items.comment.replyOrPick") : t("bots.items.comment.add")
            }
            accessibilityLabel={t("bots.items.comment.label")}
            size="sm"
            style={styles.commentInput}
            testID="bot-item-comment-input"
          />
          <Button
            size="sm"
            variant="default"
            disabled={!comment.trim()}
            loading={actions.pending}
            onPress={submitComment}
            accessibilityLabel={t("bots.items.comment.submit")}
            testID="bot-item-comment-submit"
          >
            {t("bots.items.comment.submit")}
          </Button>
        </View>
      )}
      <BotItemCancelDialog items={cancelItems} onCancel={confirmCancel} onClose={closeCancel} />
      {snoozing.dialog}
    </>
  );
}

/**
 * The waiting ask: the question steps in the item on a desktop, the quick-reply card docked over the
 * comment box on a phone (spec 37.6). `docked` is the place this one renders in.
 */
function ItemAsk({
  question,
  docked,
  disabled,
  onSend,
}: {
  question: BotItem["question"];
  docked: boolean;
  disabled: boolean;
  onSend: (text: string, answers: readonly (string | null)[]) => void;
}) {
  const compact = useIsCompactFormFactor();
  const decisions = question?.decisions ?? [];
  if (!question || decisions.length === 0 || compact !== docked) return null;
  return docked ? (
    <PhoneItemAskCard
      key={question.eventId}
      decisions={decisions}
      disabled={disabled}
      onSend={onSend}
    />
  ) : (
    <BotItemQuestionStep
      key={question.eventId}
      decisions={decisions}
      disabled={disabled}
      onSend={onSend}
    />
  );
}

function BotItemHeader({
  serverId,
  bot,
  item,
  chatTitle,
  deleted,
  onStatus,
  snoozing,
}: {
  serverId: string;
  bot: Bot;
  item: BotItem;
  chatTitle: string;
  deleted: boolean;
  onStatus: (status: BotItemStatus) => void;
  snoozing: BotItemSnoozing;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow(60_000);
  const snoozed = isBotItemSnoozed(item, now);
  const items = useMemo(() => [item], [item]);
  const pages = useMemo(
    () =>
      isOpenBotItemStatus(item.status)
        ? [botItemSnoozePage(t("bots.items.snooze.menu"), items, snoozing)]
        : [],
    [item.status, items, snoozing, t],
  );
  const unsnooze = useCallback(() => snoozing.snooze(items, null), [snoozing, items]);
  const created = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(
    item.createdAt_ms,
  );
  return (
    <View style={styles.header}>
      <Text style={styles.title} testID="bot-item-title">
        {item.number !== undefined ? (
          <Text style={styles.titleNumber}>{formatBotItemNumber(item.number)} </Text>
        ) : null}
        {item.title}
      </Text>
      <View style={styles.statusRow}>
        <DropdownMenu>
          <DropdownMenuTrigger
            style={styles.statusButton}
            disabled={deleted}
            accessibilityLabel={botItemStatusName(item.status, t)}
            testID="bot-item-status"
          >
            <BotItemStatusIcon status={item.status} live={isBotItemLive(item)} />
            <Text style={styles.statusText}>{botItemStatusName(item.status, t)}</Text>
            <ThemedDown size={12} uniProps={mutedColor} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" width={220} pages={pages}>
            {BOT_ITEM_PICKER_STATUSES.map((status) => (
              <BotItemStatusMenuItem
                key={status}
                status={status}
                current={item.status}
                onPick={onStatus}
              />
            ))}
            {isOpenBotItemStatus(item.status) ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSubTrigger id={SNOOZE_PAGE}>
                  {t("bots.items.snooze.menu")}
                </DropdownMenuSubTrigger>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <Text style={itemStyles.muted} numberOfLines={1} testID="bot-item-where">
          {t("bots.items.view.subWhere", { number: item.number ?? "", chat: chatTitle })} ·{" "}
          {created}
        </Text>
      </View>
      {isBotItemAwaitingReview(item) ? (
        <Text style={styles.review}>{t("bots.jad.items.waitingForReview")}</Text>
      ) : null}
      {snoozed && item.snoozedUntil_ms !== undefined ? (
        <View style={styles.snoozed} testID="bot-item-snoozed">
          <Text style={[itemStyles.muted, styles.flex]} numberOfLines={1}>
            {t("bots.items.snooze.until", {
              when: formatBotItemSnoozeTime(item.snoozedUntil_ms, now, i18n.language),
            })}
          </Text>
          <Button
            size="xs"
            variant="outline"
            disabled={deleted}
            onPress={unsnooze}
            testID="bot-item-unsnooze"
          >
            {t("bots.items.snooze.unsnooze")}
          </Button>
        </View>
      ) : null}
      <BotItemLinkChips serverId={serverId} bot={bot} links={item.links} />
    </View>
  );
}

/** The description, folded to three lines behind "Show more". */
function ClampedText({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const long = text.length > 240 || text.split("\n").length > 3;
  return (
    <View>
      <Text selectable style={styles.description} numberOfLines={open || !long ? undefined : 3}>
        {text}
      </Text>
      {long ? (
        <Pressable onPress={toggle} accessibilityRole="button" style={styles.more}>
          <Text style={itemStyles.muted}>
            {open ? t("bots.items.view.showLess") : t("bots.items.view.showMore")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  pane: { flex: 1, minHeight: 0 },
  backRow: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 32,
    paddingHorizontal: 6,
    borderRadius: 8,
  },
  backText: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  stepper: { flexDirection: "row", alignItems: "center", gap: 2 },
  stepButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  disabled: { opacity: 0.35 },
  place: { fontSize: 12, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  scroll: { flex: 1 },
  content: { gap: 16, paddingHorizontal: 14, paddingBottom: 16 },
  header: {
    gap: 6,
    paddingTop: 4,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: { fontSize: 15, lineHeight: 21, fontWeight: "600", color: theme.colors.foreground },
  titleNumber: { fontWeight: "400", color: theme.colors.foregroundMuted },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 26,
    paddingHorizontal: 6,
    marginLeft: -6,
    borderRadius: 6,
  },
  statusText: { fontSize: 12, fontWeight: "500", color: theme.colors.foreground },
  review: { fontSize: 12, color: theme.colors.statusWarning },
  snoozed: { flexDirection: "row", alignItems: "center", gap: 6 },
  flex: { flex: 1 },
  description: { fontSize: 13, lineHeight: 19, color: theme.colors.foreground },
  more: { alignSelf: "flex-start", paddingTop: 2 },
  closeNote: { fontSize: 13, lineHeight: 19, color: theme.colors.foreground },
  closeLabel: { color: theme.colors.foregroundMuted },
  fields: { gap: 6 },
  field: { flexDirection: "row", alignItems: "center", gap: 8 },
  fieldLabel: { width: 84, fontSize: 12, lineHeight: 18, color: theme.colors.foregroundMuted },
  fieldValue: { flex: 1, minWidth: 0 },
  fieldText: { fontSize: 12, lineHeight: 18, color: theme.colors.foreground },
  doneMeans: {
    gap: 2,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  activity: { gap: 6 },
  sectionTitle: { fontSize: 12, color: theme.colors.foregroundMuted },
  commentBox: {
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    alignItems: "stretch",
  },
  commentInput: { minHeight: 56 },
}));
