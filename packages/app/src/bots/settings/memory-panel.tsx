// A bot's memory (spec 37.4.9): "What it knows" (MEMORY.md one fact per row, Add, Edit, Forget, the
// "{{count}} / {{cap}} lines" gauge) and "History" (every change, grouped by day, with Undo).
// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/settings/bots/BotMemoryPanel.tsx:1-70,
// BotMemoryList.tsx:1-314 and BotMemoryHistory.tsx:1-202.
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotMemoryFact, BotMemoryHistoryRow } from "@jagentdesk/protocol/bots/views";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useOptionalToast } from "@/contexts/toast-api-context";
import { botErrorCode, botErrorMessage, useBotsMutation, useBotsRead } from "@/bots/queries";
import { BotSettingsGroup } from "./rows";
import {
  groupHistoryByDay,
  memoryHistoryAuthor,
  memoryHistoryKind,
  memoryHistoryLine,
  memoryHistorySummary,
  type MemoryHistoryKind,
} from "./row-states";

type Tab = "facts" | "history";

const KIND_MARK: Record<MemoryHistoryKind, string> = {
  "tidy-up": "✦",
  undo: "↺",
  edit: "✎",
  forget: "−",
  add: "+",
};

function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function BotMemoryPanel({
  serverId,
  bot,
  defaultTab = "facts",
}: {
  serverId: string;
  bot: Bot;
  defaultTab?: Tab;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(defaultTab);
  const memory = useBotsRead(
    serverId,
    "bots.memory.read.request",
    { botId: bot.id },
    { select: (payload) => payload.memory },
  );
  const factCount = memory.data?.facts.length ?? 0;
  const options = useMemo(
    () => [
      {
        value: "facts" as const,
        label:
          factCount > 0
            ? `${t("bots.settingsBots.memoryTabs.facts")} · ${factCount}`
            : t("bots.settingsBots.memoryTabs.facts"),
        testID: "bot-memory-tab-facts",
      },
      {
        value: "history" as const,
        label: t("bots.settingsBots.memoryTabs.history"),
        testID: "bot-memory-tab-history",
      },
    ],
    [factCount, t],
  );
  return (
    <View style={styles.panel} testID="bot-memory-panel">
      <SegmentedControl size="sm" fill options={options} value={tab} onValueChange={setTab} />
      {tab === "facts" ? (
        <MemoryList serverId={serverId} bot={bot} />
      ) : (
        <MemoryHistory serverId={serverId} bot={bot} />
      )}
    </View>
  );
}

function MemoryList({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const memory = useBotsRead(
    serverId,
    "bots.memory.read.request",
    { botId: bot.id },
    { select: (payload) => payload.memory },
  );
  const add = useBotsMutation(serverId, "bots.memory.add.request");
  const edit = useBotsMutation(serverId, "bots.memory.edit.request");
  const forget = useBotsMutation(serverId, "bots.memory.forget.request");
  const [quickAdd, setQuickAdd] = useState("");
  const [quickAddKey, setQuickAddKey] = useState(0);
  // An edit names its fact by its words: the bot may move lines while the owner types.
  const [editing, setEditing] = useState<BotMemoryFact | null>(null);
  const [draft, setDraft] = useState("");
  const saving = add.isPending || edit.isPending || forget.isPending;
  const report = useCallback((error: unknown) => toast?.error(botErrorMessage(error)), [toast]);
  const submitQuickAdd = useCallback(() => {
    const text = quickAdd.trim();
    if (!text || saving) return;
    add.mutate(
      { botId: bot.id, text },
      {
        onSuccess: () => {
          setQuickAdd("");
          setQuickAddKey((key) => key + 1);
        },
        onError: report,
      },
    );
  }, [add, bot.id, quickAdd, report, saving]);
  const submitEdit = useCallback(() => {
    if (!editing || saving || !draft.trim()) return;
    edit.mutate(
      { botId: bot.id, line: editing.line, expected: editing.text, text: draft.trim() },
      { onSuccess: () => setEditing(null), onError: report },
    );
  }, [bot.id, draft, edit, editing, report, saving]);
  const cancelEdit = useCallback(() => setEditing(null), []);
  const openEdit = useCallback((fact: BotMemoryFact) => {
    setEditing(fact);
    setDraft(fact.text);
  }, []);
  const forgetFact = useCallback(
    (fact: BotMemoryFact) =>
      forget.mutate({ botId: bot.id, line: fact.line, expected: fact.text }, { onError: report }),
    [bot.id, forget, report],
  );
  const view = memory.data;
  return (
    <View style={styles.panel}>
      <View style={styles.quickAdd}>
        <View style={styles.quickAddField}>
          <FormTextInput
            key={quickAddKey}
            initialValue=""
            onChangeText={setQuickAdd}
            onSubmitEditing={submitQuickAdd}
            editable={!saving}
            placeholder={t("bots.settingsBots.addMemoryPlaceholder")}
            accessibilityLabel={t("bots.settingsBots.addMemory")}
            size="sm"
            testID="bot-memory-add-input"
          />
        </View>
        <Button
          size="sm"
          variant="outline"
          disabled={saving || !quickAdd.trim()}
          onPress={submitQuickAdd}
          testID="bot-memory-add"
        >
          {t("bots.settingsBots.addMemory")}
        </Button>
      </View>
      {view ? <MemoryGauge count={view.count} cap={view.cap} /> : null}
      <BotSettingsGroup>
        {memory.isError ? <Text style={styles.empty}>{botErrorMessage(memory.error)}</Text> : null}
        {view && view.facts.length === 0 ? (
          <Text style={styles.empty}>{t("bots.settingsBots.memoryEmpty")}</Text>
        ) : null}
        {view?.facts.map((fact) =>
          editing?.line === fact.line ? (
            <View key={`edit-${fact.line}`} style={styles.editor}>
              <FormTextInput
                initialValue={fact.text}
                value={draft}
                webControlled
                multiline
                onChangeText={setDraft}
                autoFocus
                editable={!saving}
                accessibilityLabel={t("bots.settingsBots.memoryFact")}
                size="sm"
                testID="bot-memory-edit-input"
              />
              <View style={styles.editorActions}>
                <Button size="xs" variant="ghost" onPress={cancelEdit}>
                  {t("bots.settingsBots.cancel")}
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  disabled={saving || !draft.trim()}
                  onPress={submitEdit}
                  testID="bot-memory-edit-save"
                >
                  {t("bots.settingsBots.save")}
                </Button>
              </View>
            </View>
          ) : (
            <FactRow
              key={`${fact.line}-${fact.text}`}
              fact={fact}
              disabled={saving}
              onEdit={openEdit}
              onForget={forgetFact}
            />
          ),
        )}
      </BotSettingsGroup>
    </View>
  );
}

/** MEMORY.md and "{{count}} / {{cap}} lines" with its gauge, over the facts. */
function MemoryGauge({ count, cap }: { count: number; cap: number }) {
  const { t } = useTranslation();
  const fillStyle = useMemo(
    () => [
      styles.gaugeFill,
      { width: `${Math.min(100, (count / Math.max(1, cap)) * 100)}%` as const },
    ],
    [cap, count],
  );
  return (
    <View style={styles.gaugeHeading}>
      <Text style={styles.fileName}>MEMORY.md</Text>
      <View style={styles.gauge}>
        <Text style={styles.gaugeText} testID="bot-memory-gauge">
          {t("bots.settingsBots.memoryLines", { count, cap })}
        </Text>
        <View style={styles.gaugeTrack}>
          <View style={fillStyle} />
        </View>
      </View>
    </View>
  );
}

function FactRow({
  fact,
  disabled,
  onEdit,
  onForget,
}: {
  fact: BotMemoryFact;
  disabled: boolean;
  onEdit: (fact: BotMemoryFact) => void;
  onForget: (fact: BotMemoryFact) => void;
}) {
  const { t } = useTranslation();
  const edit = useCallback(() => onEdit(fact), [fact, onEdit]);
  const forget = useCallback(() => onForget(fact), [fact, onForget]);
  const meta = [
    fact.date ? shortDate(fact.date) : null,
    fact.source ? t("bots.settingsBots.memorySource", { source: fact.source }) : null,
  ].filter(Boolean);
  return (
    <View style={styles.fact} testID="bot-memory-fact">
      <Pressable style={styles.factText} onPress={edit} accessibilityRole="button">
        <Text style={styles.factLine}>{fact.text}</Text>
        {meta.length ? <Text style={styles.factMeta}>{meta.join(" · ")}</Text> : null}
      </Pressable>
      <View style={styles.factActions}>
        <Button size="xs" variant="ghost" disabled={disabled} onPress={edit}>
          {t("bots.settingsBots.editMemory")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onPress={forget}
          textStyle={styles.dangerText}
          testID="bot-memory-forget"
        >
          {t("bots.settingsBots.forget")}
        </Button>
      </View>
    </View>
  );
}

function MemoryHistory({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const history = useBotsRead(
    serverId,
    "bots.memory.history.request",
    { botId: bot.id },
    { select: (payload) => payload.history },
  );
  const undo = useBotsMutation(serverId, "bots.memory.undo.request");
  const [open, setOpen] = useState<string | null>(null);
  const undoRow = useCallback(
    (rowId: string) =>
      undo.mutate(
        { botId: bot.id, rowId },
        {
          onError: (error) =>
            botErrorCode(error) === "superseded"
              ? toast?.show(t("bots.settingsBots.memoryHistory.nothingToUndo"))
              : toast?.error(botErrorMessage(error)),
        },
      ),
    [bot.id, t, toast, undo],
  );
  // Days are named as of the read.
  const groups = useMemo(
    () => groupHistoryByDay(history.data ?? [], history.dataUpdatedAt || Date.now(), t),
    [history.data, history.dataUpdatedAt, t],
  );
  if (history.isError) return <Text style={styles.empty}>{botErrorMessage(history.error)}</Text>;
  if (!history.data) return null;
  if (history.data.length === 0) {
    return <Text style={styles.empty}>{t("bots.settingsBots.memoryHistory.empty")}</Text>;
  }
  return (
    <View style={styles.panel} testID="bot-memory-history">
      {groups.map((group) => (
        <BotSettingsGroup key={group.day} title={group.day}>
          {group.rows.map((row) => (
            <HistoryRow
              key={row.id}
              row={row}
              open={open === row.id}
              onToggle={setOpen}
              onUndo={undoRow}
              undoing={undo.isPending}
            />
          ))}
        </BotSettingsGroup>
      ))}
    </View>
  );
}

function HistoryRow({
  row,
  open,
  onToggle,
  onUndo,
  undoing,
}: {
  row: BotMemoryHistoryRow;
  open: boolean;
  onToggle: (id: string | null) => void;
  onUndo: (id: string) => void;
  undoing: boolean;
}) {
  const { t } = useTranslation();
  const toggle = useCallback(() => onToggle(open ? null : row.id), [onToggle, open, row.id]);
  const expanded = useMemo(() => ({ expanded: open }), [open]);
  const undo = useCallback(() => onUndo(row.id), [onUndo, row.id]);
  const time = new Date(row.at_ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <View style={styles.historyRow} testID="bot-memory-history-row">
      <Pressable
        style={styles.historyHead}
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={expanded}
      >
        <Text style={styles.mark}>{KIND_MARK[memoryHistoryKind(row)]}</Text>
        <View style={styles.historyText}>
          <Text style={styles.factLine}>{memoryHistorySummary(t, row)}</Text>
          <View style={styles.historyMeta}>
            <Text style={styles.factMeta} numberOfLines={1}>
              {memoryHistoryAuthor(t, row)}
            </Text>
            <Text style={styles.factMeta}>{time}</Text>
          </View>
        </View>
        {row.undoable && !open ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={undoing}
            onPress={undo}
            testID="bot-memory-undo"
          >
            {t("bots.settingsBots.memoryHistory.undoAction")}
          </Button>
        ) : null}
      </Pressable>
      {open ? (
        <View style={styles.change}>
          <View style={styles.diff}>
            {row.change.removed.map((entry) => (
              <Text key={`-${entry.line}`} style={styles.removed}>
                {`− ${memoryHistoryLine(entry.line)}`}
              </Text>
            ))}
            {row.change.added.map((entry) => (
              <Text key={`+${entry.line}`} style={styles.added}>
                {`+ ${memoryHistoryLine(entry.line)}`}
              </Text>
            ))}
          </View>
          {row.undoable ? (
            <View style={styles.editorActions}>
              <Button
                size="xs"
                variant="ghost"
                disabled={undoing}
                onPress={undo}
                testID="bot-memory-undo"
              >
                {t("bots.settingsBots.memoryHistory.undoAction")}
              </Button>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { gap: 14 },
  quickAdd: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  quickAddField: { flex: 1, minWidth: 0 },
  fileName: {
    fontFamily: theme.fontFamily.mono,
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  gauge: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  gaugeHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    marginBottom: -8,
  },
  gaugeText: { fontSize: 11, color: theme.colors.foregroundMuted },
  gaugeTrack: {
    width: 40,
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
  },
  gaugeFill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.foregroundMuted },
  empty: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  fact: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  factText: { flex: 1, minWidth: 0 },
  factLine: { fontSize: theme.fontSize.sm, lineHeight: 19, color: theme.colors.foreground },
  factMeta: { fontSize: 11, color: theme.colors.foregroundMuted, marginTop: 2, flexShrink: 1 },
  factActions: { flexDirection: "row", alignItems: "center" },
  dangerText: { color: theme.colors.statusDanger },
  editor: { gap: theme.spacing[2], padding: 10 },
  editorActions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[1] },
  historyRow: { paddingHorizontal: theme.spacing[3], paddingVertical: 10 },
  historyHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  mark: { width: 16, textAlign: "center", fontSize: 11, color: theme.colors.foregroundMuted },
  historyText: { flex: 1, minWidth: 0 },
  historyMeta: { flexDirection: "row", gap: theme.spacing[1.5], justifyContent: "space-between" },
  change: { marginTop: 10, marginLeft: 26, gap: theme.spacing[2] },
  diff: {
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  removed: {
    fontFamily: theme.fontFamily.mono,
    fontSize: 11,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
  },
  added: {
    fontFamily: theme.fontFamily.mono,
    fontSize: 11,
    lineHeight: 17,
    color: theme.colors.foreground,
  },
}));
