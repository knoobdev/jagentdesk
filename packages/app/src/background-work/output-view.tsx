import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { ArrowDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import TerminalEmulator, { type TerminalEmulatorHandle } from "@/components/terminal-emulator";
import { composerPillStyles } from "@/composer/pill-styles";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useAppSettings } from "@/hooks/use-settings";
import { ICON_SIZE } from "@/styles/theme";
import { useSessionStore } from "@/stores/session-store";
import type { TerminalCharacterWidths } from "@/terminal/character-widths";
import type { TerminalRendererReadyChange } from "@/utils/terminal-renderer-readiness";
import { toXtermTheme } from "@/utils/to-xterm-theme";
import { DetailCopyAction } from "./icon-action";
import { toTerminalText, type BackgroundWorkOutputWrite } from "./output-buffer";
import type { LastRead, OutputTab } from "./sources";
import { OutputSourceTabs, ReadByAgentStrip } from "./sources-view";
import { useBackgroundWorkOutput } from "./use-detail";

// The theme reaches xterm as a prop, so only this wrapper re-renders on a theme change. The
// output sits in a fence (spec 04 §27c), so the terminal paints the fence's surface, not its own.
const ThemedTerminalEmulator = withUnistyles(TerminalEmulator, (theme) => ({
  xtermTheme: { ...toXtermTheme(theme.colors.terminal), background: theme.colors.surface2 },
}));
const ThemedArrowDown = withUnistyles(ArrowDown, mutedIconColorMapping);

const TERMINAL_EMULATOR_DOM_PROPS = {
  style: { flex: 1 },
  matchContents: false,
  scrollEnabled: true,
  nestedScrollEnabled: true,
  overScrollMode: "never" as const,
  bounces: false,
  automaticallyAdjustContentInsets: false,
  contentInsetAdjustmentBehavior: "never" as const,
};

const encoder = new TextEncoder();

export interface BackgroundWorkOutputViewProps {
  serverId: string;
  agentId: string;
  itemId: string;
  /** False when the provider exposes no output for this work. */
  outputAvailable: boolean;
  providerLabel: string;
  /** Height of the output box; omitted, it fills its parent down to `MIN_FILL_HEIGHT`. */
  height?: number;
  /** ADR-0064: the redirect file to follow; the provider's output when absent. */
  sourceId?: string;
  /** ADR-0064: the source tabs, in the place of the "Output" heading. */
  tabs?: readonly OutputTab[];
  onSelectTab?: (id: string) => void;
  /** The agent's latest read of this file, as a strip above the box. */
  lastRead?: LastRead | null;
  /** What the empty box says; "Waiting for output…" by default. */
  waitingText?: string;
  /** A second line under the waiting text. */
  emptyHint?: string | null;
}

/** The least a filling output box shrinks to before its page scrolls instead. */
const MIN_FILL_HEIGHT = 240;

/**
 * A background task's output in the app's terminal renderer, read-only (ADR-0062, spec 04
 * §27c): follows the end while the viewer is there, stays put when they scroll up.
 */
