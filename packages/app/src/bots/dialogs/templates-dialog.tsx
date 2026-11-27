// Bot templates (spec 37.4.10). Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/
// templates/BotTemplatesDialog.tsx:57-375 (search, category filter, grouped list beside the selected
// template's detail; narrow: the detail opens in place of the list, "All templates" goes back),
// BotTemplateRow.tsx:7-64, BotTemplateDetail.tsx:23-101 (mascot, name, "by JAgentDesk", line,
// "Use template…", examples "in its chat", "What it does first", "Needs setup"),
// BotTemplateComesWith.tsx:63-123 and BotTemplatesEmpty.tsx:5-37. No "From a link" (spec 37.4.10).
// The catalog is the daemon's (`bots.templates.list`); nothing here is made before New bot's Create.
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronLeft, Clock, Plug, Plus, Zap } from "lucide-react-native";
import type { BotTemplate } from "@jagentdesk/protocol/bots/views";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { BotAvatar } from "@/bots/avatar";
import { botErrorMessage, useBotsRead } from "@/bots/queries";

const ThemedBook = withUnistyles(BookOpen);
const ThemedClock = withUnistyles(Clock);
const ThemedZap = withUnistyles(Zap);
const ThemedPlug = withUnistyles(Plug);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ALL = "all";
const CONNECTOR_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  slack: "Slack",
  telegram: "Telegram",
};

interface TemplateGroup {
  category: string;
  label: string;
  templates: BotTemplate[];
}

/** `bot-template-view.ts` botTemplateMatches: name, line, category and what it does, any case. */
export function botTemplateMatches(template: BotTemplate, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    template.id,
    template.name,
    template.line,
    template.categoryLabel,
    template.watches,
    template.does,
    template.reports,
  ].some((field) => field.toLowerCase().includes(needle));
}

/** Templates by category, in the catalog's order. */
export function botTemplateGroups(
  templates: readonly BotTemplate[],
  keep: (template: BotTemplate) => boolean,
): TemplateGroup[] {
  const groups: TemplateGroup[] = [];
  for (const template of templates) {
    if (!keep(template)) continue;
    let group = groups.find((entry) => entry.category === template.category);
    if (!group) {
      group = { category: template.category, label: template.categoryLabel, templates: [] };
      groups.push(group);
    }
    group.templates.push(template);
  }
  return groups;
}

function templateLook(template: BotTemplate) {
  return { name: template.name, avatar: `mascot:${template.mascot}`, avatarColor: undefined };
}

