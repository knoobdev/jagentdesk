// The Home panel's Items (spec 37.4.4 item 3): Needs you first (led by the asks), then In progress,
// Waiting, Planned, Snoozed, Stale and Closed; Planned, Snoozed, Stale and Closed folded. Each shows
// five rows, then "Show N more". Checked rows get the selection bar; Stale's header cancels them all.
// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/items/BotItemsSection.tsx:1-171,
// BotItemsList.tsx:62-435, BotItemsFilter.tsx:46-214, BotItemsAllClear.tsx and
// use-bot-items-seen-mark.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ListChecks, ListFilter, X } from "lucide-react-native";
import {
  BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT,
  BOT_ITEM_GROUP_IDS,
  BOT_ITEM_GROUP_ROWS,
  botItemStaleDays,
  groupBotItems,
  type BotItemGroupId,
} from "@jagentdesk/protocol/bots/rules";
import type { Bot, BotItem, BotItemStatus } from "@jagentdesk/protocol/bots/types";
import type { BotNeedsYouRow } from "@jagentdesk/protocol/bots/views";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { useBotsMutation, useItems, useNeedsYou } from "@/bots/queries";
import { useBotPanel, useBotPanelStore } from "@/bots/panel-store";
import type { Theme } from "@/styles/theme";
import { useBotItemActions } from "./item-actions";
import { BotItemCancelDialog } from "./cancel-dialog";
import { BotPanelSectionHeader, foregroundColor, itemStyles, mutedColor } from "./item-parts";
import { BotItemRow, type BotItemRowAction } from "./item-row";
import {
  botItemChatName,
  botItemChats,
  botItemGroupName,
  filterBotItems,
  isBotItemFilterOn,
  isBotItemUnseen,
} from "./item-rules";
import { BotNeedsYouSection } from "./needs-you-section";
import { BotItemSelectionPill } from "./selection-pill";
import { useBotItemSnoozing } from "./snooze";
import { useNow } from "./use-now";

const ThemedFilter = withUnistyles(ListFilter);
const ThemedListChecks = withUnistyles(ListChecks);
const ThemedX = withUnistyles(X);

/** The panel's filter, as Items reads it. */
function useItemFilter(botId: string) {
  const { filters } = useBotPanel(botId);
  return useMemo(
    () => ({ needsYouOnly: filters.needsYouOnly, chatId: filters.chatId }),
    [filters.needsYouOnly, filters.chatId],
  );
}