export function BackgroundWorkOutputView({
  serverId,
  agentId,
  itemId,
  outputAvailable,
  providerLabel,
  height,
  sourceId,
  tabs,
  onSelectTab,
  lastRead,
  waitingText,
  emptyHint,
}: BackgroundWorkOutputViewProps): ReactElement {
  const { t } = useTranslation();
  const terminalRef = useRef<TerminalEmulatorHandle>(null);
  const readyRef = useRef(false);
  const [scrolled, setScrolled] = useState(false);
  const { settings } = useAppSettings();
  const characterWidths: TerminalCharacterWidths = useSessionStore((state) =>
    state.sessions[serverId]?.serverInfo?.features?.["terminal-grapheme-widths"] === true
      ? "graphemes"
      : "legacy",
  );

  const handleWrite = useCallback((write: BackgroundWorkOutputWrite) => {
    const terminal = terminalRef.current;
    if (!readyRef.current || !terminal) return;
    if (write.reset) terminal.clear();
    if (write.data) terminal.writeOutput(encoder.encode(write.data));
  }, []);

  const { status, hasOutput, getBuffer } = useBackgroundWorkOutput({
    serverId,
    agentId,
    itemId,
    sourceId,
    enabled: outputAvailable,
    onWrite: handleWrite,
  });

  // The output can arrive before the renderer is up; replay what is buffered once it is.
  const handleRendererReadyChange = useCallback(
    (change: TerminalRendererReadyChange) => {
      readyRef.current = change.isReady;
      const terminal = terminalRef.current;
      if (!change.isReady || !terminal) return;
      terminal.clear();
      const { text } = getBuffer();
      if (text) terminal.writeOutput(encoder.encode(toTerminalText(text)));
    },
    [getBuffer],
  );

  const jumpToLatest = useCallback(() => terminalRef.current?.scrollToBottom?.(), []);
  const copyOutput = useCallback(() => Clipboard.setStringAsync(getBuffer().text), [getBuffer]);

  const frameStyle = useMemo(
    () => (height === undefined ? styles.frameFill : [styles.frame, { height }]),
    [height],
  );

  if (!outputAvailable) {
    return (
      <View style={styles.section}>
        <OutputHeading tabs={tabs} selected={sourceId} onSelect={onSelectTab} />
        <View style={styles.unavailable} testID="background-work-output-unavailable">
          <Text style={styles.placeholder}>
            {t("message.backgroundWork.detail.outputUnavailable", { provider: providerLabel })}
          </Text>
        </View>
      </View>
    );
  }

  const statusText = outputStatusText(t, status);
  const { placeholder, hint } = emptyBoxText({
    hasOutput,
    statusText,
    waitingText: waitingText ?? t("message.backgroundWork.detail.waitingForOutput"),
    emptyHint,
  });
  return (
    <View style={height === undefined ? styles.sectionFill : styles.section}>
      <View style={styles.header}>
        <OutputHeading tabs={tabs} selected={sourceId} onSelect={onSelectTab} />
        {hasOutput && statusText ? (
          <Text style={styles.headerStatus} numberOfLines={1}>
            {statusText}
          </Text>
        ) : null}
        <View style={styles.headerActions}>
          <DetailCopyAction
            label={t("message.backgroundWork.detail.copyOutput")}
            onCopy={copyOutput}
            testID="background-work-output-copy"
          />
        </View>
      </View>
      {lastRead ? <ReadByAgentStrip lastRead={lastRead} /> : null}
      <View style={frameStyle} testID="background-work-output">
        <ThemedTerminalEmulator
          ref={terminalRef}
          dom={TERMINAL_EMULATOR_DOM_PROPS}
          streamKey={`background-work:${serverId}:${agentId}:${itemId}:${sourceId ?? "provider"}`}
          // Output is replayed as plain writes; there is no input mode to restore.
          supportsTerminalInputModeReplay
          characterWidths={characterWidths}
          testId="background-work-output-terminal"
          scrollbackLines={settings.terminalScrollbackLines}
          fontFamily={settings.monoFontFamily.trim() || undefined}
          fontSize={settings.codeFontSize}
          readOnly
          onScrolledChange={setScrolled}
          onRendererReadyChange={handleRendererReadyChange}
        />
        {placeholder ? (
          <View style={styles.placeholderLayer} pointerEvents="none">
            <Text style={styles.placeholder} testID="background-work-output-placeholder">
              {placeholder}
            </Text>
            {hint ? (
              <Text style={styles.placeholderHint} testID="background-work-output-hint">
                {hint}
              </Text>
            ) : null}
          </View>
        ) : null}
        {scrolled ? (
          <Pressable
            onPress={jumpToLatest}
            accessibilityRole="button"
            accessibilityLabel={t("message.backgroundWork.detail.jumpToLatest")}
            style={jumpPillStyle}
            testID="background-work-output-jump"
          >
            <ThemedArrowDown size={ICON_SIZE.sm} />
            <Text style={composerPillStyles.label}>
              {t("message.backgroundWork.detail.jumpToLatest")}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** The source tabs when there are several sources, else the "Output" heading. */
function OutputHeading({
  tabs,
  selected,
  onSelect,
}: {
  tabs: readonly OutputTab[] | undefined;
  selected: string | undefined;
  onSelect: ((id: string) => void) | undefined;
}): ReactElement {
  const { t } = useTranslation();
  if (tabs && onSelect) {
    return <OutputSourceTabs tabs={tabs} selected={selected ?? "provider"} onSelect={onSelect} />;
  }
  return <Text style={styles.heading}>{t("message.backgroundWork.detail.output")}</Text>;
}

/** Until something arrives the box says why it is empty instead of showing a blank surface. */
function emptyBoxText(input: {
  hasOutput: boolean;
  statusText: string | null;
  waitingText: string;
  emptyHint: string | null | undefined;
}): { placeholder: string | null; hint: string | null } {
  if (input.hasOutput) return { placeholder: null, hint: null };
  if (input.statusText) return { placeholder: input.statusText, hint: null };
  return { placeholder: input.waitingText, hint: input.emptyHint ?? null };
}

function jumpPillStyle({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) {
  return [
    composerPillStyles.body,
    (hovered || pressed) && composerPillStyles.bodyActive,
    styles.jumpPill,
  ];
}

function outputStatusText(
  t: ReturnType<typeof useTranslation>["t"],
  status: ReturnType<typeof useBackgroundWorkOutput>["status"],
): string | null {
  if (status === "connecting") return t("message.backgroundWork.detail.outputLoading");
  if (status === "error") return t("message.backgroundWork.detail.outputError");
  if (status === "update-host") return t("message.backgroundWork.detail.updateHost");
  if (status === "disconnected") return t("message.backgroundWork.detail.disconnected");
  return null;
}

const styles = StyleSheet.create((theme) => {
  // The markdown fence (`markdown-styles.ts`): surface2, 1 px border, radius 6. The output gets
  // the inner 8 px so its first column does not touch the border (spec 04 §27c).
  const fence = {
    position: "relative",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[2],
    overflow: "hidden",
  } as const;
  return {
    section: { gap: theme.spacing[2] },
    sectionFill: { flex: 1, minHeight: 0, gap: theme.spacing[2] },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      minHeight: 28,
    },
    headerActions: {
      marginLeft: "auto",
      flexDirection: "row",
      alignItems: "center",
    },
    heading: {
      fontSize: theme.fontSize.xs,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foregroundMuted,
    },
    headerStatus: {
      flexShrink: 1,
      fontSize: theme.fontSize.xs,
      color: theme.colors.foregroundMuted,
    },
    frame: fence,
    frameFill: { ...fence, flex: 1, minHeight: MIN_FILL_HEIGHT },
    placeholderLayer: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: "center",
      justifyContent: "center",
      padding: theme.spacing[4],
    },
    placeholder: {
      fontSize: 13,
      color: theme.colors.foregroundMuted,
      textAlign: "center",
    },
    placeholderHint: {
      marginTop: theme.spacing[1],
      fontSize: theme.fontSize.xs,
      color: theme.colors.foregroundMuted,
      textAlign: "center",
    },
    unavailable: {
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      paddingVertical: theme.spacing[4],
      paddingHorizontal: theme.spacing[3],
      alignItems: "center",
    },
    jumpPill: {
      position: "absolute",
      right: theme.spacing[2],
      bottom: theme.spacing[2],
      ...theme.shadow.sm,
    },
  };
});
