import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import TerminalEmulator, { type TerminalEmulatorHandle } from "@/components/terminal-emulator";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import type { TerminalCharacterWidths } from "@/terminal/character-widths";
import type { TerminalRendererReadyChange } from "@/utils/terminal-renderer-readiness";
import { toXtermTheme } from "@/utils/to-xterm-theme";
import { toTerminalText, type BackgroundWorkOutputWrite } from "./output-buffer";
import { useBackgroundWorkOutput } from "./use-detail";

// The theme reaches xterm as a prop, so only this wrapper re-renders on a theme change.
const ThemedTerminalEmulator = withUnistyles(TerminalEmulator, (theme) => ({
  xtermTheme: toXtermTheme(theme.colors.terminal),
}));

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
  /** Height of the terminal; omitted, it fills its parent. */
  height?: number;
}

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
}: BackgroundWorkOutputViewProps): ReactElement {
  const { t } = useTranslation();
  const terminalRef = useRef<TerminalEmulatorHandle>(null);
  const readyRef = useRef(false);
  const [scrolled, setScrolled] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const { status, getBuffer } = useBackgroundWorkOutput({
    serverId,
    agentId,
    itemId,
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
  const copyOutput = useCallback(() => {
    void Clipboard.setStringAsync(getBuffer().text).then(() => setCopied(true));
  }, [getBuffer]);

  const frameStyle = useMemo(
    () => (height === undefined ? styles.frameFill : [styles.frame, { height }]),
    [height],
  );

  if (!outputAvailable) {
    return (
      <View style={styles.unavailable} testID="background-work-output-unavailable">
        <Text style={styles.muted}>
          {t("message.backgroundWork.detail.outputUnavailable", { provider: providerLabel })}
        </Text>
      </View>
    );
  }

  const statusText = outputStatusText(t, status);
  return (
    <View style={height === undefined ? styles.sectionFill : styles.section}>
      <View style={styles.header}>
        <Text style={styles.heading}>{t("message.backgroundWork.detail.output")}</Text>
        {statusText ? (
          <Text style={styles.muted} numberOfLines={1}>
            {statusText}
          </Text>
        ) : null}
        <View style={styles.headerActions}>
          {scrolled ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={jumpToLatest}
              testID="background-work-output-jump"
            >
              {t("message.backgroundWork.detail.jumpToLatest")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onPress={copyOutput}
            testID="background-work-output-copy"
          >
            {copied
              ? t("message.backgroundWork.detail.copied")
              : t("message.backgroundWork.detail.copyOutput")}
          </Button>
        </View>
      </View>
      <View style={frameStyle} testID="background-work-output">
        <ThemedTerminalEmulator
          ref={terminalRef}
          dom={TERMINAL_EMULATOR_DOM_PROPS}
          streamKey={`background-work:${serverId}:${agentId}:${itemId}`}
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
      </View>
    </View>
  );
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

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[2] },
  sectionFill: { flex: 1, minHeight: 0, gap: theme.spacing[2] },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
  },
  headerActions: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  heading: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  muted: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  frame: {
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    backgroundColor: theme.colors.terminal.background,
  },
  frameFill: {
    flex: 1,
    minHeight: 160,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    backgroundColor: theme.colors.terminal.background,
  },
  unavailable: {
    paddingVertical: theme.spacing[3],
  },
}));
