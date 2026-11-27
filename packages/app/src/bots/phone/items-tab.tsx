// The phone bot panel's Items tab (spec 37.6): the asks leading Needs you whatever the item read says,
// then the bot's items grouped as the desktop groups them (Needs you, In progress, Waiting open;
// Planned, Snoozed, Stale and Closed folded; a group with no rows not shown), five rows then "Show N
// more". Long-press opens a row's actions (Done, Snooze, Cancel…, Move to); a tap opens its page.
// Automations and Suggestions follow, as on the desktop's Home panel.
// Ported from Orca dfdb4fda (MIT) mobile/src/bots/items/MobileBotItemsTab.tsx:47-358.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ListChecks, X } from "lucide-react-native";
import {
  BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT,
  BOT_ITEM_GROUP_IDS,
  BOT_ITEM_GROUP_ROWS,
  botItemStaleDays,
  groupBotItems,
  type BotItemGroupId,
} from "@jagentdesk/protocol/bots/rules";
import type { Bot, BotItem, BotItemStatus } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { useBotsConnection, useBotsMutation, useItems, useNeedsYou } from "@/bots/queries";
import { useBotPanel, useBotPanelStore } from "@/bots/panel-store";
import { useBotItemActions } from "@/bots/items/item-actions";
import { BotItemCancelDialog } from "@/bots/items/cancel-dialog";
import { useBotItemSnoozing } from "@/bots/items/snooze";
import { useNow } from "@/bots/items/use-now";
import { botItemGroupName, filterBotItems, isBotItemUnseen } from "@/bots/items/item-rules";
import { BotAutomationsSection } from "@/bots/panel/automations-section";
import { BotSuggestionsSection } from "@/bots/panel/suggestions-section";
import { BotPausedBanner } from "@/bots/panel/paused-banner";
import { PhoneBotItemRow } from "./item-row";
import { PhoneBotItemSheet } from "./item-sheet";
import { PhoneNeedsYouGroup } from "./needs-you-group";
import { PhoneSectionHeader } from "./section-header";

const ThemedX = withUnistyles(X);
const ThemedListChecks = withUnistyles(ListChecks);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });

