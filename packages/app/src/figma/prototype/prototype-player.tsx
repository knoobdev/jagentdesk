// Prototype player (spec 32.5.3): flow toolbar, the step() state machine wired to timers and
// effects, hotspot hit areas, transition choreography, and overlay stacking. Pixels are drawn by
// the stage; this file only orchestrates. Hotspots render only with the "Show hotspots" toggle
// on; ON_HOVER runs through pointer events on web, taps cover it on native.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { View, Text, Pressable, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type { FigmaNode, FigmaPrototype } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { PrototypePlayerProps } from "@/figma/contracts";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { isWeb } from "@/constants/platform";
import { openExternalUrl } from "@/utils/open-external-url";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";

import { callFigma, errorMessage, figmaKeys } from "./figma-api";
import { FrameStage, type StageSpace } from "./frame-stage";
import {
  afterTimeoutForNode,
  indexInteractions,
  type InteractionMap,
  type ParsedInteraction,
} from "./interactions";
import { findNodeById, nodeBounds, type Rect } from "./node-geometry";
import { placeOverlay } from "./overlay-placement";
import { smartAnimateOverrides } from "./smart-animate";
import { pickStartPosition } from "./start-selection";
import { advanceTimeline, transitionVisuals } from "./transition-timeline";
import {
  baseFrameIdFor,
  currentFrameId,
  DEFAULT_OVERLAY_SETTINGS,
  emptyPlayerState,
  parseOverlayPosition,
  step,
  type OverlayEntry,
  type OverlaySettings,
  type PlayerContext,
  type PlayerEffect,
  type PlayerEvent,
  type PlayerState,
} from "./state-machine";
import { useFigmaFrames, type FrameLookup } from "./use-frames";

const TOAST_MS = 2500;

type Frame = NonNullable<PlayerState["transition"]>;

