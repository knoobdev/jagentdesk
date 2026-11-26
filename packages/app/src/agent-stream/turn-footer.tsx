import { GUMLOOP_MESSAGE_INDENT } from "@/components/gumloop-shell/chat-layout";
import { useIsGumloopTheme } from "@/components/gumloop-shell/use-gumloop-chrome";
import type { AgentMetric } from "@jagentdesk/protocol/agent-types";
import React, { memo, useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SPACING, type Theme } from "@/styles/theme";
import type { TurnTiming } from "@/timeline/turn-time";
import { getAssistantReply, type StreamItem } from "@/types/stream";
import {
  collectAssistantTurnContentForStreamRenderStrategy,
  type StreamStrategy,
} from "./strategy";
import { resolveAssistantTurnForkBoundary, type AssistantTurnForkBoundary } from "./turn-boundary";
import {
  AssistantTurnFooter,
  LiveElapsed,
  STREAM_METADATA_FONT_SIZE,
  type AssistantForkTarget,
} from "@/components/message";
import type { TurnFooterHost } from "./layout";
import { AssistantForkMenu } from "@/components/assistant-fork-menu";
import { isGuestShareMode } from "@/screens/share/guest-share-mode";
import { SyncedLoader } from "@/components/synced-loader";
import { useRetainedPanelActive } from "@/components/retained-panel";

const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const workingIndicatorColorMapping = (theme: Theme) => ({
  color:
    theme.colorScheme === "light"
      ? theme.colors.palette.amber[700]
      : theme.colors.palette.amber[500],
});
export const TURN_FOOTER_BOTTOM_SPACING = SPACING[8];
// Every footer variant (running, completed with Copy, completed with only its duration) gets
// this content height, so a turn ending swaps the footer's controls without moving the rows
// above it.
const TURN_FOOTER_CONTENT_HEIGHT = 24;

export type TurnContentStrategy = StreamStrategy;
export type AssistantTurnForkHandler = (input: {
  target: AssistantForkTarget;
  boundary: AssistantTurnForkBoundary;
}) => Promise<void> | void;
/**
 * Fork handler for the turn that is still streaming. It deliberately takes no
 * boundary: `selectForkContextRows` projects the entire timeline when neither
 * boundary field is given, which is what captures the partially streamed text
 * the user is watching. Pinning a boundary here would silently drop the live
 * response — the opposite of what a fork button next to the loader promises.
 *
 * Kept separate from `AssistantTurnForkHandler` (whose `boundary` stays
 * required) so the compiler keeps enforcing that completed turns always pin one.
 */
export type InFlightTurnForkHandler = (target: AssistantForkTarget) => Promise<void> | void;

