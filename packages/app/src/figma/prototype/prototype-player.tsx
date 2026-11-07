// Prototype player (spec 32.5.3): flow toolbar, the step() state machine wired to timers and
// effects, hotspot hit areas, transition choreography, and overlay stacking. Pixels are drawn by
// the stage; this file only orchestrates. Hotspots render only with the "Show hotspots" toggle
// on; ON_HOVER runs through pointer events on web, taps cover it on native.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View, Text, Pressable, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type {
  FigmaNode,
  FigmaOutline,
  FigmaPrototype,
} from "@jagentdesk/protocol/figma/rpc-schemas";
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
import { useHostFeature } from "@/runtime/host-features";
import { retryFigmaFlowPage, useFigmaFlowPageOutline } from "@/figma/page-outline";
import type { Theme } from "@/styles/theme";

import { PrototypeAssetScopeProvider } from "./asset-scope";
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
import { pickStartPosition, resolveRequestedStart } from "./start-selection";
import { advanceTimeline, transitionVisuals } from "./transition-timeline";
import {
  baseFrameIdFor,
  currentFrameId,
  DEFAULT_OVERLAY_SETTINGS,
  emptyPlayerState,
  parseOverlayPosition,
  step,
  visibleFrameIds,
  type ActiveTransition,
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

export function PrototypePlayer(props: PrototypePlayerProps) {
  // Gate once on the capability (docs/protocol-compatibility.md): a host without scoped playback
  // never receives `figma.file.playback.request`; there is no fallback to the full prototype RPC.
  const supported = useHostFeature(props.file.serverId, "figmaPlayback");
  if (!supported) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>
          Update this host to use prototype playback without loading the whole file.
        </Text>
        <Button variant="outline" onPress={props.onClose}>
          Close
        </Button>
      </View>
    );
  }
  return <ScopedPrototypePlayer {...props} />;
}