export function BotItemsSection({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const itemsRead = useItems(serverId, bot.id);
  const asksRead = useNeedsYou(serverId, bot.id);
  const filter = useItemFilter(bot.id);
  const now = useNow(60_000);
  const actions = useBotItemActions(serverId, bot);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const snoozing = useBotItemSnoozing(actions, clearSelection);
  const [canceling, setCanceling] = useState<readonly BotItem[] | null>(null);
  // "{{count}} new" reads the seen mark the tab opened with; showing the list moves the mark on.
  const [seen_ms] = useState(bot.itemsSeen_ms);
  useMarkItemsSeen(serverId, bot.id, itemsRead.isSuccess);

  const items = itemsRead.data;
  // The asks lead Needs you whatever the filter; its item rows come from the item list.
  const asks = useMemo(
    () => (asksRead.data ?? []).filter((row) => row.kind !== "item"),
    [asksRead.data],
  );
  const staleDays = botItemStaleDays(bot.itemsStale);
  const shown = useMemo(() => filterBotItems(items ?? [], filter), [items, filter]);
  const groups = useMemo(() => groupBotItems(shown, staleDays, now), [shown, staleDays, now]);
  const ordered = useMemo(() => BOT_ITEM_GROUP_IDS.flatMap((id) => groups[id]), [groups]);
  const selectedItems = useMemo(
    () => ordered.filter((item) => selected.has(item.id)),
    [ordered, selected],
  );

  const toggleSelect = useCallback((item: BotItem) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }, []);
  const onAction = useCallback(
    (item: BotItem, action: BotItemRowAction) => {
      if (action === "open") useBotPanelStore.getState().openItem(bot.id, item.id);
      else if (action === "done") void actions.done([item]);
      else setCanceling([item]);
    },
    [bot.id, actions],
  );
  const onMove = useCallback(
    (item: BotItem, status: BotItemStatus) => void actions.move([item], status),
    [actions],
  );
  const moveSelected = useCallback(
    (status: BotItemStatus) => {
      if (status === "canceled") {
        setCanceling(selectedItems);
        return;
      }
      void actions.move(selectedItems, status).then((ok) => ok && clearSelection());
    },
    [actions, selectedItems, clearSelection],
  );
  const confirmCancel = useCallback(
    (reason: string) => {
      const target = canceling ?? [];
      setCanceling(null);
      void actions.cancel(target, reason).then((ok) => ok && clearSelection());
    },
    [canceling, actions, clearSelection],
  );
  const closeCancel = useCallback(() => setCanceling(null), []);

  const renderRow = useCallback(
    (item: BotItem, groupId: BotItemGroupId) => (
      <BotItemRow
        key={item.id}
        item={item}
        stale={groupId === "stale"}
        snoozed={groupId === "snoozed"}
        unseen={isBotItemUnseen(item, seen_ms)}
        selected={selected.has(item.id)}
        selecting={selected.size > 0}
        now={now}
        snoozing={snoozing}
        onSelect={toggleSelect}
        onAction={onAction}
        onMove={onMove}
      />
    ),
    [seen_ms, selected, now, snoozing, toggleSelect, onAction, onMove],
  );

  const { refetch } = itemsRead;
  const retry = useCallback(() => void refetch(), [refetch]);
  const clearFilters = useCallback(
    () => useBotPanelStore.getState().setFilters(bot.id, { needsYouOnly: false, chatId: null }),
    [bot.id],
  );
  const cancelAll = useCallback(
    (rows: readonly BotItem[], reason: string) => void actions.cancel(rows, reason),
    [actions],
  );
  const filtered = isBotItemFilterOn(filter);
  const asking = asks.length > 0;
  let note: React.ReactNode = null;
  if (!items) {
    note = itemsRead.isError ? (
      <View style={styles.notice}>
        <Text style={itemStyles.muted}>{t("bots.items.readFailed")}</Text>
        <Button size="xs" variant="outline" onPress={retry}>
          {t("bots.items.retry")}
        </Button>
      </View>
    ) : (
      <Text style={[itemStyles.muted, styles.centerNote]}>{t("bots.items.loading")}</Text>
    );
  } else if (items.length === 0 && !filtered) {
    note = asking ? (
      <Text style={[itemStyles.muted, styles.centerNote]}>
        {t("bots.items.empty.short", { bot: bot.name })}
      </Text>
    ) : (
      <View style={styles.empty} testID="bot-items-empty">
        <ThemedListChecks size={20} uniProps={mutedColor} />
        <Text style={styles.emptyTitle}>{t("bots.items.empty.title")}</Text>
        <Text style={[itemStyles.muted, styles.emptyBody]}>
          {t("bots.items.empty.body", { bot: bot.name })}
        </Text>
      </View>
    );
  } else if (filtered && shown.length === 0 && !asking) {
    note = (
      <View style={styles.empty}>
        <Text style={itemStyles.muted}>{t("bots.items.empty.needsYou")}</Text>
        <Button size="xs" variant="outline" onPress={clearFilters}>
          {t("bots.items.filter.clearAll")}
        </Button>
      </View>
    );
  }
  // Nothing waits on the owner and nothing is under way: one quiet line leads the folded groups.
  const allClear =
    items !== undefined &&
    items.length > 0 &&
    !asking &&
    !filtered &&
    !bot.paused &&
    groups.needs_you.length === 0 &&
    groups.working.length === 0;

  return (
    <View style={styles.section} testID="bot-items">
      {allClear ? (
        <Text style={[itemStyles.muted, styles.allClear]} testID="bot-items-all-clear">
          {t("bots.items.empty.allClear")}
        </Text>
      ) : null}
      {items
        ? BOT_ITEM_GROUP_IDS.map((id) => (
            <BotItemGroup
              key={id}
              id={id}
              serverId={serverId}
              bot={bot}
              items={groups[id]}
              asks={id === "needs_you" ? asks : []}
              seen_ms={seen_ms}
              staleDays={staleDays}
              renderRow={renderRow}
              onCancelAll={cancelAll}
            />
          ))
        : null}
      {note}
      {selectedItems.length > 0 ? (
        <BotItemSelectionPill
          items={selectedItems}
          snoozing={snoozing}
          onMove={moveSelected}
          onClear={clearSelection}
        />
      ) : null}
      <BotItemCancelDialog items={canceling} onCancel={confirmCancel} onClose={closeCancel} />
      {snoozing.dialog}
    </View>
  );
}