export function BotTemplatesDialog({
  serverId,
  initialQuery,
  onClose,
  onUse,
  onBlank,
}: {
  serverId: string;
  initialQuery?: string;
  onClose: () => void;
  /** "Use template…": New bot, prefilled from the template. */
  onUse: (templateId: string) => void;
  /** Blank bot; "Blank bot for “query”" passes the search as its Identity. */
  onBlank: (identity?: string) => void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const templates = useBotsRead(
    serverId,
    "bots.templates.list.request",
    {},
    { select: (payload) => payload.templates },
  );
  const [query, setQuery] = useState(initialQuery ?? "");
  const [category, setCategory] = useState<string>(ALL);
  const [picked, setPicked] = useState<string | null>(null);
  const [inPlace, setInPlace] = useState(false);
  const all = useMemo(() => templates.data ?? [], [templates.data]);
  const categories = useMemo(() => botTemplateGroups(all, () => true), [all]);
  const groups = useMemo(
    () =>
      botTemplateGroups(
        all,
        (template) =>
          (category === ALL || template.category === category) &&
          botTemplateMatches(template, query),
      ),
    [all, category, query],
  );
  const shown = groups.flatMap((group) => group.templates);
  const selected = shown.find((template) => template.id === picked) ?? shown[0] ?? null;
  const categoryOptions = useMemo(
    () => [
      {
        value: ALL,
        label: t("bots.templates.allCategories"),
        testID: "bot-templates-category-all",
      },
      ...categories.map((group) => ({
        value: group.category,
        label: group.label,
        testID: `bot-templates-category-${group.category}`,
      })),
    ],
    [categories, t],
  );
  const blank = useCallback(() => onBlank(), [onBlank]);
  const header = useMemo(
    () => ({
      title: t("bots.templates.title"),
      actions: (
        <Button
          variant="outline"
          size="sm"
          leftIcon={Plus}
          onPress={blank}
          testID="bot-templates-blank"
        >
          {t("bots.templates.blank")}
        </Button>
      ),
    }),
    [blank, t],
  );
  const select = useCallback(
    (id: string) => {
      setPicked(id);
      if (compact) setInPlace(true);
    },
    [compact],
  );
  const back = useCallback(() => setInPlace(false), []);
  const clear = useCallback(() => setQuery(""), []);
  const list = (
    <View style={styles.listColumn}>
      <View style={styles.controls}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t("bots.templates.search")}
          clearAccessibilityLabel={t("bots.templates.clearSearch")}
          testID="bot-templates-search"
        />
        <View accessibilityLabel={t("bots.templates.filterCategory")}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <SegmentedControl
              options={categoryOptions}
              value={category}
              onValueChange={setCategory}
              size="xs"
              testID="bot-templates-category"
            />
          </ScrollView>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.list} testID="bot-templates-list">
        {templates.error ? (
          <Text style={styles.error}>{botErrorMessage(templates.error)}</Text>
        ) : null}
        {templates.isSuccess && shown.length === 0 ? (
          <TemplatesEmpty query={query} onBlank={onBlank} onClear={clear} />
        ) : null}
        {groups.map((group) => (
          <View key={group.category} accessibilityLabel={group.label}>
            <Text style={styles.groupHeading}>{group.label}</Text>
            {group.templates.map((template) => (
              <TemplateRow
                key={template.id}
                template={template}
                current={!compact && template.id === selected?.id}
                onSelect={select}
                onUse={onUse}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
  let body;
  if (compact && inPlace && selected) {
    body = (
      <View style={styles.inPlace}>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={ChevronLeft}
          onPress={back}
          style={styles.backButton}
        >
          {t("bots.templates.allTemplates")}
        </Button>
        <TemplateDetail template={selected} onUse={onUse} />
      </View>
    );
  } else if (compact) {
    body = list;
  } else {
    body = (
      <View style={styles.columns}>
        {list}
        {selected ? (
          <View style={styles.detailColumn}>
            <TemplateDetail template={selected} onUse={onUse} />
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      desktopMaxWidth={1080}
      desktopHeight={780}
      scrollable={false}
      testID="bot-templates-dialog"
    >
      {body}
    </AdaptiveModalSheet>
  );
}

function TemplateRow({
  template,
  current,
  onSelect,
  onUse,
}: {
  template: BotTemplate;
  current: boolean;
  onSelect: (id: string) => void;
  onUse: (id: string) => void;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => onSelect(template.id), [onSelect, template.id]);
  const use = useCallback(() => onUse(template.id), [onUse, template.id]);
  return (
    <Pressable
      onPress={select}
      accessibilityRole="button"
      aria-selected={current}
      style={[styles.row, current && styles.rowCurrent]}
      testID={`bot-template-${template.id}`}
    >
      <BotAvatar bot={templateLook(template)} size={32} radius={8} />
      <View style={styles.rowText}>
        <View style={styles.rowTitle}>
          <Text style={styles.rowName} numberOfLines={1}>
            {template.name}
          </Text>
          {template.needsSetup ? <NeedsSetupBadge /> : null}
        </View>
        <Text style={styles.rowLine} numberOfLines={1}>
          {template.line}
        </Text>
      </View>
      {current ? (
        <Button
          variant="outline"
          size="xs"
          onPress={use}
          accessibilityLabel={t("bots.templates.useNamed", { name: template.name })}
        >
          {t("bots.templates.use")}
        </Button>
      ) : null}
    </Pressable>
  );
}

function NeedsSetupBadge() {
  const { t } = useTranslation();
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{t("bots.templates.needsSetup")}</Text>
    </View>
  );
}

function TemplateDetail({
  template,
  onUse,
}: {
  template: BotTemplate;
  onUse: (id: string) => void;
}) {
  const { t } = useTranslation();
  const use = useCallback(() => onUse(template.id), [onUse, template.id]);
  return (
    <View style={styles.detail} testID={`bot-template-detail-${template.id}`}>
      <View style={styles.detailHeader}>
        <View style={styles.detailTitleRow}>
          <BotAvatar bot={templateLook(template)} size={56} radius={14} />
          <View style={styles.detailTitle}>
            <View style={styles.rowTitle}>
              <Text style={styles.detailName} numberOfLines={1}>
                {template.name}
              </Text>
              {template.needsSetup ? <NeedsSetupBadge /> : null}
            </View>
            <Text style={styles.meta}>
              {template.categoryLabel} · {t("bots.templates.publisher")}
            </Text>
          </View>
        </View>
        <Text style={styles.text}>{template.line}</Text>
        <Button variant="default" onPress={use} testID="bot-template-use">
          {t("bots.templates.useTemplate")}
        </Button>
      </View>
      <ScrollView
        contentContainerStyle={styles.detailBody}
        accessibilityLabel={t("bots.templates.aboutTemplate", { name: template.name })}
      >
        {template.example.length ? (
          <View style={styles.example}>
            <View style={styles.exampleHead}>
              <BotAvatar bot={templateLook(template)} size={16} />
              <Text style={styles.meta}>
                <Text style={styles.strong}>{template.name}</Text> {t("bots.templates.inItsChat")}
              </Text>
            </View>
            {template.example.map((line) => (
              <Text key={line} style={styles.text}>
                {line}
              </Text>
            ))}
          </View>
        ) : null}
        <View>
          <Text style={styles.sectionTitle}>{t("bots.templates.firstChat")}</Text>
          <Text style={styles.text}>{template.firstChat}</Text>
        </View>
        {template.needsSetup ? (
          <View style={styles.example}>
            <Text style={styles.sectionTitle}>{t("bots.templates.needsSetup")}</Text>
            <Text style={styles.text}>{template.needsSetup}</Text>
          </View>
        ) : null}
        <View>
          <Text style={styles.sectionTitle}>{t("bots.templates.comesWith")}</Text>
          <Text style={styles.note}>{t("bots.templates.comesWithNote")}</Text>
          {template.skills.map((skill) => (
            <ComesWithRow key={skill} icon={ThemedBook} title={skill} mono />
          ))}
          {template.schedules.map((schedule) => (
            <ComesWithRow
              key={schedule.id}
              icon={ThemedClock}
              title={schedule.when}
              line={schedule.what}
              state={t("bots.templates.stateOff")}
            />
          ))}
          {template.events.map((event) => (
            <ComesWithRow
              key={event.id}
              icon={ThemedZap}
              title={event.name}
              line={event.source}
              state={t("bots.templates.stateFirstChat")}
            />
          ))}
          {template.connectors.map((kind) => (
            <ComesWithRow
              key={kind}
              icon={ThemedPlug}
              title={CONNECTOR_NAMES[kind] ?? kind}
              state={t("bots.templates.stateNotConnected")}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function ComesWithRow({
  icon: Icon,
  title,
  line,
  state,
  mono = false,
}: {
  icon: typeof ThemedBook;
  title: string;
  line?: string;
  state?: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.part}>
      <Icon size={16} uniProps={muted} />
      <View style={styles.rowText}>
        <Text style={mono ? styles.mono : styles.text}>{title}</Text>
        {line ? <Text style={styles.meta}>{line}</Text> : null}
      </View>
      {state ? <Text style={styles.meta}>{state}</Text> : null}
    </View>
  );
}

function TemplatesEmpty({
  query,
  onBlank,
  onClear,
}: {
  query: string;
  onBlank: (identity?: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const trimmed = query.trim();
  // Orca BotTemplatesDialog.tsx:276: the search becomes the blank bot's Identity.
  const blankFor = useCallback(() => onBlank(trimmed), [onBlank, trimmed]);
  return (
    <View style={styles.empty} testID="bot-templates-empty">
      <Text style={styles.emptyTitle}>{t("bots.templates.noMatch", { query: trimmed })}</Text>
      <Text style={styles.meta}>{t("bots.templates.noMatchLine")}</Text>
      <View style={styles.emptyActions}>
        <Button variant="outline" size="sm" onPress={blankFor} testID="bot-templates-blank-for">
          {t("bots.templates.blankFor", { query: trimmed })}
        </Button>
        <Button variant="ghost" size="sm" onPress={onClear}>
          {t("bots.templates.clearSearch")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  columns: { flex: 1, minHeight: 0, flexDirection: "row" },
  listColumn: { flex: 1, minWidth: 0, minHeight: 0 },
  controls: { gap: 8, paddingBottom: 8 },
  list: { paddingBottom: 32 },
  groupHeading: {
    paddingVertical: 8,
    fontSize: 12,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
  },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 8,
  },
  rowCurrent: { backgroundColor: theme.chrome.selectedRow },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  rowName: { flexShrink: 1, fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  rowLine: { fontSize: 12, lineHeight: 20, color: theme.colors.foregroundMuted },
  badge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    backgroundColor: theme.colors.statusWarningBackground,
  },
  badgeText: { fontSize: 11, fontWeight: "500", color: theme.colors.statusWarning },
  detailColumn: {
    width: 400,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    marginLeft: 16,
  },
  inPlace: { flex: 1, minHeight: 0 },
  backButton: { alignSelf: "flex-start" },
  detail: { flex: 1, minHeight: 0 },
  detailHeader: { gap: 16, paddingHorizontal: 24, paddingTop: 8, paddingBottom: 20 },
  detailTitleRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  detailTitle: { flex: 1, minWidth: 0, gap: 2 },
  detailName: { flexShrink: 1, fontSize: 18, fontWeight: "600", color: theme.colors.foreground },
  detailBody: { gap: 20, paddingHorizontal: 24, paddingBottom: 24 },
  example: {
    gap: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    padding: 12,
    backgroundColor: theme.colors.surface1,
  },
  exampleHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  sectionTitle: {
    marginBottom: 6,
    fontSize: 12,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
  },
  note: { marginBottom: 4, fontSize: 12, color: theme.colors.foregroundMuted },
  part: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  text: { fontSize: 14, color: theme.colors.foreground },
  strong: { fontWeight: "500", color: theme.colors.foreground },
  mono: { fontSize: 12, fontFamily: theme.fontFamily.mono, color: theme.colors.foreground },
  meta: { fontSize: 12, color: theme.colors.foregroundMuted },
  error: { fontSize: 13, color: theme.colors.statusDanger },
  empty: { alignItems: "center", gap: 12, paddingTop: 64, paddingHorizontal: 24 },
  emptyTitle: {
    fontSize: 14,
    fontWeight: "500",
    color: theme.colors.foreground,
    textAlign: "center",
  },
  emptyActions: { flexDirection: "row", gap: 8 },
}));