export function PhoneBotItemsTab({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const itemsRead = useItems(serverId, bot.id);
  const asksRead = useNeedsYou(serverId, bot.id);
  const { connected } = useBotsConnection(serverId);
  const { filters } = useBotPanel(bot.id);
  const now = useNow(60_000);
  const actions = useBotItemActions(serverId, bot);
  const snoozing = useBotItemSnoozing(actions);
  const [sheetItems, setSheetItems] = useState<readonly BotItem[] | null>(null);
  const [canceling, setCanceling] = useState<readonly BotItem[] | null>(null);
  // "{{count}} new" reads the seen mark the tab opened with; showing the list moves it on.
  const [seen_ms] = useState(bot.itemsSeen_ms);
  useMarkItemsSeen(serverId, bot.id, itemsRead.isSuccess);

  const items = itemsRead.data;
  const asks = useMemo(
    () => (asksRead.data ?? []).filter((row) => row.kind !== "item"),
    [asksRead.data],
  );
  const filter = useMemo(
    () => ({ needsYouOnly: filters.needsYouOnly, chatId: null }),
    [filters.needsYouOnly],
  );
  const staleDays = botItemStaleDays(bot.itemsStale);
  const shown = useMemo(() => filterBotItems(items ?? [], filter), [items, filter]);
  const groups = useMemo(() => groupBotItems(shown, staleDays, now), [shown, staleDays, now]);
  const disabled = !connected;

  const openItem = useCallback(
    (item: BotItem) => useBotPanelStore.getState().openItem(bot.id, item.id),
    [bot.id],
  );
  const openActions = useCallback((item: BotItem) => setSheetItems([item]), []);
  const closeSheet = useCallback(() => setSheetItems(null), []);
  const done = useCallback((rows: readonly BotItem[]) => void actions.done(rows), [actions]);
  const move = useCallback(
    (rows: readonly BotItem[], status: BotItemStatus) => void actions.move(rows, status),
    [actions],
  );
  const confirmCancel = useCallback(
    (reason: string) => {
      const target = canceling ?? [];
      setCanceling(null);
      void actions.cancel(target, reason);
    },
    [canceling, actions],
  );
  const closeCancel = useCallback(() => setCanceling(null), []);
  const cancelAll = useCallback(
    (rows: readonly BotItem[], reason: string) => void actions.cancel(rows, reason),
    [actions],
  );
  const clearFilter = useCallback(
    () => useBotPanelStore.getState().setFilters(bot.id, { needsYouOnly: false, chatId: null }),
    [bot.id],
  );
  const { refetch } = itemsRead;
  const retry = useCallback(() => void refetch(), [refetch]);

  const renderRow = useCallback(
    (item: BotItem, groupId: BotItemGroupId) => (
      <PhoneBotItemRow
        key={item.id}
        item={item}
        stale={groupId === "stale"}
        snoozed={groupId === "snoozed"}
        unseen={isBotItemUnseen(item, seen_ms)}
        now={now}
        disabled={disabled}
        onOpen={openItem}
        onActions={openActions}
      />
    ),
    [seen_ms, now, disabled, openItem, openActions],
  );
  const renderNeed = useCallback((item: BotItem) => renderRow(item, "needs_you"), [renderRow]);

  const filtered = filters.needsYouOnly;
  const chip = filtered ? (
    <FilterChip label={t("bots.phone.bots.items.filter.needsYou")} onClear={clearFilter} />
  ) : null;
  const asksOnly = (
    <PhoneNeedsYouGroup
      serverId={serverId}
      bot={bot}
      asks={asks}
      items={[]}
      disabled={disabled}
      renderItem={renderNeed}
    />
  );
  let body;
  if (!items) {
    body = (
      <>
        {asksOnly}
        {itemsRead.isError ? (
          <View style={styles.state}>
            <Text style={styles.stateTitle}>{t("bots.phone.bots.items.readFailedTitle")}</Text>
            <Button size="sm" variant="outline" onPress={retry}>
              {t("bots.phone.bots.items.retry")}
            </Button>
          </View>
        ) : (
          <Text style={styles.loading}>{t("bots.phone.bots.items.loading")}</Text>
        )}
      </>
    );
  } else if (items.length === 0 && !filtered) {
    body = (
      <>
        {asks.length > 0 ? asksOnly : null}
        <View style={styles.state} testID="phone-bot-items-empty">
          <ThemedListChecks size={22} uniProps={muted} />
          <Text style={styles.stateTitle}>{t("bots.phone.bots.items.empty.title")}</Text>
          <Text style={styles.stateBody}>
            {t("bots.phone.bots.items.empty.body", { bot: bot.name })}
          </Text>
        </View>
      </>
    );
  } else if (shown.length === 0 && asks.length > 0) {
    body = asksOnly;
  } else if (shown.length === 0) {
    body = (
      <View style={styles.state}>
        <Text style={styles.stateBody}>{t("bots.phone.bots.items.empty.needsYou")}</Text>
        <Button size="sm" variant="outline" onPress={clearFilter}>
          {t("bots.phone.bots.items.filter.clear")}
        </Button>
      </View>
    );
  } else {
    body = BOT_ITEM_GROUP_IDS.map((id) =>
      id === "needs_you" ? (
        <PhoneNeedsYouGroup
          key={id}
          serverId={serverId}
          bot={bot}
          asks={asks}
          items={groups.needs_you}
          disabled={disabled}
          renderItem={renderNeed}
        />
      ) : (
        <ItemGroup
          key={id}
          id={id}
          items={groups[id]}
          seen_ms={seen_ms}
          staleDays={staleDays}
          disabled={disabled}
          renderRow={renderRow}
          onCancelAll={cancelAll}
        />
      ),
    );
  }
  return (
    <View testID="phone-bot-items">
      {bot.paused ? <BotPausedBanner serverId={serverId} bot={bot} /> : null}
      {chip}
      <View style={disabled && items ? styles.dimmed : undefined}>{body}</View>
      <View style={styles.after}>
        <BotAutomationsSection serverId={serverId} bot={bot} />
        <BotSuggestionsSection serverId={serverId} bot={bot} />
      </View>
      <PhoneBotItemSheet
        items={sheetItems}
        onClose={closeSheet}
        onDone={done}
        onMove={move}
        onSnooze={snoozing.snooze}
        onPickSnooze={snoozing.pick}
        onCancel={setCanceling}
      />
      <BotItemCancelDialog items={canceling} onCancel={confirmCancel} onClose={closeCancel} />
      {snoozing.dialog}
    </View>
  );
}

/** Moves the bot's seen mark once the list has shown (Orca `use-bot-items-seen-at-open.ts`). */
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

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.chipRow}>
      <Pressable
        onPress={onClear}
        style={styles.chip}
        accessibilityRole="button"
        accessibilityLabel={t("bots.phone.bots.items.filter.remove", { name: label })}
        testID="phone-bot-items-filter-chip"
      >
        <Text style={styles.chipText}>{label}</Text>
        <ThemedX size={14} uniProps={foreground} />
      </Pressable>
    </View>
  );
}