/** Moves the bot's seen mark once the list has shown (Orca `use-bot-items-seen-mark.ts`). */
function useMarkItemsSeen(serverId: string, botId: string, ready: boolean) {
  const mark = useBotsMutation(serverId, "bots.items.mark_seen.request");
  const marked = useRef<string | null>(null);
  const { mutate } = mark;
  useEffect(() => {
    if (!ready || marked.current === botId) return;
    marked.current = botId;
    mutate({ botId });
  }, [ready, botId, mutate]);
}

function BotItemGroup({
  id,
  serverId,
  bot,
  items,
  asks,
  seen_ms,
  staleDays,
  renderRow,
  onCancelAll,
}: {
  id: BotItemGroupId;
  serverId: string;
  bot: Bot;
  items: BotItem[];
  asks: readonly BotNeedsYouRow[];
  seen_ms: number | undefined;
  staleDays: number | null;
  renderRow: (item: BotItem, groupId: BotItemGroupId) => React.ReactNode;
  onCancelAll: (items: readonly BotItem[], reason: string) => void;
}) {
  const { t } = useTranslation();
  const foldedByDefault = BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT.has(id);
  const [open, setOpen] = useState(!foldedByDefault);
  const [shown, setShown] = useState(BOT_ITEM_GROUP_ROWS);
  const [confirming, setConfirming] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const startConfirm = useCallback(() => setConfirming(true), []);
  const keep = useCallback(() => setConfirming(false), []);
  const renderNeed = useCallback((item: BotItem) => renderRow(item, id), [renderRow, id]);
  const showMore = useCallback(
    () => setShown((value) => value + Math.max(BOT_ITEM_GROUP_ROWS, items.length)),
    [items.length],
  );
  const confirmAll = useCallback(() => {
    setConfirming(false);
    onCancelAll(
      items,
      staleDays === null ? "" : t("bots.items.stale.reason", { count: staleDays }),
    );
  }, [onCancelAll, items, staleDays, t]);
  const cancelAllAction = useMemo(
    () =>
      id === "stale" && items.length > 0 && staleDays !== null ? (
        <Button
          size="xs"
          variant="ghost"
          onPress={startConfirm}
          testID="bot-items-stale-cancel-all"
        >
          {t("bots.items.stale.cancelAll")}
        </Button>
      ) : null,
    [id, items.length, staleDays, startConfirm, t],
  );
  const needsYou = id === "needs_you";
  const askCount = needsYou ? asks.length : 0;
  const count = items.length + askCount;
  if (count === 0) return null;
  const fresh = items.filter((item) => isBotItemUnseen(item, seen_ms)).length;
  const more = items.length - Math.min(shown, items.length);
  const staleReason = staleDays === null ? "" : t("bots.items.stale.reason", { count: staleDays });
  const summary = open ? null : (
    <>
      {count}
      {fresh > 0 ? ` · ${t("bots.items.group.new", { count: fresh })}` : ""}
    </>
  );
  let openSummary: React.ReactNode = needsYou ? null : String(count);
  if (!open) openSummary = summary;

  return (
    <View style={styles.group} testID={`bot-items-group-${id}`}>
      <BotPanelSectionHeader
        title={botItemGroupName(id, t)}
        summary={openSummary}
        open={open}
        onToggle={toggle}
        actions={cancelAllAction}
      />
      {confirming ? (
        <View style={styles.confirm} testID="bot-items-stale-confirm">
          <Text style={styles.confirmTitle}>
            {t("bots.items.stale.confirm", { count: items.length })}
          </Text>
          <Text style={itemStyles.muted}>
            {t("bots.items.stale.confirmWhy", { reason: staleReason })}
          </Text>
          <View style={styles.confirmActions}>
            <Button size="xs" variant="ghost" onPress={keep}>
              {t("bots.items.cancel.keep")}
            </Button>
            <Button
              size="xs"
              variant="default"
              onPress={confirmAll}
              testID="bot-items-stale-confirm-button"
            >
              {t("bots.items.cancel.confirmMany", { count: items.length })}
            </Button>
          </View>
        </View>
      ) : null}
      {open && needsYou ? (
        <BotNeedsYouSection
          serverId={serverId}
          bot={bot}
          asks={asks}
          items={items}
          renderItem={renderNeed}
        />
      ) : null}
      {open && !needsYou ? (
        <>
          {items.slice(0, shown).map((item) => renderRow(item, id))}
          {more > 0 ? (
            <Pressable style={itemStyles.showMore} onPress={showMore} accessibilityRole="button">
              <Text style={itemStyles.muted}>
                {t("bots.items.group.showMore", { count: more })}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const CHAT_PAGE = "chat";

/** The header's "Filter items": Needs you only, and one chat. A dot on the icon while on. */
export function BotItemsFilterButton({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const items = useItems(serverId, bot.id).data;
  const filter = useItemFilter(bot.id);
  const on = isBotItemFilterOn(filter);
  const needsYou = useMemo(
    () => (items ?? []).filter((item) => item.status === "needs_you").length,
    [items],
  );
  const chats = useMemo(() => botItemChats(items ?? []), [items]);
  const setFilters = useCallback(
    (next: Partial<typeof filter>) => useBotPanelStore.getState().setFilters(bot.id, next),
    [bot.id],
  );
  const pickChat = useCallback(
    (chatId: string) => setFilters({ chatId: filter.chatId === chatId ? null : chatId }),
    [setFilters, filter.chatId],
  );
  const toggleNeedsYou = useCallback(
    () => setFilters({ needsYouOnly: !filter.needsYouOnly }),
    [setFilters, filter.needsYouOnly],
  );
  const clearAll = useCallback(
    () => setFilters({ needsYouOnly: false, chatId: null }),
    [setFilters],
  );
  const countTrailing = useMemo(
    () => <Text style={styles.filterCount}>{needsYou}</Text>,
    [needsYou],
  );
  const pages = useMemo<MenuPageDefinition[]>(
    () => [
      {
        id: CHAT_PAGE,
        title: t("bots.items.filter.chat"),
        content: (
          <>
            {chats.map((chat) => (
              <ChatFilterItem
                key={chat.id}
                chat={chat}
                selected={filter.chatId === chat.id}
                onPick={pickChat}
              />
            ))}
          </>
        ),
      },
    ],
    [chats, filter.chatId, pickChat, t],
  );
  const label = t("bots.items.filter.label");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.filterButton}
        accessibilityLabel={label}
        testID="bot-items-filter"
      >
        <ThemedFilter size={16} uniProps={foregroundColor} />
        {on ? <View style={styles.filterDot} /> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={240} pages={chats.length > 0 ? pages : undefined}>
        <DropdownMenuItem
          selected={filter.needsYouOnly}
          showSelectedCheck
          closeOnSelect={false}
          trailing={countTrailing}
          onSelect={toggleNeedsYou}
          testID="bot-items-filter-needs-you"
        >
          {t("bots.items.filter.needsYou")}
        </DropdownMenuItem>
        {chats.length > 0 ? (
          <DropdownMenuSubTrigger
            id={CHAT_PAGE}
            value={
              filter.chatId
                ? botItemChatName(
                    chats.find((chat) => chat.id === filter.chatId),
                    t,
                  )
                : undefined
            }
          >
            {t("bots.items.filter.chat")}
          </DropdownMenuSubTrigger>
        ) : null}
        {on ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={clearAll}>
              {t("bots.items.filter.clearAll")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The chips of the filters that are on, each removable, and "Clear filters" with two or more. */
export function BotItemsFilterChips({ bot, serverId }: { bot: Bot; serverId?: string }) {
  const { t } = useTranslation();
  const filter = useItemFilter(bot.id);
  // The bot page passes no host; its route names one.
  const routeServerId = useHostRouteServerId();
  const items = useItems(serverId ?? routeServerId ?? "", bot.id).data;
  const setFilters = useCallback(
    (next: Partial<typeof filter>) => useBotPanelStore.getState().setFilters(bot.id, next),
    [bot.id],
  );
  const clearChips = useCallback(
    () => setFilters({ needsYouOnly: false, chatId: null }),
    [setFilters],
  );
  if (!isBotItemFilterOn(filter)) return null;
  const chat = filter.chatId
    ? (items ?? []).find((item) => item.chat?.id === filter.chatId)?.chat
    : undefined;
  const chips: { key: string; name: string; remove: () => void }[] = [];
  if (filter.needsYouOnly)
    chips.push({
      key: "needs-you",
      name: t("bots.items.status.needsYou"),
      remove: () => setFilters({ needsYouOnly: false }),
    });
  if (filter.chatId)
    chips.push({
      key: "chat",
      name: chat ? botItemChatName(chat, t) : t("bots.items.filter.chat"),
      remove: () => setFilters({ chatId: null }),
    });
  return (
    <View style={styles.chips} testID="bot-items-filter-chips">
      {chips.map((chip) => (
        <View key={chip.key} style={styles.chip}>
          <Text style={styles.chipText} numberOfLines={1}>
            {chip.name}
          </Text>
          <Pressable
            onPress={chip.remove}
            style={styles.chipRemove}
            accessibilityRole="button"
            accessibilityLabel={t("bots.items.filter.remove", { name: chip.name })}
          >
            <ThemedX size={12} uniProps={mutedColor} />
          </Pressable>
        </View>
      ))}
      {chips.length > 1 ? (
        <Button size="xs" variant="ghost" onPress={clearChips}>
          {t("bots.items.filter.clearAll")}
        </Button>
      ) : null}
    </View>
  );
}

function ChatFilterItem({
  chat,
  selected,
  onPick,
}: {
  chat: NonNullable<BotItem["chat"]>;
  selected: boolean;
  onPick: (chatId: string) => void;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => onPick(chat.id), [onPick, chat.id]);
  return (
    <DropdownMenuItem selected={selected} showSelectedCheck onSelect={select}>
      {botItemChatName(chat, t)}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  section: { gap: 8 },
  group: { gap: 2 },
  allClear: { paddingHorizontal: 8 },
  notice: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 },
  centerNote: { textAlign: "center", paddingHorizontal: 24, paddingVertical: 6 },
  empty: { alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 40 },
  emptyTitle: { fontSize: 13, fontWeight: "500", color: theme.colors.foreground },
  emptyBody: { textAlign: "center" },
  confirm: {
    marginHorizontal: 4,
    marginVertical: 4,
    gap: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  confirmTitle: { fontSize: 12, fontWeight: "500", color: theme.colors.foreground },
  confirmActions: { flexDirection: "row", justifyContent: "flex-end", gap: 4 },
  filterButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  filterDot: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.foreground,
  },
  filterCount: { fontSize: 12, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
  },
  chip: {
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingLeft: 8,
    paddingRight: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipText: { fontSize: 12, color: theme.colors.foreground, maxWidth: 200 },
  chipRemove: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
}));
