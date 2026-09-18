import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Svg, { Circle, Ellipse, G, Line, Rect, Text as SvgText } from "react-native-svg";
import type { ForumParticipant, ForumRole, StoredForumTopic } from "@jagentdesk/protocol/messages";

// A live "virtual office" for Team mode: each forum participant is an original little character at a
// desk, and their pose/badge reflects their REAL state (working / reviewing / waiting on the boss /
// talking / done / idle) derived from the topic. Rendered with react-native-svg (cross-platform:
// desktop web/electron + iOS/Android) — the team is only a handful of agents, well within SVG's
// comfort zone, so no heavy GPU dependency is needed. All artwork is original vector shapes.

// Fixed dark palette, aligned with the forum screen (clawskills-style).
const O = {
  floor: "#101010",
  floorBand: "#151515",
  wall: "#0b0b0b",
  grid: "#1c1c1c",
  desk: "#2a2320",
  deskTop: "#3a2f28",
  monitor: "#0e0e0e",
  monitorOn: "#173a2a",
  text: "#ededed",
  muted: "#878787",
  faint: "#454545",
  skin: "#d8b48a",
  green: "#35b45a",
  amber: "#f5a623",
  red: "#e04a3a",
  blue: "#3f8fd6",
  teal: "#17b8b0",
  plant: "#2d7d46",
} as const;
const FONT_MONO = '"Geist Mono","SFMono-Regular",Menlo,monospace';

type OfficeState = "working" | "reviewing" | "waiting" | "talking" | "done" | "idle";

const STATE_META: Record<OfficeState, { color: string; label: string }> = {
  working: { color: O.teal, label: "working" },
  reviewing: { color: O.amber, label: "reviewing" },
  waiting: { color: O.red, label: "waiting on boss" },
  talking: { color: O.blue, label: "talking" },
  done: { color: O.green, label: "shipped" },
  idle: { color: O.muted, label: "idle" },
};

function roleShirt(role: ForumRole): string {
  switch (role) {
    case "lead":
    case "supervisor":
      return O.green;
    case "ba":
    case "reviewer":
      return O.amber;
    case "tester":
      return O.teal;
    case "pentester":
      return O.red;
    case "user":
      return O.blue;
    default:
      return "#6b7280";
  }
}

// Derive each participant's current office state from the live topic (their tasks, latest post, and
// the pending-human flag). Purely from real data — the office mirrors what the team is actually doing.
function deriveOfficeState(topic: StoredForumTopic, p: ForumParticipant): OfficeState {
  const now = Date.now();
  const pending = topic.pendingHumanQuestion;
  if (pending) {
    const asker = topic.messages.find((m) => m.id === pending.messageId);
    if (asker?.authorAgentId === p.agentId) return "waiting";
  }
  const myTasks = topic.tasks.filter((t) => t.assigneeAgentId === p.agentId);
  if (myTasks.some((t) => t.status === "in_progress")) return "working";
  const lastByMe = topic.messages.toReversed().find((m) => m.authorAgentId === p.agentId);
  if (
    (p.role === "ba" || p.role === "tester" || p.role === "pentester") &&
    lastByMe?.kind === "review"
  ) {
    return "reviewing";
  }
  if (topic.status === "done" && myTasks.some((t) => t.status === "done")) return "done";
  if (lastByMe && now - lastByMe.createdAt_ms < 25_000) return "talking";
  if (topic.status === "done") return "done";
  return "idle";
}

function initial(label: string): string {
  const c = label.trim()[0];
  return c ? c.toUpperCase() : "?";
}

// One desk + character. `bob` is a -1..1 idle oscillation; `busy` a 0..1 typing oscillation.
const Worker = memo(function Worker({
  p,
  state,
  x,
  y,
  bob,
  busy,
}: {
  p: ForumParticipant;
  state: OfficeState;
  x: number;
  y: number;
  bob: number;
  busy: number;
}): ReactElement {
  const shirt = roleShirt(p.role);
  const meta = STATE_META[state];
  const headY = y - 30 + bob * 1.5;
  const typing = state === "working" ? busy * 2 : 0;
  return (
    <G>
      {/* desk */}
      <Rect x={x - 34} y={y + 6} width={68} height={26} rx={4} fill={O.desk} />
      <Rect x={x - 34} y={y + 6} width={68} height={6} rx={3} fill={O.deskTop} />
      {/* monitor */}
      <Rect
        x={x + 8}
        y={y - 12}
        width={24}
        height={18}
        rx={2}
        fill={O.monitor}
        stroke={state === "working" ? O.monitorOn : O.faint}
        strokeWidth={1}
      />
      {state === "working" ? (
        <Rect x={x + 11} y={y - 9} width={18} height={12} rx={1} fill={O.monitorOn} />
      ) : null}
      {/* body */}
      <Rect x={x - 12} y={y - 20 + typing} width={24} height={26} rx={9} fill={shirt} />
      {/* head */}
      <Circle cx={x} cy={headY + typing} r={9} fill={O.skin} />
      <Circle cx={x - 3} cy={headY + typing - 1} r={1.3} fill="#222" />
      <Circle cx={x + 3} cy={headY + typing - 1} r={1.3} fill="#222" />
      {/* initial badge on shirt */}
      <SvgText
        x={x}
        y={y - 4 + typing}
        fill="#0b0b0b"
        fontSize={8}
        fontWeight="700"
        textAnchor="middle"
        fontFamily={FONT_MONO}
      >
        {initial(p.label)}
      </SvgText>
      {/* status dot + speech/think bubble */}
      <Circle cx={x + 12} cy={headY - 6} r={3} fill={meta.color} />
      {state === "talking" ? (
        <G>
          <Ellipse
            cx={x + 22}
            cy={headY - 12}
            rx={9}
            ry={6}
            fill="#1b1b1b"
            stroke={O.blue}
            strokeWidth={0.8}
          />
          <Circle cx={x + 19} cy={headY - 12} r={1} fill={O.muted} />
          <Circle cx={x + 22} cy={headY - 12} r={1} fill={O.muted} />
          <Circle cx={x + 25} cy={headY - 12} r={1} fill={O.muted} />
        </G>
      ) : null}
      {state === "waiting" ? (
        <SvgText
          x={x + 22}
          y={headY - 8}
          fill={O.red}
          fontSize={11}
          fontWeight="700"
          textAnchor="middle"
        >
          ?
        </SvgText>
      ) : null}
      {state === "done" ? (
        <SvgText
          x={x + 22}
          y={headY - 8}
          fill={O.green}
          fontSize={11}
          fontWeight="700"
          textAnchor="middle"
        >
          ✓
        </SvgText>
      ) : null}
      {/* name + role */}
      <SvgText
        x={x}
        y={y + 44}
        fill={O.text}
        fontSize={9}
        textAnchor="middle"
        fontFamily={FONT_MONO}
      >
        {p.label.length > 16 ? `${p.label.slice(0, 15)}…` : p.label}
      </SvgText>
      <SvgText
        x={x}
        y={y + 54}
        fill={meta.color}
        fontSize={7.5}
        textAnchor="middle"
        fontFamily={FONT_MONO}
      >
        {meta.label.toUpperCase()}
      </SvgText>
    </G>
  );
});