/** One folding group under its "Name N" header, five rows then "Show N more"; Stale cancels them all. */
function ItemGroup({
  id,
  items,
  seen_ms,
  staleDays,
  disabled,
  renderRow,
  onCancelAll,
}: {
  id: Exclude<BotItemGroupId, "needs_you">;
  items: BotItem[];
  seen_ms: number | undefined;
  staleDays: number | null;
  disabled: boolean;
  renderRow: (item: BotItem, groupId: BotItemGroupId) => React.ReactNode;
  onCancelAll: (items: readonly BotItem[], reason: string) => void;
}) {
  const { t } = useTranslation();
  const [folded, setFolded] = useState(BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT.has(id));
  const [shown, setShown] = useState(BOT_ITEM_GROUP_ROWS);
  const [confirming, setConfirming] = useState(false);
  const toggle = useCallback(() => setFolded((value) => !value), []);
  const showMore = useCallback(() => setShown((value) => value + BOT_ITEM_GROUP_ROWS), []);
  const startConfirm = useCallback(() => setConfirming(true), []);
  const keep = useCallback(() => setConfirming(false), []);
  const reason =
    staleDays === null ? "" : t("bots.phone.bots.items.stale.reason", { count: staleDays });
  const confirmAll = useCallback(() => {
    setConfirming(false);
    onCancelAll(items, reason);
  }, [onCancelAll, items, reason]);
  const confirmHeader = useMemo(
    () => ({ title: t("bots.phone.bots.items.stale.confirm", { count: items.length }) }),
    [t, items.length],
  );
  const confirmFooter = useMemo(
    () => (
      <View style={styles.confirmFooter}>
        <Button size="sm" variant="ghost" onPress={keep}>
          {t("bots.phone.bots.items.cancel.keep")}
        </Button>
        <Button
          size="sm"
          variant="default"
          onPress={confirmAll}
          testID="phone-bot-items-stale-confirm"
        >
          {t("bots.phone.bots.items.cancel.confirmMany", { count: items.length })}
        </Button>
      </View>
    ),
    [keep, confirmAll, items.length, t],
  );
  if (items.length === 0) return null;
  const fresh = items.filter((item) => isBotItemUnseen(item, seen_ms)).length;
  const more = items.length - Math.min(shown, items.length);
  let trailing = null;
  if (id === "stale" && !folded && staleDays !== null && !disabled)
    trailing = (
      <Button
        size="xs"
        variant="ghost"
        onPress={startConfirm}
        testID="phone-bot-items-stale-cancel-all"
      >
        {t("bots.phone.bots.items.stale.cancelAll")}
      </Button>
    );
  else if (folded && fresh > 0)
    trailing = (
      <View style={styles.fresh}>
        <View style={styles.unseen} />
        <Text style={styles.freshText}>
          {t("bots.phone.bots.items.group.new", { count: fresh })}
        </Text>
      </View>
    );
  return (
    <View testID={`phone-bot-items-group-${id}`}>
      <PhoneSectionHeader
        title={`${botItemGroupName(id, t)} ${items.length}`}
        expanded={!folded}
        onToggle={toggle}
        trailing={trailing}
        testID={`phone-bot-items-toggle-${id}`}
      />
      {folded ? null : (
        <View>
          {items.slice(0, shown).map((item) => renderRow(item, id))}
          {more > 0 ? (
            <Pressable onPress={showMore} style={styles.more} accessibilityRole="button">
              <Text style={styles.moreText}>
                {t("bots.phone.bots.items.group.showMore", { count: more })}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
      <AdaptiveModalSheet
        visible={confirming}
        onClose={keep}
        header={confirmHeader}
        footer={confirmFooter}
        testID="phone-bot-items-stale-dialog"
      >
        <Text style={styles.stateBody}>
          {t("bots.phone.bots.items.stale.confirmWhy", { reason })}
        </Text>
      </AdaptiveModalSheet>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  chipRow: { flexDirection: "row", paddingHorizontal: 4, paddingBottom: 4 },
  chip: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: theme.colors.surface2,
  },
  chipText: { fontSize: 13, color: theme.colors.foreground },
  state: { alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 32 },
  stateTitle: { fontSize: 16, fontWeight: "600", color: theme.colors.foreground },
  stateBody: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    color: theme.colors.foregroundMuted,
  },
  loading: {
    paddingVertical: 24,
    textAlign: "center",
    fontSize: 14,
    color: theme.colors.foregroundMuted,
  },
  dimmed: { opacity: 0.5 },
  after: { marginTop: 16, gap: 16 },
  more: { minHeight: 44, justifyContent: "center", paddingLeft: 34 },
  moreText: { fontSize: 14, color: theme.colors.foregroundMuted },
  fresh: { flexDirection: "row", alignItems: "center", gap: 4 },
  unseen: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.foreground },
  freshText: { fontSize: 12, color: theme.colors.foreground },
  confirmFooter: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
}));