export function PrototypePlayer({ file, outline, startNodeId, onClose }: PrototypePlayerProps) {
  const client = useHostRuntimeClient(file.serverId);
  const [player, setPlayer] = useState(emptyPlayerState);
  const [showHotspots, setShowHotspots] = useState(true);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [scrollRequest, setScrollRequest] = useState<{ frameId: string; targetId: string } | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const prototypeRequest = useFetchQuery<FigmaPrototype | null>({
    queryKey: figmaKeys.prototype(file.serverId, file.fileKey, file.version ?? null),
    queryFn: async () => {
      const data = await callFigma(client, "figma.file.prototype.request", {
        fileKey: file.fileKey,
      });
      return data.prototype;
    },
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: 60_000,
  });
  const prototype = prototypeRequest.data ?? null;

  const flows = useMemo(() => {
    const wire = prototype?.flows ?? [];
    if (wire.length > 0) return wire;
    return outline.pages.flatMap((page) =>
      page.flowStartingPoints.map((point) => ({
        nodeId: point.nodeId,
        name: point.name,
        pageId: page.id,
      })),
    );
  }, [prototype, outline]);

  const interactions = useMemo(() => indexInteractions(prototype?.interactions ?? []), [prototype]);

  const startChoice = useMemo(() => pickStartPosition(flows, outline), [flows, outline]);
  const [startNote, setStartNote] = useState<string | null>(null);

  const overlaySettings = useMemo(() => {
    const map = new Map<string, OverlaySettings>();
    for (const overlay of prototype?.overlays ?? []) {
      map.set(overlay.frameId, {
        position: parseOverlayPosition(overlay.position),
        dimColor: overlayDimColor(overlay.background),
        closeOnClickOutside: overlay.closeOnClickOutside ?? true,
      });
    }
    return map;
  }, [prototype]);

  const context: PlayerContext = useMemo(
    () => ({
      now_ms: () => Date.now(),
      overlaySettingsFor: (frameId) => overlaySettings.get(frameId) ?? DEFAULT_OVERLAY_SETTINGS,
      afterTimeoutFor: (frameId) => afterTimeoutForNode(interactions, frameId),
    }),
    [overlaySettings, interactions],
  );

  const applyEffect = useCallback((effect: PlayerEffect) => {
    if (effect.kind === "open_url") {
      openExternalUrl(effect.url);
      setToast(`Opening ${effect.url}`);
      return;
    }
    setScrollRequest({ frameId: effect.frameId, targetId: effect.targetId });
  }, []);

  const dispatch = useCallback(
    (event: PlayerEvent) => {
      const outcome = step(player, event, context);
      setPlayer(outcome.state);
      for (const effect of outcome.effects) applyEffect(effect);
    },
    [player, context, applyEffect],
  );

  const dispatchStart = useCallback(
    (frameId: string) => dispatch({ type: "start", frameId }),
    [dispatch],
  );

  const activeFrameId = currentFrameId(player);

  const neededIds = useMemo(() => {
    const ids = [...player.stack, ...player.overlays.map((entry) => entry.frameId)];
    if (player.transition) {
      ids.push(player.transition.fromFrameId, player.transition.toFrameId);
    }
    return Array.from(new Set(ids));
  }, [player]);
  const frames = useFigmaFrames(file, neededIds);

  // Deep link / file-screen entry: start on the requested node.
  useEffect(() => {
    if (startNodeId) dispatchStart(startNodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startNodeId]);

  // No start point from the caller: pick one ourselves once the flows are known, so the player
  // never sits on an endless spinner waiting for a hand-picked flow. The first flow wins; with no
  // flows the first top-level frame does, and the toolbar says so.
  useEffect(() => {
    if (startNodeId || player.startFrameId || prototypeRequest.isPending) return;
    if (!startChoice) return;
    dispatchStart(startChoice.frameId);
    setStartNote(startChoice.note);
  }, [startNodeId, player.startFrameId, prototypeRequest.isPending, startChoice, dispatchStart]);

  // AFTER_TIMEOUT for the frame on stage; the machine re-checks arrival before firing.
  useEffect(() => {
    if (!player.timeout) return;
    const timer = setTimeout(() => dispatch({ type: "timeout_fire" }), player.timeout.delayMs);
    return () => clearTimeout(timer);
  }, [player.timeout, dispatch]);

  // Transition clock: rAF only while a transition runs; completion goes through the machine.
  useEffect(() => {
    if (!player.transition) return;
    let raf = 0;
    const loop = () => {
      setClock(Date.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [player.transition]);

  const transition = player.transition;
  const timeline = transition
    ? advanceTimeline(transition.plan, Math.max(0, clock - transition.startedAt_ms))
    : null;

  useEffect(() => {
    if (transition && timeline?.done) dispatch({ type: "transition_complete" });
  }, [transition, timeline, dispatch]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const onMeasure = useCallback((event: LayoutChangeEvent) => {
    setStage({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
  }, []);

  const triggerInteraction = useCallback(
    (interaction: ParsedInteraction) =>
      dispatch({ type: "interaction", action: interaction.action }),
    [dispatch],
  );
  const dismissTopOverlay = useCallback(() => dispatch({ type: "overlay_dismiss" }), [dispatch]);
  const goBack = useCallback(() => dispatch({ type: "toolbar_back" }), [dispatch]);
  const restart = useCallback(() => dispatch({ type: "toolbar_restart" }), [dispatch]);
  const retryPrototype = useCallback(() => {
    void prototypeRequest.refetch();
  }, [prototypeRequest]);

  // G5 bug 2: the base canvas follows the frame STACK, never the top overlay. Making it follow
  // currentFrameId replaced the frame behind an open sheet, so the backdrop was flat grey.
  const baseFrameId = baseFrameIdFor(player);
  const root = baseFrameId ? frames.nodeFor(baseFrameId) : null;
  const baseBounds = root ? nodeBounds(root) : null;
  const renderHotspotsFor = useCallback(
    (frameRoot: FigmaNode | null, space: StageSpace) => (
      <HotspotsLayer
        interactions={interactions}
        root={frameRoot}
        space={space}
        onTrigger={triggerInteraction}
      />
    ),
    [interactions, triggerInteraction],
  );
  const renderHotspots = useCallback(
    (space: StageSpace) => renderHotspotsFor(root, space),
    [renderHotspotsFor, root],
  );

  const overlayNote =
    prototype && !prototype.overlaySettingsAvailable ? "Overlay settings need Figma Link" : null;

  if (prototypeRequest.error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>{errorMessage(prototypeRequest.error)}</Text>
        <Button variant="outline" size="sm" onPress={retryPrototype}>
          Retry
        </Button>
      </View>
    );
  }
  if (flows.length === 0 && !startChoice && !prototypeRequest.isPending) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No prototype flows in this file.</Text>
        <Button variant="outline" size="sm" onPress={onClose}>
          Close
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <PlayerToolbar
        flows={flows}
        startFrameId={player.startFrameId}
        canGoBack={player.stack.length > 1 || player.overlays.length > 0}
        canRestart={!!player.startFrameId}
        showHotspots={showHotspots}
        onStartFlow={dispatchStart}
        onBack={goBack}
        onRestart={restart}
        onToggleHotspots={setShowHotspots}
        onClose={onClose}
        overlayNote={overlayNote}
        startNote={startNote}
      />
      <View style={styles.stageHost} onLayout={onMeasure}>
        {toast ? <Text style={styles.toast}>{toast}</Text> : null}
        <PlayerStage
          file={file}
          transition={transition}
          timeline={timeline}
          frames={frames}
          stage={stage}
          root={root}
          activeFrameId={activeFrameId}
          scrollRequest={scrollRequest}
          renderHotspots={renderHotspots}
          showHotspots={showHotspots}
          loadingPrototype={prototypeRequest.isPending}
          flows={flows}
          onStartFlow={dispatchStart}
        />
        {player.overlays.length > 0 ? (
          <OverlayStack
            file={file}
            frames={frames}
            overlays={player.overlays}
            stage={stage}
            base={baseBounds}
            interactions={interactions}
            showHotspots={showHotspots}
            onTrigger={triggerInteraction}
            onDismiss={dismissTopOverlay}
          />
        ) : null}
      </View>
    </View>
  );
}

function scrollTarget(
  request: { frameId: string; targetId: string } | null,
  frameId: string | null,
): string | null {
  if (!request || !frameId || request.frameId !== frameId) return null;
  return request.targetId;
}

export function PlayerStage({
  file,
  transition,
  timeline,
  frames,
  stage,
  root,
  activeFrameId,
  scrollRequest,
  renderHotspots,
  showHotspots,
  loadingPrototype,
  flows,
  onStartFlow,
}: {
  file: PrototypePlayerProps["file"];
  transition: Frame | null;
  timeline: ReturnType<typeof advanceTimeline> | null;
  frames: FrameLookup;
  stage: { width: number; height: number };
  root: FigmaNode | null;
  activeFrameId: string | null;
  scrollRequest: { frameId: string; targetId: string } | null;
  renderHotspots: (space: StageSpace) => ReactNode;
  showHotspots: boolean;
  loadingPrototype: boolean;
  flows: FigmaPrototype["flows"];
  onStartFlow: (frameId: string) => void;
}) {
  if (transition && timeline) {
    return (
      <TransitionPair
        file={file}
        transition={transition}
        timeline={timeline}
        frames={frames}
        stage={stage}
      />
    );
  }
  if (!root) {
    // The spinner means "frames are actually loading" — nothing else. A file with no start point
    // shows a Choose-flow prompt instead of spinning forever.
    if (loadingPrototype || frames.loading) {
      return (
        <View style={styles.centered}>
          <LoadingSpinner size="small" color={styles.spinner.color} />
        </View>
      );
    }
    if (frames.error) {
      return (
        <View style={styles.centered}>
          <Text style={styles.muted}>{frames.error}</Text>
        </View>
      );
    }
    if (flows.length > 0) {
      return <ChooseFlowPrompt flows={flows} onStartFlow={onStartFlow} />;
    }
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No prototype flows in this file.</Text>
      </View>
    );
  }
  return (
    <FrameStage
      file={file}
      root={root}
      width={stage.width}
      height={stage.height}
      scrollToContentNodeId={scrollTarget(scrollRequest, activeFrameId)}
      renderOverlay={showHotspots ? renderHotspots : undefined}
    />
  );
}

/** Shown when nothing has started and the endless-spinner default would lie: pick a flow by hand. */
function ChooseFlowPrompt({
  flows,
  onStartFlow,
}: {
  flows: FigmaPrototype["flows"];
  onStartFlow: (frameId: string) => void;
}) {
  return (
    <View style={styles.centered} testID="figma-choose-flow">
      <Text style={styles.muted}>Choose a flow</Text>
      {flows.map((flow) => (
        <FlowRow key={flow.nodeId} flow={flow} onStartFlow={onStartFlow} />
      ))}
    </View>
  );
}

function FlowRow({
  flow,
  onStartFlow,
}: {
  flow: FigmaPrototype["flows"][number];
  onStartFlow: (frameId: string) => void;
}) {
  const start = useCallback(() => onStartFlow(flow.nodeId), [onStartFlow, flow.nodeId]);
  return (
    <Pressable style={styles.flowRow} onPress={start} accessibilityRole="button">
      <Text style={styles.flowRowLabel}>{flow.name}</Text>
    </Pressable>
  );
}

// ── Toolbar ────────────────────────────────────────────────────────────────

// Exported for tests. The label tracks the frame the player STARTED on, not the frame currently
// on stage: navigating inside a played flow must not drop it back to "Select a flow".
export function PlayerToolbar({
  flows,
  startFrameId,
  canGoBack,
  canRestart,
  showHotspots,
  onStartFlow,
  onBack,
  onRestart,
  onToggleHotspots,
  onClose,
  overlayNote,
  startNote,
}: {
  flows: FigmaPrototype["flows"];
  startFrameId: string | null;
  canGoBack: boolean;
  canRestart: boolean;
  showHotspots: boolean;
  onStartFlow: (frameId: string) => void;
  onBack: () => void;
  onRestart: () => void;
  onToggleHotspots: (value: boolean) => void;
  onClose: () => void;
  overlayNote: string | null;
  startNote: string | null;
}) {
  return (
    <View style={styles.toolbar}>
      <DropdownMenu>
        <DropdownMenuTrigger style={styles.trigger}>
          <Text style={styles.triggerLabel} numberOfLines={1}>
            {currentFlowLabel(flows, startFrameId)}
          </Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {flows.map((flow) => (
            <FlowMenuItem key={flow.nodeId} flow={flow} onStartFlow={onStartFlow} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <View style={styles.navGroup}>
        <Button variant="ghost" size="sm" onPress={onBack} disabled={!canGoBack}>
          Back
        </Button>
        <Button variant="ghost" size="sm" onPress={onRestart} disabled={!canRestart}>
          Restart
        </Button>
      </View>
      <View style={styles.hotspotToggle}>
        <Text style={styles.muted}>Show hotspots</Text>
        <Switch
          value={showHotspots}
          onValueChange={onToggleHotspots}
          testID="figma-show-hotspots"
        />
      </View>
      {overlayNote ? <Text style={styles.note}>{overlayNote}</Text> : null}
      {startNote ? <Text style={styles.note}>{startNote}</Text> : null}
      <Button variant="ghost" size="sm" onPress={onClose}>
        Close
      </Button>
    </View>
  );
}

function FlowMenuItem({
  flow,
  onStartFlow,
}: {
  flow: FigmaPrototype["flows"][number];
  onStartFlow: (frameId: string) => void;
}) {
  const start = useCallback(() => onStartFlow(flow.nodeId), [onStartFlow, flow]);
  return <DropdownMenuItem onSelect={start}>{flow.name}</DropdownMenuItem>;
}

/** Name of the flow being played — resolved from the session's start frame, not the stage. */
function currentFlowLabel(flows: FigmaPrototype["flows"], startFrameId: string | null): string {
  const flow = startFrameId ? flows.find((candidate) => candidate.nodeId === startFrameId) : null;
  return flow ? flow.name : "Select a flow";
}

// ── Transitions ────────────────────────────────────────────────────────────

function TransitionPair({
  file,
  transition,
  timeline,
  frames,
  stage,
}: {
  file: PrototypePlayerProps["file"];
  transition: Frame;
  timeline: ReturnType<typeof advanceTimeline>;
  frames: FrameLookup;
  stage: { width: number; height: number };
}) {
  const from = frames.nodeFor(transition.fromFrameId);
  const to = frames.nodeFor(transition.toFrameId);
  if (!from || !to) return null;
  const visuals = transitionVisuals(transition.plan, timeline.eased);
  const smart =
    transition.plan.type === "SMART_ANIMATE"
      ? smartAnimateOverrides(from, to, clamped(timeline.eased))
      : null;
  return (
    <View style={styles.transitionHost} pointerEvents="none">
      <TransitionSide
        file={file}
        root={from}
        stage={stage}
        opacity={visuals.fromOpacity}
        offsetX={visuals.fromOffset.x * stage.width}
        offsetY={visuals.fromOffset.y * stage.height}
        overrides={smart ? smart.from : undefined}
      />
      <TransitionSide
        file={file}
        root={to}
        stage={stage}
        opacity={visuals.toOpacity}
        offsetX={visuals.toOffset.x * stage.width}
        offsetY={visuals.toOffset.y * stage.height}
        overrides={smart ? smart.to : undefined}
      />
    </View>
  );
}

function TransitionSide({
  file,
  root,
  stage,
  opacity,
  offsetX,
  offsetY,
  overrides,
}: {
  file: PrototypePlayerProps["file"];
  root: FigmaNode;
  stage: { width: number; height: number };
  opacity: number;
  offsetX: number;
  offsetY: number;
  overrides?: Record<string, Partial<FigmaNode>>;
}) {
  const layerStyle = { opacity, transform: [{ translateX: offsetX }, { translateY: offsetY }] };
  return (
    <View style={[styles.transitionSide, layerStyle]}>
      <FrameStage
        file={file}
        root={root}
        width={stage.width}
        height={stage.height}
        overrides={overrides}
      />
    </View>
  );
}

function overlayDimColor(background: { type: string; color?: string } | undefined): string {
  if (!background || background.type === "NONE") return "";
  return background.color ?? DEFAULT_OVERLAY_SETTINGS.dimColor;
}

function clamped(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ── Hotspots ───────────────────────────────────────────────────────────────

interface HotspotEntry {
  node: FigmaNode;
  interaction: ParsedInteraction;
}

function HotspotsLayer({
  interactions,
  root,
  space,
  onTrigger,
}: {
  interactions: InteractionMap;
  root: FigmaNode | null;
  space: StageSpace;
  onTrigger: (interaction: ParsedInteraction) => void;
}) {
  if (!root) return null;
  const hotspots = collectHotspots(interactions, root);
  return (
    <View style={styles.hotspotsLayer} pointerEvents="box-none">
      {hotspots.map((entry) => (
        <Hotspot key={hotspotKey(entry)} entry={entry} space={space} onTrigger={onTrigger} />
      ))}
    </View>
  );
}

function hotspotKey(entry: HotspotEntry): string {
  return `${entry.node.id}:${entry.interaction.trigger}:${entry.interaction.action.kind}`;
}

// Hotspot hit areas sit over the interaction nodes themselves.
function collectHotspots(interactions: InteractionMap, root: FigmaNode): HotspotEntry[] {
  const entries: HotspotEntry[] = [];
  for (const [nodeId, list] of interactions) {
    const node = findNodeById(root, nodeId);
    if (!node) continue;
    for (const interaction of list) entries.push({ node, interaction });
  }
  return entries;
}

function Hotspot({
  entry,
  space,
  onTrigger,
}: {
  entry: HotspotEntry;
  space: StageSpace;
  onTrigger: (interaction: ParsedInteraction) => void;
}) {
  const box = space.boxOf(entry.node);
  const press = useCallback(() => onTrigger(entry.interaction), [onTrigger, entry]);
  const hover = useCallback(() => {
    if (isWeb && entry.interaction.trigger === "ON_HOVER") onTrigger(entry.interaction);
  }, [entry, onTrigger]);
  if (!box) return null;
  const hotspotStyle = { left: box.x, top: box.y, width: box.width, height: box.height };
  // ON_CLICK and (on native) ON_HOVER fire on press; ON_PRESS fires on press-in; web hover is
  // handled by onPointerEnter.
  const clickable =
    entry.interaction.trigger === "ON_CLICK" ||
    (!isWeb && entry.interaction.trigger === "ON_HOVER");
  const onPress = clickable ? press : undefined;
  const onPressIn = entry.interaction.trigger === "ON_PRESS" ? press : undefined;
  return (
    <View style={[styles.hotspot, hotspotStyle]} onPointerEnter={hover}>
      <Pressable
        style={styles.hotspotPressable}
        onPress={onPress}
        onPressIn={onPressIn}
        accessibilityRole="button"
        accessibilityLabel={entry.node.name}
      />
    </View>
  );
}

// ── Overlays ───────────────────────────────────────────────────────────────

// Exported for tests. Layers paint in stack order (last = topmost): each layer's dim backdrop
// covers the stage, then its sheet sits at the base frame's scale per `placeOverlay`. The sheet
// draws its own hotspots through the same HotspotsLayer the base frame uses, mapped through the
// overlay placement (same scale + offset) — G5 r2.
export function OverlayStack({
  file,
  frames,
  overlays,
  stage,
  base,
  interactions,
  showHotspots,
  onTrigger,
  onDismiss,
}: {
  file: PrototypePlayerProps["file"];
  frames: FrameLookup;
  overlays: OverlayEntry[];
  stage: { width: number; height: number };
  /** Bounds of the frame the overlays sit on top of (G5 bug 2: it stays on stage). */
  base: Rect | null;
  interactions: InteractionMap;
  showHotspots: boolean;
  onTrigger: (interaction: ParsedInteraction) => void;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.overlayStack} pointerEvents="box-none">
      {overlays.map((entry) => (
        <OverlayLayer
          key={entry.frameId}
          file={file}
          entry={entry}
          frames={frames}
          stage={stage}
          base={base}
          interactions={interactions}
          showHotspots={showHotspots}
          onTrigger={onTrigger}
          onDismiss={onDismiss}
        />
      ))}
    </View>
  );
}

function OverlayLayer({
  file,
  entry,
  frames,
  stage,
  base,
  interactions,
  showHotspots,
  onTrigger,
  onDismiss,
}: {
  file: PrototypePlayerProps["file"];
  entry: OverlayEntry;
  frames: FrameLookup;
  stage: { width: number; height: number };
  base: Rect | null;
  interactions: InteractionMap;
  showHotspots: boolean;
  onTrigger: (interaction: ParsedInteraction) => void;
  onDismiss: () => void;
}) {
  const root = frames.nodeFor(entry.frameId);
  const close = entry.settings.closeOnClickOutside ? onDismiss : undefined;
  const keepOpen = useCallback(() => !entry.settings.closeOnClickOutside, [entry]);
  const renderOverlay = useCallback(
    (space: StageSpace) => (
      <HotspotsLayer interactions={interactions} root={root} space={space} onTrigger={onTrigger} />
    ),
    [interactions, root, onTrigger],
  );
  if (!root || !base) return null;
  const overlay = nodeBounds(root);
  if (!overlay) return null;
  // G5 bug 1: the sheet fits the BASE frame's box, not the stage — same scale, same origin.
  const placement = placeOverlay({
    stageWidth: stage.width,
    stageHeight: stage.height,
    baseWidth: base.width,
    baseHeight: base.height,
    overlayWidth: overlay.width,
    overlayHeight: overlay.height,
    position: entry.settings.position,
  });
  if (!placement) return null;
  const hostStyle = entry.settings.dimColor
    ? [styles.overlayHost, { backgroundColor: entry.settings.dimColor }]
    : styles.overlayHost;
  return (
    <Pressable
      style={hostStyle}
      onPress={close}
      accessibilityRole="button"
      testID={`figma-overlay-host-${entry.frameId}`}
    >
      <View
        onStartShouldSetResponder={keepOpen}
        testID={`figma-overlay-sheet-${entry.frameId}`}
        style={[
          styles.overlaySheet,
          {
            left: placement.x,
            top: placement.y,
            width: placement.width,
            height: placement.height,
          },
        ]}
      >
        <FrameStage
          file={file}
          root={root}
          width={placement.width}
          height={placement.height}
          scroll={false}
          renderOverlay={showHotspots ? renderOverlay : undefined}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surfaceWorkspace },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  navGroup: { flexDirection: "row", gap: theme.spacing[1] },
  hotspotToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    marginLeft: "auto",
  },
  trigger: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface1,
  },
  triggerLabel: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  note: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  muted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  stageHost: { flex: 1, position: "relative" },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  spinner: { color: theme.colors.foregroundMuted },
  flowRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    minWidth: 200,
  },
  flowRowLabel: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  toast: {
    position: "absolute",
    bottom: theme.spacing[3],
    left: theme.spacing[3],
    right: theme.spacing[3],
    textAlign: "center",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    zIndex: 10,
  },
  transitionHost: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  transitionSide: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  hotspotsLayer: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  hotspot: { position: "absolute" },
  hotspotPressable: {
    flex: 1,
    borderWidth: theme.borderWidth[1],
    borderColor: "rgba(59, 130, 246, 0.6)",
    borderRadius: theme.borderRadius.sm,
    backgroundColor: "rgba(59, 130, 246, 0.08)",
  },
  overlayStack: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  overlayHost: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  // Positioned by `placeOverlay` — the sheet never covers the whole stage.
  overlaySheet: { position: "absolute", overflow: "hidden" },
}));
