import { memo, useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { ChevronDown, ChevronRight, Eye } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BlockCopyButton } from "@/components/markdown/block-copy-button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { ICON_SIZE } from "@/styles/theme";
import { highlightToKeyedLines } from "@/utils/highlight-cache";
import { PROVIDER_TAB_ID, scriptLanguage, type LastRead, type OutputTab } from "./sources";
import type { ScriptSource } from "./sources";

const ThemedChevronRight = withUnistyles(ChevronRight, mutedIconColorMapping);
const ThemedChevronDown = withUnistyles(ChevronDown, mutedIconColorMapping);
const ThemedEye = withUnistyles(Eye, mutedIconColorMapping);

/** The script and a read stay short in the popover; the page scrolls in the sheet. */
const SCRIPT_MAX_HEIGHT = 240;
const LAST_READ_MAX_HEIGHT = 200;

/**
 * "Output · t.log · err.log": the provider's output and each redirect file (ADR-0064), in the
 * place of the "Output" heading.
 */
export function OutputSourceTabs({
  tabs,
  selected,
  onSelect,
}: {
  tabs: readonly OutputTab[];
  selected: string;
  onSelect: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tabsScroll}
      contentContainerStyle={styles.tabs}
      accessibilityRole="tablist"
      testID="background-work-output-tabs"
    >
      {tabs.map((tab) => (
        <SourceTab
          key={tab.id}
          id={tab.id}
          label={tab.kind === "provider" ? t("message.backgroundWork.detail.output") : tab.label}
          selected={tab.id === selected}
          onSelect={onSelect}
        />
      ))}
    </ScrollView>
  );
}

function SourceTab({
  id,
  label,
  selected,
  onSelect,
}: {
  id: string;
  label: string;
  selected: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const press = useCallback(() => onSelect(id), [id, onSelect]);
  const testKey = id === PROVIDER_TAB_ID ? "provider" : id.replace(/[^a-z0-9]+/gi, "-");
  const state = useMemo(() => ({ selected }), [selected]);
  return (
    <Pressable
      onPress={press}
      accessibilityRole="tab"
      accessibilityState={state}
      style={selected ? selectedTabStyle : tabStyle}
      testID={`background-work-output-tab-${testKey}`}
    >
      <Text style={selected ? styles.tabLabelSelected : styles.tabLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** "Read by the agent 2 minutes ago" with "Show what it read" (ADR-0064 §3). */
export function ReadByAgentStrip({ lastRead }: { lastRead: LastRead }): ReactElement {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const copy = useCallback(() => Clipboard.setStringAsync(lastRead.content), [lastRead.content]);
  const time = formatReadTime(new Date(lastRead.at), i18n.language);
  const state = useMemo(() => ({ expanded: open }), [open]);
  return (
    <View style={styles.readSection} testID="background-work-read-by-agent">
      <View style={styles.readStrip}>
        <ThemedEye size={ICON_SIZE.xs} />
        <Text style={styles.readText} numberOfLines={1}>
          {t("message.backgroundWork.detail.readByAgent", { time })}
        </Text>
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          accessibilityState={state}
          style={linkStyle}
          testID="background-work-read-by-agent-toggle"
        >
          <Text style={styles.link}>
            {open
              ? t("message.backgroundWork.detail.hideWhatItRead")
              : t("message.backgroundWork.detail.showWhatItRead")}
          </Text>
        </Pressable>
      </View>
      {open ? (
        <View style={styles.fence} testID="background-work-read-by-agent-content">
          <ScrollView style={styles.readScroll} nestedScrollEnabled>
            <Text style={styles.mono} selectable dataSet={CODE_SURFACE_DATASET}>
              {lastRead.content || " "}
            </Text>
            {lastRead.truncated ? (
              <Text style={styles.note}>{t("message.backgroundWork.detail.showingFirst64Kb")}</Text>
            ) : null}
          </ScrollView>
          <BlockCopyButton
            onCopy={copy}
            visible
            label={t("message.backgroundWork.detail.copyWhatItRead")}
          />
        </View>
      ) : null}
    </View>
  );
}

/** "Script · wait.sh · 12 lines", collapsed; opens to the script, highlighted (ADR-0064 §2). */
export function ScriptSection({ script }: { script: ScriptSource }): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const copy = useCallback(() => Clipboard.setStringAsync(script.content), [script.content]);
  const state = useMemo(() => ({ expanded: open }), [open]);
  return (
    <View style={styles.scriptSection} testID="background-work-script">
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={state}
        style={scriptRowStyle}
        testID="background-work-script-toggle"
      >
        {open ? (
          <ThemedChevronDown size={ICON_SIZE.sm} />
        ) : (
          <ThemedChevronRight size={ICON_SIZE.sm} />
        )}
        <Text style={styles.scriptSummary} numberOfLines={1}>
          {t("message.backgroundWork.detail.scriptSummary", {
            file: script.label,
            lines: script.lineCount,
          })}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.fence} testID="background-work-script-content">
          <ScrollView style={styles.scriptScroll} nestedScrollEnabled>
            <HighlightedScript content={script.content} label={script.label} />
            {script.truncated ? (
              <Text style={styles.note}>{t("message.backgroundWork.detail.showingFirst64Kb")}</Text>
            ) : null}
          </ScrollView>
          <BlockCopyButton
            onCopy={copy}
            visible
            label={t("message.backgroundWork.detail.copyScript")}
          />
        </View>
      ) : null}
    </View>
  );
}

