// An item's Activity: comments on one quiet surface, and between them one muted line per event
// (worker started and finished from the worker's link, edits, links, snoozes and status changes).
// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/items/BotItemActivityList.tsx:1-354
// and BotItemCommentCard.tsx (the comment card), on the bt1 event shapes (`data`: status
// `{from, to, reason?}`, commented `{text}`, linked `{link}`, snoozed `{until_ms}`, edited `{fields}`).
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Bot, BotItem, BotItemEvent, BotItemStatus } from "@jagentdesk/protocol/bots/types";
import type { Theme } from "@/styles/theme";
import { BotItemStatusIcon, itemStyles } from "./item-parts";
import {
  BOT_ITEM_STATUSES,
  botItemActivity,
  botItemStatusName,
  formatBotItemSnoozeTime,
  isBotItemWorkerFailed,
  type BotItemActivityEntry,
} from "./item-rules";

type Translate = (key: string, values?: Record<string, unknown>) => string;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function statusOf(value: unknown): BotItemStatus | null {
  return BOT_ITEM_STATUSES.find((status) => status === value) ?? null;
}

/** Who wrote an event: the bot, "You", a worker by its link's title, or JAgentDesk itself. */
export function botItemActorName(
  event: BotItemEvent,
  item: BotItem,
  bot: Bot,
  t: Translate,
): string {
  switch (event.actor.kind) {
    case "bot":
      return bot.name;
    case "owner":
      return t("bots.items.activity.you");
    case "worker": {
      const agentId = event.actor.agentId;
      const link = (item.links ?? []).find(
        (entry) => entry.kind === "dispatch" && entry.ref === agentId,
      );
      return (
        (link?.kind === "dispatch" ? link.title : null) ?? t("bots.items.activity.anotherAgent")
      );
    }
    case "jagentdesk":
      return "JAgentDesk";
  }
}

function fieldName(field: string, t: Translate): string {
  if (field === "doneMeans") return t("bots.items.field.doneMeansLower");
  if (field === "description") return t("bots.items.field.description");
  return t("bots.items.field.title");
}

function linkName(link: unknown): string {
  if (!link || typeof link !== "object") return str(link);
  const value = link as { kind?: unknown; ref?: unknown; title?: unknown; name?: unknown };
  return str(value.title) || str(value.name) || str(value.ref);
}

function eventLine(event: BotItemEvent, by: string, t: Translate, locale: string): string {
  const { data } = event;
  switch (event.kind) {
    case "made":
      return `${by} ${
        data.status === "needs_you"
          ? t("bots.items.activity.madeNeedsYou")
          : t("bots.items.activity.made")
      }`;
    case "edited": {
      let fields: string[] = [];
      if (Array.isArray(data.fields)) fields = (data.fields as unknown[]).map(String);
      else if (data.fields && typeof data.fields === "object") fields = Object.keys(data.fields);
      return fields
        .map((field) => `${by} ${t("bots.items.activity.changed", { field: fieldName(field, t) })}`)
        .join("\n");
    }
    case "status": {
      const closed = (value: unknown) => value === "done" || value === "canceled";
      const reopened = closed(data.from) && !closed(data.to);
      const to = statusOf(data.to);
      const reason = str(data.reason);
      let verb: string;
      if (data.to === "done") verb = t("bots.items.activity.closed");
      else if (data.to === "canceled") verb = t("bots.items.activity.canceled");
      else if (reopened) verb = t("bots.items.activity.reopened");
      else
        verb = `${t("bots.items.activity.moved")} ${to ? botItemStatusName(to, t) : str(data.to)}`;
      return `${by} ${verb}${reason ? `: ${reason}` : ""}`;
    }
    case "linked":
      return `${by} ${t("bots.items.activity.linked", { links: linkName(data.link) })}`;
    case "snoozed":
      return `${by} ${
        typeof data.until_ms === "number"
          ? t("bots.items.activity.snoozed", {
              when: formatBotItemSnoozeTime(data.until_ms, event.at_ms, locale),
            })
          : t("bots.items.activity.snoozedBare")
      }`;
    case "unsnoozed":
      return data.early
        ? t("bots.items.activity.snoozeEnded")
        : `${by} ${t("bots.items.activity.unsnoozed")}`;
    case "commented":
      return str(data.text);
  }
}