export const TurnFooter = memo(function TurnFooter({
  isRunning,
  inFlightTurnStartedAt,
  host,
  strategy,
  supportsTimelineCursor,
  onForkAssistantTurn,
  onForkInFlightTurn,
}: {
  isRunning: boolean;
  inFlightTurnStartedAt: Date | null;
  host: TurnFooterHost | null;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  if (isRunning) {
    return (
      <TurnFooterRow>
        <RunningTurnFooter
          inFlightTurnStartedAt={inFlightTurnStartedAt}
          onForkInFlightTurn={onForkInFlightTurn}
        />
      </TurnFooterRow>
    );
  }
  if (!host) {
    return null;
  }
  return (
    <CompletedTurnFooterRow
      strategy={strategy}
      items={host.items}
      timing={host.timing}
      startIndex={host.startIndex}
      turnMetrics={host.turnMetrics}
      supportsTimelineCursor={supportsTimelineCursor}
      onForkAssistantTurn={onForkAssistantTurn}
    />
  );
});

export const CompletedTurnFooterRow = memo(function CompletedTurnFooterRow({
  strategy,
  items,
  timing,
  startIndex,
  turnMetrics,
  supportsTimelineCursor,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  turnMetrics?: AgentMetric[];
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  return (
    <TurnFooterRow>
      <CompletedTurnFooter
        strategy={strategy}
        items={items}
        timing={timing}
        startIndex={startIndex}
        turnMetrics={turnMetrics}
        supportsTimelineCursor={supportsTimelineCursor}
        onForkAssistantTurn={onForkAssistantTurn}
      />
    </TurnFooterRow>
  );
});

const WorkingIndicator = memo(function WorkingIndicator({
  inFlightTurnStartedAt = null,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt?: Date | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  const gumloop = useIsGumloopTheme();
  const active = useRetainedPanelActive();
  return (
    <View style={stylesheet.turnFooterContent}>
      <View style={stylesheet.workingLoader}>
        {gumloop ? (
          <View style={stylesheet.thinkingDot} />
        ) : (
          <ThemedSyncedLoader size={14} uniProps={workingIndicatorColorMapping} />
        )}
      </View>
      {gumloop ? <Text style={stylesheet.thinkingLabel}>Thinking…</Text> : null}
      {/* Match the completed-turn footer: actions precede timing metadata. Guests must not fork the
          agent (ADR-0019 — fork_context is out of the guest scope), so hide it on the guest surface. */}
      {onForkInFlightTurn && !isGuestShareMode() ? (
        <AssistantForkMenu onFork={onForkInFlightTurn} />
      ) : null}
      {inFlightTurnStartedAt ? (
        <LiveElapsed
          startedAt={inFlightTurnStartedAt}
          active={active}
          style={stylesheet.workingElapsed}
          testID="turn-working-elapsed"
        />
      ) : null}
    </View>
  );
});

function RunningTurnFooter({
  inFlightTurnStartedAt,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt: Date | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  return (
    <View style={stylesheet.turnFooterSlot} testID="turn-working-indicator">
      <WorkingIndicator
        inFlightTurnStartedAt={inFlightTurnStartedAt}
        onForkInFlightTurn={onForkInFlightTurn}
      />
    </View>
  );
}

function CompletedTurnFooter({
  strategy,
  items,
  timing,
  startIndex,
  turnMetrics,
  supportsTimelineCursor,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  turnMetrics?: AgentMetric[];
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  const getContent = useCallback(
    () =>
      collectAssistantTurnContentForStreamRenderStrategy({
        strategy,
        items,
        startIndex,
      }),
    [strategy, items, startIndex],
  );
  const boundary = resolveAssistantTurnForkBoundary({
    items,
    startIndex,
    supportsTimelineCursor,
  });
  const handleFork = useCallback(
    (target: AssistantForkTarget) => {
      if (!boundary) {
        return;
      }
      return onForkAssistantTurn?.({ target, boundary });
    },
    [boundary, onForkAssistantTurn],
  );
  return (
    <View style={stylesheet.turnFooterSlot}>
      <AssistantTurnFooter
        getContent={getAssistantReply(items[startIndex]) ? getContent : undefined}
        completedAt={timing?.completedAt}
        durationMs={timing?.durationMs ?? undefined}
        onFork={boundary && onForkAssistantTurn ? handleFork : undefined}
        metrics={turnMetrics}
      />
    </View>
  );
}

function TurnFooterRow({ children }: { children: ReactNode }) {
  // The Gumloop chat indents agent turns under the avatar; the footer follows, so the copy
  // glyph lines up with the reply text (spec 38 §4.4).
  const isGumloop = useIsGumloopTheme();
  const rowStyle = useMemo(
    () => [
      stylesheet.streamItemWrapper,
      stylesheet.turnFooterRow,
      isGumloop && stylesheet.turnFooterRowGumloop,
    ],
    [isGumloop],
  );
  return (
    <View style={rowStyle} testID="turn-footer">
      {children}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  thinkingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.accentPink },
  thinkingLabel: { fontSize: 16, color: theme.colors.foregroundMuted },
  streamItemWrapper: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  // The message above drops its bottom padding for the footer (compactBottom), so this margin
  // alone sets the gap. 20 puts the footer as far below the text as the text sits below a
  // tool row: 12 message padding + 4 stream gap + 5 badge padding/border, less the footer's
  // 1px taller row.
  turnFooterRow: {
    marginTop: theme.spacing[4] + theme.spacing[1],
  },
  // Add the indent to the wrapper's own padding; replacing it dropped the footer 8px left of
  // the reply.
  turnFooterRowGumloop: {
    paddingLeft: theme.spacing[2] + GUMLOOP_MESSAGE_INDENT,
  },
  turnFooterSlot: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    minHeight: TURN_FOOTER_CONTENT_HEIGHT + TURN_FOOTER_BOTTOM_SPACING,
    paddingBottom: TURN_FOOTER_BOTTOM_SPACING,
  },
  turnFooterContent: {
    height: TURN_FOOTER_CONTENT_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  workingElapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
  },
  workingLoader: {
    marginLeft: -2,
  },
}));
