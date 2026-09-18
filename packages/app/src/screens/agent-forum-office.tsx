import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import type { ForumParticipant, ForumRole, StoredForumTopic } from "@jagentdesk/protocol/messages";

// A live "virtual office" for Team mode: each forum participant is an original little character at a
// desk, and their pose / micro-behaviour reflects their REAL state (working, reviewing, waiting on the
// boss, talking, shipped, idle) derived from the topic. Rendered with react-native-svg so it runs on
// desktop + mobile without a GPU dependency — a team is only a handful of agents. All artwork is
// original vector shapes. The scene is deliberately "alive": characters blink, breathe, glance around,
// tap the keyboard at a speed that tracks how busy they are, sip coffee, stretch when idle, and float a
// little vector emote that matches their mood — informed by petdex's activity-driven state machine.

const O = {
  floor: "#111114",
  floorBand: "#16161b",
  rug: "#1a2230",
  wall: "#0b0b0f",
  wallGlowTop: "#141726",
  wallGlowBottom: "#0b0b0f",
  grid: "#1d1d24",
  desk: "#2a2320",
  deskTop: "#3a2f28",
  deskLeg: "#211b18",
  monitor: "#0d0d10",
  monitorOn: "#123a2a",
  monitorScan: "#2bd48f",
  keyboard: "#20242c",
  text: "#ededed",
  muted: "#8b8b93",
  faint: "#3f3f47",
  skin: "#d8b48a",
  skinShade: "#c39d74",
  green: "#35b45a",
  amber: "#f5a623",
  red: "#e04a3a",
  blue: "#3f8fd6",
  teal: "#17b8b0",
  violet: "#8b7cf6",
  plant: "#2d7d46",
  plantDark: "#215c34",
  pot: "#3a2f28",
  mug: "#d05a48",
  steam: "#cfcfd6",
  windowSky: "#24406b",
  windowGlow: "#3d6aa8",
  dust: "#6a6a78",
  spark: "#7ff0c0",
  bubble: "#1b1b21",
  hairA: "#3a2a22",
  hairB: "#20242c",
  hairC: "#5a3d2a",
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

// Deterministic pseudo-random in 0..1 from a numeric seed, so every character gets a stable "personality"
// (blink cadence, glance timing, hair) without persistent state or a RNG dependency.
function rand(seed: number): number {
  const v = Math.sin(seed * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

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

const HAIRS = [O.hairA, O.hairB, O.hairC, "#2c2c34", "#4a3324"] as const;

// Derive each participant's current office state from the live topic (their tasks, latest post, and the
// pending-human flag). Purely from real data — the office mirrors what the team is actually doing.
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

// A small vector "emote" floating above a character's head — original shapes, not glyphs, so it renders
// identically on web and native. `pop` (0..1) drives a gentle bob + fade so the emote feels alive.
const Emote = memo(function Emote({
  state,
  x,
  y,
  pop,
}: {
  state: OfficeState;
  x: number;
  y: number;
  pop: number;
}): ReactElement | null {
  const dy = -Math.sin(pop * Math.PI) * 3;
  const cy = y + dy;
  switch (state) {
    case "working":
      // idea lightbulb
      return (
        <G opacity={0.9}>
          <Circle cx={x} cy={cy} r={4.6} fill="#fff2b0" stroke={O.amber} strokeWidth={0.8} />
          <Rect x={x - 2} y={cy + 3.4} width={4} height={2.4} rx={1} fill={O.amber} />
          <Line x1={x} y1={cy - 8} x2={x} y2={cy - 6} stroke={O.amber} strokeWidth={0.8} />
          <Line
            x1={x - 6}
            y1={cy - 5}
            x2={x - 4.5}
            y2={cy - 4}
            stroke={O.amber}
            strokeWidth={0.8}
          />
          <Line
            x1={x + 6}
            y1={cy - 5}
            x2={x + 4.5}
            y2={cy - 4}
            stroke={O.amber}
            strokeWidth={0.8}
          />
        </G>
      );
    case "reviewing":
      // magnifier
      return (
        <G opacity={0.9}>
          <Circle cx={x - 1} cy={cy} r={4} fill="none" stroke={O.amber} strokeWidth={1.4} />
          <Line
            x1={x + 2}
            y1={cy + 3}
            x2={x + 5}
            y2={cy + 6}
            stroke={O.amber}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </G>
      );
    case "waiting":
      return (
        <SvgText x={x} y={cy + 4} fill={O.red} fontSize={12} fontWeight="700" textAnchor="middle">
          ?
        </SvgText>
      );
    case "done":
      // check
      return (
        <Path
          d={`M ${x - 4} ${cy} L ${x - 1} ${cy + 3.5} L ${x + 5} ${cy - 4}`}
          fill="none"
          stroke={O.green}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case "talking":
      // speech dots in a bubble
      return (
        <G opacity={0.92}>
          <Ellipse cx={x} cy={cy} rx={9} ry={6} fill={O.bubble} stroke={O.blue} strokeWidth={0.7} />
          <Circle cx={x - 3.2} cy={cy} r={1} fill={O.muted} />
          <Circle cx={x} cy={cy} r={1} fill={O.muted} />
          <Circle cx={x + 3.2} cy={cy} r={1} fill={O.muted} />
        </G>
      );
    default:
      // idle "z z z"
      return (
        <G opacity={0.55} fill={O.muted}>
          <SvgText x={x - 3} y={cy + 2} fontSize={5} fontFamily={FONT_MONO}>
            z
          </SvgText>
          <SvgText x={x + 1} y={cy - 2} fontSize={6.5} fontFamily={FONT_MONO}>
            z
          </SvgText>
          <SvgText x={x + 5} y={cy - 6} fontSize={8} fontFamily={FONT_MONO}>
            z
          </SvgText>
        </G>
      );
  }
});

// The character's head: skin, hair, blinking eyes with a wandering gaze, and a mood-tinted mouth.
const Head = memo(function Head({
  cx,
  cy,
  hair,
  look,
  eyeOpen,
  mood,
}: {
  cx: number;
  cy: number;
  hair: string;
  look: number;
  eyeOpen: number;
  mood: OfficeState;
}): ReactElement {
  const px = look * 1.6; // pupil offset
  const smile = mood === "done" || mood === "talking";
  const frown = mood === "waiting";
  return (
    <G>
      <Circle cx={cx} cy={cy} r={9} fill={O.skin} />
      <Path
        d={`M ${cx - 9} ${cy - 2} A 9 9 0 0 1 ${cx + 9} ${cy - 2} L ${cx + 8} ${cy - 6} A 9 9 0 0 0 ${cx - 8} ${cy - 6} Z`}
        fill={hair}
      />
      <Ellipse cx={cx - 9} cy={cy} rx={1.5} ry={2} fill={O.skinShade} />
      <Ellipse cx={cx + 9} cy={cy} rx={1.5} ry={2} fill={O.skinShade} />
      {eyeOpen > 0.14 ? (
        <G>
          <Circle cx={cx - 3} cy={cy - 1} r={1.5} fill="#fff" />
          <Circle cx={cx + 3} cy={cy - 1} r={1.5} fill="#fff" />
          <Circle cx={cx - 3 + px} cy={cy - 1} r={0.9} fill="#20242c" />
          <Circle cx={cx + 3 + px} cy={cy - 1} r={0.9} fill="#20242c" />
        </G>
      ) : (
        <G stroke="#3a2f28" strokeWidth={0.9} strokeLinecap="round">
          <Line x1={cx - 4.4} y1={cy - 1} x2={cx - 1.6} y2={cy - 1} />
          <Line x1={cx + 1.6} y1={cy - 1} x2={cx + 4.4} y2={cy - 1} />
        </G>
      )}
      {smile ? (
        <Path
          d={`M ${cx - 2.6} ${cy + 3.4} Q ${cx} ${cy + 5.6} ${cx + 2.6} ${cy + 3.4}`}
          fill="none"
          stroke="#8a5a44"
          strokeWidth={0.9}
          strokeLinecap="round"
        />
      ) : null}
      {frown ? (
        <Path
          d={`M ${cx - 2.4} ${cy + 4.6} Q ${cx} ${cy + 2.8} ${cx + 2.4} ${cy + 4.6}`}
          fill="none"
          stroke="#8a5a44"
          strokeWidth={0.9}
          strokeLinecap="round"
        />
      ) : null}
      {!smile && !frown ? (
        <Line
          x1={cx - 1.8}
          y1={cy + 4}
          x2={cx + 1.8}
          y2={cy + 4}
          stroke="#8a5a44"
          strokeWidth={0.9}
          strokeLinecap="round"
        />
      ) : null}
    </G>
  );
});

// The desk, monitor (with an animated code glow when working) and a coffee mug with drifting steam.
const Desk = memo(function Desk({
  x,
  y,
  working,
  scan,
  steam,
}: {
  x: number;
  y: number;
  working: boolean;
  scan: number;
  steam: number;
}): ReactElement {
  return (
    <G>
      {/* legs + top */}
      <Rect x={x - 32} y={y + 30} width={4} height={12} fill={O.deskLeg} />
      <Rect x={x + 28} y={y + 30} width={4} height={12} fill={O.deskLeg} />
      <Rect x={x - 36} y={y + 6} width={72} height={26} rx={4} fill={O.desk} />
      <Rect x={x - 36} y={y + 6} width={72} height={6} rx={3} fill={O.deskTop} />
      {/* monitor */}
      <Rect
        x={x + 6}
        y={y - 14}
        width={26}
        height={19}
        rx={2}
        fill={O.monitor}
        stroke={working ? O.monitorOn : O.faint}
        strokeWidth={1}
      />
      {working ? (
        <G>
          <Rect
            x={x + 9}
            y={y - 11}
            width={20}
            height={13}
            rx={1}
            fill={O.monitorOn}
            opacity={0.85}
          />
          <Line
            x1={x + 9}
            y1={y - 11 + scan * 13}
            x2={x + 29}
            y2={y - 11 + scan * 13}
            stroke={O.monitorScan}
            strokeWidth={0.9}
            opacity={0.7}
          />
          <Line
            x1={x + 11}
            y1={y - 8}
            x2={x + 20}
            y2={y - 8}
            stroke={O.monitorScan}
            strokeWidth={0.7}
            opacity={0.5}
          />
          <Line
            x1={x + 11}
            y1={y - 5}
            x2={x + 25}
            y2={y - 5}
            stroke={O.monitorScan}
            strokeWidth={0.7}
            opacity={0.4}
          />
        </G>
      ) : null}
      <Rect x={x + 17} y={y + 5} width={4} height={3} fill={O.faint} />
      {/* keyboard */}
      <Rect x={x - 30} y={y - 1} width={26} height={7} rx={1.5} fill={O.keyboard} />
      {/* mug + steam */}
      <Rect x={x - 33} y={y - 4} width={6} height={6} rx={1} fill={O.mug} />
      <G opacity={0.35}>
        <Path
          d={`M ${x - 30} ${y - 6} q ${2 * Math.sin(steam * 6)} -3 0 -6`}
          fill="none"
          stroke={O.steam}
          strokeWidth={0.8}
          strokeLinecap="round"
        />
      </G>
    </G>
  );
});

// Tiny "typing spark" particles that rise off the keyboard when a character is heads-down working hard.
const Sparks = memo(function Sparks({
  x,
  y,
  t,
  intensity,
}: {
  x: number;
  y: number;
  t: number;
  intensity: number;
}): ReactElement | null {
  if (intensity < 0.55) return null;
  const parts = [0, 1, 2];
  return (
    <G>
      {parts.map((k) => {
        const life = (t * 1.4 + k * 0.33) % 1;
        const sx = x - 20 + k * 8 + Math.sin((t + k) * 3) * 2;
        const sy = y - 2 - life * 12;
        return (
          <Circle
            key={`spark-${k}`}
            cx={sx}
            cy={sy}
            r={0.9}
            fill={O.spark}
            opacity={(1 - life) * 0.8}
          />
        );
      })}
    </G>
  );
});

// One full workstation: desk + a breathing, blinking, typing/sipping/stretching character + its emote.
const Worker = memo(function Worker({
  p,
  state,
  x,
  y,
  t,
}: {
  p: ForumParticipant;
  state: OfficeState;
  x: number;
  y: number;
  t: number;
}): ReactElement {
  const shirt = roleShirt(p.role);
  const meta = STATE_META[state];
  const seed = (p.agentId.charCodeAt(0) || 7) + (p.agentId.charCodeAt(3) || 3);
  const hair = HAIRS[Math.floor(rand(seed) * HAIRS.length) % HAIRS.length] ?? O.hairA;

  const working = state === "working";
  const reviewing = state === "reviewing";
  // Typing intensity: fast + jittery while working, a calmer tap while reviewing, still otherwise.
  let intensity = 0;
  if (working) intensity = 1;
  else if (reviewing) intensity = 0.5;
  const typeFreq = 9 + rand(seed) * 3;
  const type = intensity > 0 ? (Math.sin(t * typeFreq + seed) * 0.5 + 0.5) * intensity : 0;

  const breathe = Math.sin(t * 1.6 + seed) * 0.8;
  // Idle characters periodically lean back and stretch; sip coffee on a slower personal cycle.
  const stretchCycle = (t * 0.12 + rand(seed) * 5) % 5;
  const stretch = state === "idle" && stretchCycle > 4.2 ? (stretchCycle - 4.2) / 0.8 : 0;
  const sipCycle = (t * 0.1 + rand(seed + 1) * 7) % 7;
  const sipping = (state === "idle" || state === "talking") && sipCycle > 6.3;

  // Blink: eyes shut briefly on a personal cadence (~every 3.5–5s).
  const blinkCycle = (t + rand(seed) * 6) % (3.5 + rand(seed + 2) * 1.5);
  const eyeOpen = blinkCycle < 0.13 ? 0 : 1;
  // Gaze: locked on the monitor while working, wandering otherwise.
  const look = working ? 0.7 : Math.sin(t * 0.6 + seed) * (state === "idle" ? 1 : 0.4);

  const bodyY = y - 20 + breathe - type * 1.4 - stretch * 2.5;
  const headY = y - 30 + breathe - type * 1.4 - stretch * 4;
  const emotePop = (Math.sin(t * 0.9 + seed) + 1) / 2;

  let armPose: "sip" | "stretch" | "rest" = "rest";
  if (sipping) armPose = "sip";
  else if (stretch > 0) armPose = "stretch";

  return (
    <G>
      <Desk x={x} y={y} working={working} scan={(t * 0.7 + seed) % 1} steam={t + seed} />
      {/* chair back */}
      <Rect x={x - 13} y={y - 6} width={26} height={16} rx={7} fill="#191b21" />
      {/* body */}
      <Rect x={x - 12} y={bodyY} width={24} height={26} rx={9} fill={shirt} />
      <Rect x={x - 12} y={bodyY} width={24} height={7} rx={7} fill={shirt} opacity={0.75} />
      {/* arms: rest on desk / tap when typing / one raised when sipping / both up when stretching */}
      {armPose === "sip" ? (
        <G stroke={O.skin} strokeWidth={3.2} strokeLinecap="round">
          <Line x1={x - 8} y1={bodyY + 8} x2={x - 12} y2={bodyY + 14} />
          <Line x1={x + 8} y1={bodyY + 8} x2={x + 2} y2={headY + 4} />
        </G>
      ) : null}
      {armPose === "stretch" ? (
        <G stroke={O.skin} strokeWidth={3.2} strokeLinecap="round">
          <Line x1={x - 8} y1={bodyY + 6} x2={x - 12} y2={headY - 2 - stretch * 3} />
          <Line x1={x + 8} y1={bodyY + 6} x2={x + 12} y2={headY - 2 - stretch * 3} />
        </G>
      ) : null}
      {armPose === "rest" ? (
        <G stroke={O.skin} strokeWidth={3.2} strokeLinecap="round">
          <Line x1={x - 8} y1={bodyY + 8} x2={x - 14} y2={y + 2 + type * 1.5} />
          <Line x1={x + 8} y1={bodyY + 8} x2={x + 14} y2={y + 2 - type * 1.5} />
        </G>
      ) : null}
      <Head cx={x} cy={headY} hair={hair} look={look} eyeOpen={eyeOpen} mood={state} />
      {/* initial badge on shirt */}
      <SvgText
        x={x}
        y={bodyY + 17}
        fill="#0b0b0b"
        fontSize={8}
        fontWeight="700"
        textAnchor="middle"
        fontFamily={FONT_MONO}
        opacity={0.55}
      >
        {initial(p.label)}
      </SvgText>
      <Sparks x={x} y={y} t={t} intensity={intensity} />
      <Circle cx={x + 12} cy={headY - 7} r={3} fill={meta.color} />
      <Emote state={state} x={x + 20} y={headY - 12} pop={emotePop} />
      {/* name + role */}
      <SvgText
        x={x}
        y={y + 46}
        fill={O.text}
        fontSize={9}
        textAnchor="middle"
        fontFamily={FONT_MONO}
      >
        {p.label.length > 16 ? `${p.label.slice(0, 15)}…` : p.label}
      </SvgText>
      <SvgText
        x={x}
        y={y + 56}
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

// A potted plant whose fronds sway on the ambient clock.
const Plant = memo(function Plant({ x, y, t }: { x: number; y: number; t: number }): ReactElement {
  const sway = Math.sin(t * 0.8 + x) * 2;
  return (
    <G>
      <Path
        d={`M ${x - 8} ${y} L ${x - 6} ${y + 14} L ${x + 6} ${y + 14} L ${x + 8} ${y} Z`}
        fill={O.pot}
      />
      <Ellipse cx={x + sway} cy={y - 8} rx={9} ry={11} fill={O.plant} />
      <Ellipse cx={x - 5 + sway} cy={y - 4} rx={5} ry={8} fill={O.plantDark} />
      <Ellipse cx={x + 5 + sway * 0.6} cy={y - 5} rx={5} ry={8} fill={O.plantDark} />
    </G>
  );
});

// A wall clock with a sweeping second hand and a slow minute hand — a quiet sign the room is live.
const WallClock = memo(function WallClock({
  x,
  y,
  t,
}: {
  x: number;
  y: number;
  t: number;
}): ReactElement {
  const sec = (t % 60) / 60;
  const min = (t % 3600) / 3600;
  const sa = sec * Math.PI * 2 - Math.PI / 2;
  const ma = min * Math.PI * 2 - Math.PI / 2;
  return (
    <G>
      <Circle cx={x} cy={y} r={11} fill="#16161b" stroke={O.faint} strokeWidth={1.2} />
      <Line
        x1={x}
        y1={y}
        x2={x + Math.cos(ma) * 5}
        y2={y + Math.sin(ma) * 5}
        stroke={O.muted}
        strokeWidth={1.4}
        strokeLinecap="round"
      />
      <Line
        x1={x}
        y1={y}
        x2={x + Math.cos(sa) * 8}
        y2={y + Math.sin(sa) * 8}
        stroke={O.teal}
        strokeWidth={0.8}
        strokeLinecap="round"
      />
      <Circle cx={x} cy={y} r={1} fill={O.muted} />
    </G>
  );
});

// Floating dust motes drifting through the light — cheap, cheerful ambience.
const Dust = memo(function Dust({
  t,
  width,
  height,
}: {
  t: number;
  width: number;
  height: number;
}): ReactElement {
  const motes = [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <G fill={O.dust}>
      {motes.map((k) => {
        const bx = (rand(k * 3.1) * width + t * (6 + k) * 0.6) % width;
        const by =
          60 + ((rand(k * 7.7) * (height - 80) + Math.sin(t * 0.5 + k) * 8) % (height - 80));
        return <Circle key={`dust-${k}`} cx={bx} cy={by} r={0.7} opacity={0.25 + rand(k) * 0.2} />;
      })}
    </G>
  );
});

const SCENE_W = 640;
const DESK_COLS = 3;
const CELL_W = 180;
const CELL_H = 158;
const MARGIN_X = 70;
const MARGIN_TOP = 84;

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
  const sceneH = MARGIN_TOP + rows * CELL_H + 40;
  const [width, setWidth] = useState(SCENE_W);
  const onLayout = useCallback(
    (e: LayoutChangeEvent): void => setWidth(e.nativeEvent.layout.width),
    [],
  );
  const scale = width / SCENE_W;

  // Continuous, framerate-independent clock (seconds). ~30fps keeps the micro-animations smooth while a
  // handful of workers keeps the redraw cheap on both desktop and mobile.
  const [t, setT] = useState(() => Date.now() / 1000);
  const start = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tick = useCallback(() => setT((Date.now() - start.current) / 1000), []);
  useEffect(() => {
    timer.current = setInterval(tick, 33);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [tick]);

  const states = useMemo(() => workers.map((p) => deriveOfficeState(topic, p)), [workers, topic]);

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <Svg width={width} height={sceneH * scale} viewBox={`0 0 ${SCENE_W} ${sceneH}`}>
        <Defs>
          <LinearGradient id="wallGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={O.wallGlowTop} />
            <Stop offset="1" stopColor={O.wallGlowBottom} />
          </LinearGradient>
          <LinearGradient id="winGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={O.windowGlow} />
            <Stop offset="1" stopColor={O.windowSky} />
          </LinearGradient>
        </Defs>
        {/* room */}
        <Rect x={0} y={0} width={SCENE_W} height={sceneH} fill="url(#wallGrad)" />
        <Rect x={0} y={52} width={SCENE_W} height={sceneH - 52} fill={O.floor} />
        <Rect x={0} y={52} width={SCENE_W} height={10} fill={O.floorBand} />
        {/* rug */}
        <Rect
          x={SCENE_W / 2 - 150}
          y={sceneH - 70}
          width={300}
          height={44}
          rx={10}
          fill={O.rug}
          opacity={0.5}
        />
        {/* floor grid */}
        {Array.from({ length: 9 }, (_, i) => (
          <Line
            key={`v${i}`}
            x1={(SCENE_W / 8) * i}
            y1={62}
            x2={(SCENE_W / 8) * i}
            y2={sceneH}
            stroke={O.grid}
            strokeWidth={0.5}
          />
        ))}
        {/* window with daylight */}
        <Rect
          x={SCENE_W - 118}
          y={12}
          width={96}
          height={30}
          rx={3}
          fill="url(#winGrad)"
          opacity={0.8}
        />
        <Line x1={SCENE_W - 70} y1={12} x2={SCENE_W - 70} y2={42} stroke={O.wall} strokeWidth={2} />
        <Line
          x1={SCENE_W - 118}
          y1={27}
          x2={SCENE_W - 22}
          y2={27}
          stroke={O.wall}
          strokeWidth={2}
        />
        <WallClock x={64} y={30} t={t} />
        <Dust t={t} width={SCENE_W} height={sceneH} />
        <Plant x={26} y={sceneH - 40} t={t} />
        <Plant x={SCENE_W - 26} y={sceneH - 40} t={t} />
        {/* header sign */}
        <SvgText
          x={SCENE_W / 2}
          y={34}
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
          return <Worker key={p.agentId} p={p} state={states[i] ?? "idle"} x={x} y={y} t={t} />;
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
    backgroundColor: "#0b0b0f",
  },
}));