const HighlightedScript = memo(function HighlightedScript({
  content,
  label,
}: {
  content: string;
  label: string;
}): ReactElement {
  const code = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = useMemo(
    () => highlightToKeyedLines(code, scriptLanguage(label, content)),
    [code, content, label],
  );
  if (!lines) {
    return (
      <Text style={styles.mono} selectable dataSet={CODE_SURFACE_DATASET}>
        {code}
      </Text>
    );
  }
  const segments: ReactNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) segments.push(<Text key={`${line.key}-nl`}>{"\n"}</Text>);
    for (const { key, token } of line.tokens) {
      segments.push(
        <Text
          key={`${line.key}-${key}`}
          style={token.style ? syntaxTokenStyleFor(token.style) : undefined}
        >
          {token.text}
        </Text>,
      );
    }
  });
  return (
    <Text style={styles.mono} selectable dataSet={CODE_SURFACE_DATASET}>
      {segments}
    </Text>
  );
});

interface PressState {
  hovered?: boolean;
  pressed: boolean;
}

function tabStyle({ hovered, pressed }: PressState) {
  return [styles.tab, (hovered || pressed) && styles.tabHovered];
}

function selectedTabStyle() {
  return [styles.tab, styles.tabSelected];
}

function linkStyle({ hovered, pressed }: PressState) {
  return [styles.readToggle, (hovered || pressed) && styles.readToggleActive];
}

function scriptRowStyle({ hovered, pressed }: PressState) {
  return [styles.scriptRow, (hovered || pressed) && styles.scriptRowHovered];
}

/** "just now", "5 minutes ago" in the app's language; the clock time after a day. */
function formatReadTime(at: Date, language: string): string {
  const seconds = Math.round((at.getTime() - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const ago = -seconds;
  if (ago < 60) return format.format(0, "second");
  if (ago < 3600) return format.format(-Math.floor(ago / 60), "minute");
  if (ago < 86400) return format.format(-Math.floor(ago / 3600), "hour");
  return at.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const styles = StyleSheet.create((theme) => {
  const small = {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  } as const;
  const link = { ...small, fontWeight: theme.fontWeight.medium } as const;
  return {
    tabsScroll: { flexGrow: 0, flexShrink: 1, minWidth: 0 },
    tabs: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
    tab: {
      height: 24,
      justifyContent: "center",
      paddingHorizontal: theme.spacing[2],
      borderRadius: theme.borderRadius.md,
      maxWidth: 200,
    },
    tabHovered: { backgroundColor: theme.colors.surface2 },
    tabSelected: {
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    tabLabel: { ...small, fontWeight: theme.fontWeight.medium },
    tabLabelSelected: {
      ...small,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
    },
    readSection: { gap: theme.spacing[2] },
    readStrip: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
      minHeight: 24,
      paddingHorizontal: theme.spacing[2],
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface2,
    },
    readText: { ...small, flexShrink: 1, minWidth: 0 },
    readToggle: {
      marginLeft: "auto",
      paddingHorizontal: theme.spacing[1],
      borderRadius: theme.borderRadius.sm,
    },
    readToggleActive: { backgroundColor: theme.colors.surface1 },
    link,
    // The markdown fence, as the command block above.
    fence: {
      position: "relative",
      padding: theme.spacing[3],
      paddingRight: theme.spacing[8],
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    readScroll: { maxHeight: LAST_READ_MAX_HEIGHT },
    scriptScroll: { maxHeight: SCRIPT_MAX_HEIGHT },
    mono: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      lineHeight: 17,
      color: theme.colors.foreground,
    },
    note: { ...small, marginTop: theme.spacing[2] },
    scriptSection: { gap: theme.spacing[2] },
    scriptRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      alignSelf: "flex-start",
      height: 24,
      paddingLeft: theme.spacing[1],
      paddingRight: theme.spacing[2],
      marginLeft: -theme.spacing[1],
      borderRadius: theme.borderRadius.md,
    },
    scriptRowHovered: { backgroundColor: theme.colors.surface2 },
    scriptSummary: { ...small, fontWeight: theme.fontWeight.medium },
  };
});