// Deep link resolution lives in a hook so the Section/flow-start branches stay out of the
// component's complexity budget (ADR-0039). A known container resolves inward to a playable
// frame; with nothing playable the player prompts for a frame instead of loading the subtree,
// and no playback batch is ever issued for the container itself.
function useRequestedStart(
  startNodeId: string | null,
  outline: FigmaOutline,
  identity: string,
  dispatchStart: (frameId: string) => void,
): string | null {
  const [prompt, setPrompt] = useState<string | null>(null);
  useEffect(() => {
    if (!startNodeId) return;
    const decision = resolveRequestedStart(startNodeId, outline);
    if (decision.frameId) {
      setPrompt(null);
      dispatchStart(decision.frameId);
    } else {
      setPrompt(
        `"${decision.containerName}" is a section with no playable frame in this file. Select a frame to play.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startNodeId, identity]);
  return prompt;
}

// One `frame_ready` dispatch per (snapshot identity, visit, data state): the known-delay
// field flips when interactions arrive after navigation — re-firing the arm so the countdown
// starts — while clock ticks and callback-identity re-renders never replay a fired timer.
function useFrameReadyArm(
  activeFrameId: string | null,
  activeRoot: FigmaNode | null,
  player: PlayerState,
  interactions: InteractionMap,
  identity: string,
  dispatch: (event: PlayerEvent) => void,
): void {
  const readySignature =
    activeFrameId && activeRoot && !player.transition
      ? `${identity}|${activeFrameId}|${player.stack.length}|${player.overlays.length}|${
          afterTimeoutForNode(interactions, activeFrameId)?.delayMs ?? -1
        }`
      : null;
  const lastArmedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!readySignature || !activeFrameId) return;
    if (lastArmedRef.current === readySignature) return;
    lastArmedRef.current = readySignature;
    dispatch({ type: "frame_ready", frameId: activeFrameId });
  }, [readySignature, activeFrameId, dispatch]);
}

// The transition's per-frame clock, gated on BOTH frames of the pair being loaded (ADR-0037):
// ticking while the target is still in flight finishes unseen and lands the player on a frame
// it never drew. Completion is reported to the machine, not applied here.
function useTransitionClock(
  transition: ActiveTransition | null,
  frames: FrameLookup,
  dispatch: (event: PlayerEvent) => void,
): ReturnType<typeof advanceTimeline> | null {
  const [clock, setClock] = useState(() => Date.now());
  const pairLoaded =
    transition !== null &&
    frames.nodeFor(transition.fromFrameId) !== null &&
    frames.nodeFor(transition.toFrameId) !== null;
  const clockRef = useRef<{ key: string; at_ms: number } | null>(null);
  if (transition === null) {
    clockRef.current = null;
  } else if (pairLoaded) {
    const key = `${transition.startedAt_ms}->${transition.fromFrameId}->${transition.toFrameId}`;
    if (clockRef.current?.key !== key) {
      clockRef.current = { key, at_ms: Date.now() };
    }
  }

  // rAF only while a transition actually animates; completion goes through the machine.
  useEffect(() => {
    if (!pairLoaded) return;
    let raf = 0;
    const loop = () => {
      setClock(Date.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pairLoaded]);

  const timeline =
    transition && clockRef.current
      ? advanceTimeline(transition.plan, Math.max(0, clock - clockRef.current.at_ms))
      : null;

  useEffect(() => {
    if (transition && pairLoaded && timeline?.done) {
      dispatch({ type: "transition_complete" });
    }
  }, [transition, pairLoaded, timeline, dispatch]);

  return timeline;
}

interface FlowPageOption {
  id: string;
  name: string;
  loaded: boolean;
}

// ADR-0043 flow-page selection: which page's flows the player lists, the on-demand outline read
// of a page the canvas has not read, and that read's loading/error/Retry status. One hook so the
// player component itself stays a plain orchestrator.
function useFlowPages(
  file: PrototypePlayerProps["file"],
  outline: FigmaOutline,
  playbackVersion: string,
) {
  const paged = useMemo(
    () => outline.pages.some((page) => page.childrenLoaded === false),
    [outline],
  );
  const readFlowsByPage = useMemo(() => {
    const map = new Map<string, FigmaPrototype["flows"]>();
    for (const page of outline.pages) {
      if (page.childrenLoaded === false) continue;
      map.set(
        page.id,
        page.flowStartingPoints.map((point) => ({
          nodeId: point.nodeId,
          name: point.name,
          pageId: page.id,
        })),
      );
    }
    return map;
  }, [outline]);
  const [browsedPageId, setBrowsedPageId] = useState<string | null>(null);
  const browsedExplicitly = useRef(false);
  // The page whose flows the player lists: the user's explicit browse, else the first page the
  // canvas has already read — opening the player from the canvas never waits on a new read.
  const firstReadPageId = useMemo(
    () => outline.pages.find((page) => page.childrenLoaded !== false)?.id ?? null,
    [outline],
  );
  const flowPageId = browsedPageId ?? firstReadPageId;
  const flowPageKnown = flowPageId !== null && readFlowsByPage.has(flowPageId);
  const flowPage = useFigmaFlowPageOutline(
    file.serverId,
    file.fileKey,
    paged ? playbackVersion : null,
    paged && !flowPageKnown ? flowPageId : null,
  );

  const flows = useMemo(() => {
    if (!flowPageId) return [];
    const known = readFlowsByPage.get(flowPageId);
    if (known) return known;
    return (flowPage.data?.pages ?? []).flatMap((page) =>
      page.flowStartingPoints.map((point) => ({
        nodeId: point.nodeId,
        name: point.name,
        pageId: page.id,
      })),
    );
  }, [flowPageId, readFlowsByPage, flowPage.data]);

  // Flow names must survive page browsing: the label of a PLAYING flow resolves from every
  // flow the session has listed so far, not only the page currently browsed.
  const flowsSeenRef = useRef<FigmaPrototype["flows"]>([]);
  const knownFlows = useMemo(() => {
    if (flows.length === 0) return flowsSeenRef.current;
    const seen = new Map(flowsSeenRef.current.map((flow) => [flow.nodeId, flow]));
    for (const flow of flows) seen.set(flow.nodeId, flow);
    flowsSeenRef.current = Array.from(seen.values());
    return flowsSeenRef.current;
  }, [flows]);

  const flowPageName = useMemo(
    () =>
      flowPageId ? (outline.pages.find((page) => page.id === flowPageId)?.name ?? null) : null,
    [outline.pages, flowPageId],
  );

  // On-demand page read status: pending is NOT "no flows" — the toolbar names the page being
  // read, and a failed read keeps Retry available (spec 32.5.3 error contract).
  const [flowPageRetrying, setFlowPageRetrying] = useState(false);
  const retryAbort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      retryAbort.current?.abort();
    },
    [],
  );
  // A page switch retires the previous read's in-flight retry; its result must not land as
  // this page's status.
  useEffect(() => {
    retryAbort.current?.abort();
    retryAbort.current = null;
    setFlowPageRetrying(false);
  }, [flowPageId]);

  const flowPageNote = useMemo(() => {
    if (!paged || !flowPageId || flowPageKnown) return null;
    const name = flowPageName ?? "this page";
    const detail =
      flowPage.error instanceof Error ? flowPage.error.message : (flowPage.error ?? null);
    if (flowPage.error)
      return detail
        ? `Flows on "${name}" failed to load: ${detail}`
        : `Flows on "${name}" failed to load.`;
    if (flowPage.isPending) return `Loading flows on "${name}"…`;
    return null;
  }, [paged, flowPageId, flowPageKnown, flowPageName, flowPage.error, flowPage.isPending]);

  const onRetryFlowPage = useCallback(() => {
    if (!flowPageId) return;
    retryAbort.current?.abort();
    const abort = new AbortController();
    retryAbort.current = abort;
    setFlowPageRetrying(true);
    void retryFigmaFlowPage(file.serverId, flowPage.refetch, abort.signal)
      .catch(() => {})
      .finally(() => {
        if (retryAbort.current === abort) {
          retryAbort.current = null;
          setFlowPageRetrying(false);
        }
      });
  }, [file.serverId, flowPageId, flowPage.refetch]);

  const onSelectFlowPage = useCallback((pageId: string) => {
    browsedExplicitly.current = true;
    setBrowsedPageId(pageId);
  }, []);

  // A file/version swap under an open player retires the browse and any in-flight retry.
  const resetFlowPages = useCallback(() => {
    setBrowsedPageId(null);
    browsedExplicitly.current = false;
    retryAbort.current?.abort();
    retryAbort.current = null;
    setFlowPageRetrying(false);
  }, []);

  const flowPageOptions = useMemo<FlowPageOption[]>(
    () =>
      outline.pages.map((page) => ({
        id: page.id,
        name: page.name,
        loaded: page.childrenLoaded !== false,
      })),
    [outline.pages],
  );

  // The browsed page's flows are being read on demand; pending is not "no flows".
  const flowsLoading = paged && flowPageId !== null && !flowPageKnown ? flowPage.isPending : false;
  const emptyFlowsMessage = useMemo(() => {
    if (!paged) return null;
    return `No flows on "${flowPageName ?? "this page"}". Choose another page from the pages menu.`;
  }, [paged, flowPageName]);

  return {
    paged,
    flows,
    knownFlows,
    flowPageId,
    flowPageOptions,
    flowPageNote,
    flowPageRetrying,
    flowsLoading,
    emptyFlowsMessage,
    browsedExplicitly,
    onSelectFlowPage,
    onRetryFlowPage,
    resetFlowPages,
  };
}

function ScopedPrototypePlayer({ file, outline, startNodeId, onClose }: PrototypePlayerProps) {
  const [player, setPlayer] = useState(emptyPlayerState);
  const [showHotspots, setShowHotspots] = useState(true);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [scrollRequest, setScrollRequest] = useState<{ frameId: string; targetId: string } | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);

  const activeFrameId = currentFrameId(player);
  const neededIds = useMemo(() => visibleFrameIds(player), [player]);
  // ADR-0037: playback pins to the outline's immutable version so every batch — and the daemon
  // cache behind it — reads one snapshot, even if the file changes while the player is open.
  const playbackVersion = file.version ?? outline.version;
  const frames = useFigmaFrames(file, neededIds, playbackVersion);
  const prototype = frames.prototype;

  // Flow starts come from the outline only (spec 32.5.3 / ADR-0037) — the full prototype RPC
  // would fetch every frame in the file just to enumerate them. On paged hosts (ADR-0043) the
  // flow-page selection, the on-demand page read and its Retry status live in useFlowPages.
  const {
    paged,
    flows,
    knownFlows,
    flowPageId,
    flowPageOptions,
    flowPageNote,
    flowPageRetrying,
    flowsLoading,
    emptyFlowsMessage,
    browsedExplicitly,
    onSelectFlowPage,
    onRetryFlowPage,
    resetFlowPages,
  } = useFlowPages(file, outline, playbackVersion);

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

  // A file/version swap under an open player leaves navigation state pointing into a snapshot
  // it no longer matches: reset the machine and start the new version from scratch, so no
  // callback, timer, or frame lookup keeps firing against the previous file.
  const identity = `${file.serverId}|${file.fileKey}|${playbackVersion}`;
  const identityRef = useRef(identity);
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    setPlayer(emptyPlayerState());
    setToast(null);
    setScrollRequest(null);
    setStartNote(null);
    resetFlowPages();
  }, [identity, resetFlowPages]);

  // Deep link / file-screen entry: start on the requested node. A known Section (or other
  // container) never plays itself — W5's outline flattens its real frames onto the page with
  // parentId, so the player resolves inward to a playable frame instead of pulling the whole
  // section subtree through playback, and asks for a frame when nothing playable is known
  // (ADR-0039). An id absent from the outline passes through: that is a deep element
  // selection whose caller (the file screen) owns mapping it to an ancestor root frame.
  const sectionPrompt = useRequestedStart(startNodeId, outline, identity, dispatchStart);

  // No start point from the caller: pick one ourselves once the flows are known, so the player
  // never sits on an endless spinner waiting for a hand-picked flow. The first flow wins; with no
  // flows the first top-level frame does, and the toolbar says so.
  useEffect(() => {
    // Browsing another page's flow list (ADR-0043) must not hijack playback: auto-start runs
    // only before the user first picked a page — afterwards they choose flows by hand.
    if (browsedExplicitly.current) return;
    if (startNodeId || player.startFrameId) return;
    if (!startChoice) return;
    dispatchStart(startChoice.frameId);
    setStartNote(startChoice.note);
  }, [startNodeId, player.startFrameId, startChoice, dispatchStart, browsedExplicitly]);

  // The interaction data may arrive after navigation; arm a visit's timer once the frame is
  // ready AND once per data state, so late-arriving interactions still start the countdown
  // while clock ticks and re-fetches never replay an already-fired timer.
  const activeRoot = activeFrameId ? frames.nodeFor(activeFrameId) : null;
  useFrameReadyArm(activeFrameId, activeRoot, player, interactions, identity, dispatch);

  // AFTER_TIMEOUT for the frame on stage; the machine re-checks arrival before firing.
  useEffect(() => {
    if (!player.timeout) return;
    const timer = setTimeout(() => dispatch({ type: "timeout_fire" }), player.timeout.delayMs);
    return () => clearTimeout(timer);
  }, [player.timeout, dispatch]);

  const transition = player.transition;
  // The pair-gated clock, rAF loop, eased timeline, and machine completion live together in
  // `useTransitionClock` (ADR-0037): an animation never ticks before its target data is on
  // hand, so it cannot finish unseen.
  const timeline = useTransitionClock(transition, frames, dispatch);

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
    prototype && !prototype.overlaySettingsAvailable
      ? "Overlay positioning unavailable in this snapshot"
      : null;

  // A failed batch must not strand the user: the error names what happened, Retry re-issues the
  // playback request, and Close always works (spec 32.5.3, ADR-0037).
  if (frames.error) {
    return (
      <View style={styles.centered} testID="figma-player-error">
        <Text style={styles.muted}>{frames.error}</Text>
        <View style={styles.errorActions}>
          <Button variant="outline" size="sm" onPress={frames.retry}>
            Retry
          </Button>
          <Button variant="outline" size="sm" onPress={onClose} testID="figma-prototype-close">
            Close
          </Button>
        </View>
      </View>
    );
  }

  // A Section with no playable frame in the outline must not pull its whole subtree through
  // playback (ADR-0039): no frame is on stage, no batch is requested, and the user picks one.
  if (sectionPrompt) {
    return (
      <View style={styles.centered} testID="figma-player-select-frame">
        <Text style={styles.muted}>{sectionPrompt}</Text>
        <Button variant="outline" size="sm" onPress={onClose} testID="figma-prototype-close">
          Close
        </Button>
      </View>
    );
  }

  // Legacy (fully-read) outlines only: a paged file renders the toolbar with its pages menu so
  // the user can browse flows elsewhere instead of being told the file has nothing.
  if (!paged && flows.length === 0 && !startChoice) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No prototype flows in this file.</Text>
        <Button variant="outline" size="sm" onPress={onClose} testID="figma-prototype-close">
          Close
        </Button>
      </View>
    );
  }

  return (
    <PrototypeAssetScopeProvider file={file} version={playbackVersion}>
      <View
        style={styles.screen}
        testID={`figma-player-state-${transition ? "transition" : "idle"}`}
      >
        <PlayerToolbar
          flows={flows}
          labelFlows={knownFlows}
          pages={paged ? flowPageOptions : null}
          flowPageId={flowPageId}
          onSelectFlowPage={onSelectFlowPage}
          flowPageNote={flowPageNote}
          flowPageRetrying={flowPageRetrying}
          onRetryFlowPage={onRetryFlowPage}
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
            flows={flows}
            emptyFlowsMessage={emptyFlowsMessage}
            flowsLoading={flowsLoading}
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
    </PrototypeAssetScopeProvider>
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
  flows,
  onStartFlow,
  emptyFlowsMessage,
  flowsLoading,
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
  flows: FigmaPrototype["flows"];
  onStartFlow: (frameId: string) => void;
  /** Paged mode (ADR-0043): the browsed page has no flows — the pages menu is the way out. */
  emptyFlowsMessage?: string | null;
  /** The browsed page's flows are being read on demand; pending is not "no flows". */
  flowsLoading?: boolean;
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
    if (frames.loading) {
      return (
        <View style={styles.centered}>
          <LoadingSpinner size="small" color={styles.spinner.color} />
        </View>
      );
    }
    if (flowsLoading) {
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
        <Text style={styles.muted}>{emptyFlowsMessage ?? "No prototype flows in this file."}</Text>
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
  labelFlows,
  pages,
  flowPageId,
  onSelectFlowPage,
  flowPageNote,
  flowPageRetrying,
  onRetryFlowPage,
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
  /** Every flow the session has listed — a page switch must not unname a playing flow. */
  labelFlows?: FigmaPrototype["flows"];
  /** Paged mode (ADR-0043): the browsable pages with their read state, else null. */
  pages: FlowPageOption[] | null;
  flowPageId: string | null;
  onSelectFlowPage: ((pageId: string) => void) | null;
  flowPageNote: string | null;
  flowPageRetrying: boolean;
  onRetryFlowPage: (() => void) | null;
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
  const labelSource = labelFlows ?? flows;
  return (
    <View style={styles.toolbar} testID="figma-prototype-toolbar">
      {pages && onSelectFlowPage ? (
        <DropdownMenu>
          {/* The pages menu scopes the flow list: one page's flows at a time (ADR-0043). Pages
              the canvas has not read are marked, since choosing them starts an on-demand read. */}
          <DropdownMenuTrigger style={styles.trigger} testID="figma-flow-page-trigger">
            <Text style={styles.triggerLabel} numberOfLines={1} ellipsizeMode="tail">
              {pages.find((page) => page.id === flowPageId)?.name ?? "Select a page"}
            </Text>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {pages.map((page) => (
              <FlowPageMenuItem key={page.id} page={page} onSelectFlowPage={onSelectFlowPage} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DropdownMenu>
        {/* The flow name is the only unbounded text here: it shrinks and ellipsizes (minWidth 0
            lets a flex child go below its content size) instead of pushing Back/Restart/hotspots/
            Close past the player's own container edge — under the Inspector on a narrow desktop
            rail, off-screen on a phone. */}
        <DropdownMenuTrigger style={styles.trigger}>
          <Text style={styles.triggerLabel} numberOfLines={1} ellipsizeMode="tail">
            {currentFlowLabel(labelSource, startFrameId)}
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
      <Button
        variant="ghost"
        size="sm"
        style={styles.close}
        onPress={onClose}
        testID="figma-prototype-close"
      >
        Close
      </Button>
      {overlayNote ? (
        <Text style={styles.note} numberOfLines={2}>
          {overlayNote}
        </Text>
      ) : null}
      {startNote ? (
        <Text style={styles.note} numberOfLines={2}>
          {startNote}
        </Text>
      ) : null}
      {flowPageNote ? (
        <View style={styles.noteRow}>
          <Text style={styles.noteRowText} numberOfLines={2}>
            {flowPageNote}
          </Text>
          {onRetryFlowPage ? (
            <Button
              variant="outline"
              size="sm"
              onPress={onRetryFlowPage}
              disabled={flowPageRetrying}
              testID="figma-flow-page-retry"
            >
              {flowPageRetrying ? "Retrying…" : "Retry"}
            </Button>
          ) : null}
        </View>
      ) : null}
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

function FlowPageMenuItem({
  page,
  onSelectFlowPage,
}: {
  page: FlowPageOption;
  onSelectFlowPage: (pageId: string) => void;
}) {
  const select = useCallback(() => onSelectFlowPage(page.id), [onSelectFlowPage, page.id]);
  return (
    <DropdownMenuItem testID={`figma-flow-page-item-${page.id}`} onSelect={select}>
      {page.loaded ? page.name : `${page.name} (not loaded)`}
    </DropdownMenuItem>
  );
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
    // Wrap instead of overflow (spec 32.5.3 responsive contract): the player renders inside its
    // own canvas column — a ~450px desktop rail next to the Inspector, ~390/280px on a phone —
    // and a single unwrapping row let a long flow name push Back/Restart/hotspots/Close past the
    // container edge, with Close landing under the sibling Inspector panel (real-Electron run 12:
    // Playwright's click hit the panel, not the button). Items that no longer fit drop to the
    // next row at their full size, so every control stays visible and hit-testable.
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    rowGap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  // Fixed-size controls never squash: they wrap as whole units and Close stays tappable.
  navGroup: { flexDirection: "row", gap: theme.spacing[1], flexShrink: 0 },
  errorActions: { flexDirection: "row", gap: theme.spacing[2] },
  hotspotToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    marginLeft: "auto",
    flexShrink: 0,
  },
  trigger: {
    // The long label is bounded HERE: shrinkable with minWidth 0 so `numberOfLines={1}`
    // ellipsizes at the container edge instead of growing the toolbar past it.
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "100%",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface1,
  },
  triggerLabel: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  close: { flexShrink: 0 },
  note: {
    // Diagnostics own a row: full basis so they never compete with controls for width.
    flexBasis: "100%",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  // A page-read status shares its row with Retry: the text shrinks, the button stays tappable.
  noteRow: {
    flexBasis: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  noteRowText: { flexShrink: 1, fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
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