// Logical scene size; the SVG scales to the container width preserving aspect.
const SCENE_W = 640;
const DESK_COLS = 3;
const CELL_W = 180;
const CELL_H = 150;
const MARGIN_X = 70;
const MARGIN_TOP = 70;

export const OfficeScene = memo(function OfficeScene({
  topic,
}: {
  topic: StoredForumTopic;
}): ReactElement {
  const workers = useMemo(
    () => topic.participants.filter((p) => p.agentId !== "user" && p.agentId !== "system"),
    [topic.participants],
  );
  const rows = Math.max(1, Math.ceil(workers.length / DESK_COLS));
  const sceneH = MARGIN_TOP + rows * CELL_H + 30;
  const [width, setWidth] = useState(SCENE_W);
  const onLayout = useCallback(
    (e: LayoutChangeEvent): void => setWidth(e.nativeEvent.layout.width),
    [],
  );
  const scale = width / SCENE_W;

  // Lightweight animation clock: a phase advanced ~15fps. Only a handful of workers, so re-rendering
  // the SVG at this rate is cheap and stays smooth cross-platform.
  const [phase, setPhase] = useState(0);
  const advance = useCallback(() => setPhase((p) => p + 0.16), []);
  const raf = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    raf.current = setInterval(advance, 66);
    return () => {
      if (raf.current) clearInterval(raf.current);
    };
  }, [advance]);

  const states = useMemo(() => workers.map((p) => deriveOfficeState(topic, p)), [workers, topic]);

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <Svg width={width} height={sceneH * scale} viewBox={`0 0 ${SCENE_W} ${sceneH}`}>
        {/* room */}
        <Rect x={0} y={0} width={SCENE_W} height={sceneH} fill={O.wall} />
        <Rect x={0} y={50} width={SCENE_W} height={sceneH - 50} fill={O.floor} />
        <Rect x={0} y={50} width={SCENE_W} height={10} fill={O.floorBand} />
        {/* floor grid */}
        {Array.from({ length: 9 }, (_, i) => (
          <Line
            key={`v${i}`}
            x1={(SCENE_W / 8) * i}
            y1={60}
            x2={(SCENE_W / 8) * i}
            y2={sceneH}
            stroke={O.grid}
            strokeWidth={0.5}
          />
        ))}
        {/* a couple of original plants for ambiance */}
        <G>
          <Rect x={16} y={sceneH - 40} width={12} height={14} rx={2} fill="#3a2f28" />
          <Circle cx={22} cy={sceneH - 44} r={10} fill={O.plant} />
        </G>
        <G>
          <Rect x={SCENE_W - 28} y={sceneH - 40} width={12} height={14} rx={2} fill="#3a2f28" />
          <Circle cx={SCENE_W - 22} cy={sceneH - 44} r={10} fill={O.plant} />
        </G>
        {/* header sign */}
        <SvgText
          x={SCENE_W / 2}
          y={30}
          fill={O.muted}
          fontSize={13}
          fontWeight="700"
          textAnchor="middle"
          fontFamily={FONT_MONO}
        >
          TEAM OFFICE · LIVE
        </SvgText>
        {workers.map((p, i) => {
          const col = i % DESK_COLS;
          const row = Math.floor(i / DESK_COLS);
          const x = MARGIN_X + col * CELL_W + CELL_W / 2 - 20;
          const y = MARGIN_TOP + row * CELL_H + 40;
          const bob = Math.sin(phase + i);
          const busy = (Math.sin(phase * 3 + i) + 1) / 2;
          return (
            <Worker key={p.agentId} p={p} state={states[i]} x={x} y={y} bob={bob} busy={busy} />
          );
        })}
        {workers.length === 0 ? (
          <SvgText
            x={SCENE_W / 2}
            y={sceneH / 2}
            fill={O.faint}
            fontSize={13}
            textAnchor="middle"
            fontFamily={FONT_MONO}
          >
            The office is empty — no teammates have clocked in yet.
          </SvgText>
        ) : null}
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  wrap: {
    width: "100%",
    borderWidth: 1,
    borderColor: "#2e2e2e",
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#0b0b0b",
  },
}));