function CommentCard({
  name,
  at,
  text,
  locale,
}: {
  name: string;
  at: number;
  text: string;
  locale: string;
}) {
  const { t } = useTranslation();
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    at,
  );
  return (
    <View
      style={styles.comment}
      accessibilityLabel={t("bots.items.activity.commentLabel", { name, time })}
      testID="bot-item-comment"
    >
      <View style={styles.commentHead}>
        <Text style={styles.commentName}>{name}</Text>
        <Text style={itemStyles.muted}>{time}</Text>
      </View>
      <Text selectable style={styles.commentText}>
        {text}
      </Text>
    </View>
  );
}

function WorkerLine({ entry }: { entry: Extract<BotItemActivityEntry, { kind: "worker" }> }) {
  const { t } = useTranslation();
  const title = entry.link.title ?? entry.link.ref;
  let label = t("bots.items.activity.workerFinished");
  if (entry.phase === "started") label = t("bots.items.activity.workerStarted");
  else if (isBotItemWorkerFailed(entry.link)) label = t("bots.items.activity.workerFailed");
  return (
    <View style={styles.line}>
      <View style={styles.rail}>
        <View style={styles.railDot} />
      </View>
      <View style={styles.lineBody}>
        <Text style={styles.lineText}>
          {label} <Text style={styles.actor}>{title}</Text>
        </Text>
        {entry.phase === "settled" && entry.link.report ? (
          <Text style={styles.lineText}>{entry.link.report}</Text>
        ) : null}
      </View>
    </View>
  );
}

/** One event's muted line; an edit opens its before and after on press. */
function EventLine({ event, line }: { event: BotItemEvent; line: string }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const status = event.kind === "status" ? statusOf(event.data.to) : null;
  const fields = event.data.fields;
  const edit =
    event.kind === "edited" && fields && typeof fields === "object" && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : null;
  return (
    <View style={styles.line}>
      <View style={styles.rail}>
        {status ? <BotItemStatusIcon status={status} /> : <View style={styles.railDot} />}
      </View>
      <Pressable style={styles.lineBody} disabled={!edit} onPress={toggle}>
        <Text style={styles.lineText}>{line}</Text>
        {open && edit
          ? Object.entries(edit).map(([field, change]) => <FieldDiff key={field} change={change} />)
          : null}
      </Pressable>
    </View>
  );
}

function FieldDiff({ change }: { change: unknown }) {
  const diff =
    change && typeof change === "object" ? (change as { from?: unknown; to?: unknown }) : {};
  return (
    <View style={styles.diff}>
      {str(diff.from) ? <Text style={styles.diffFrom}>{str(diff.from)}</Text> : null}
      {str(diff.to) ? <Text style={styles.lineText}>{str(diff.to)}</Text> : null}
    </View>
  );
}

export function BotItemActivityList({
  bot,
  item,
  events,
}: {
  bot: Bot;
  item: BotItem;
  events: readonly BotItemEvent[];
}) {
  const { t, i18n } = useTranslation();
  const entries = botItemActivity(item, events);
  if (entries.length === 0)
    return <Text style={itemStyles.muted}>{t("bots.items.activity.noComments")}</Text>;
  return (
    <View style={styles.list} testID="bot-item-activity">
      {entries.map((entry) => {
        if (entry.kind === "worker") return <WorkerLine key={entry.key} entry={entry} />;
        const { event } = entry;
        const by = botItemActorName(event, item, bot, t);
        if (event.kind === "commented")
          return (
            <CommentCard
              key={entry.key}
              name={by}
              at={event.at_ms}
              text={str(event.data.text)}
              locale={i18n.language}
            />
          );
        return (
          <EventLine key={entry.key} event={event} line={eventLine(event, by, t, i18n.language)} />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  list: { gap: 6 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  rail: { width: 20, height: 18, alignItems: "center", justifyContent: "center" },
  railDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.border },
  lineBody: { flex: 1, minWidth: 0 },
  lineText: { fontSize: 12, lineHeight: 18, color: theme.colors.foregroundMuted },
  actor: { fontWeight: "500", color: theme.colors.foreground },
  diff: { marginTop: 2, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: theme.colors.border },
  diffFrom: {
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  comment: {
    gap: 4,
    padding: 10,
    borderRadius: 10,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  commentHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  commentName: { fontSize: 12, fontWeight: "500", color: theme.colors.foreground },
  commentText: { fontSize: 13, lineHeight: 19, color: theme.colors.foreground },
}));
