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
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import type { ForumParticipant, ForumRole, StoredForumTopic } from "@jagentdesk/protocol/messages";

// A live "virtual office" for Team mode. Each forum participant is an original character seated at a
// desk, drawn in a shaded 3/4 style with volume (gradients + contact shadows) so it reads as a real
// little person rather than a flat sticker. Their pose / micro-behaviour reflects their REAL state
// (working, reviewing, waiting on the boss, talking, shipped, idle) derived from the topic. Rendered
// with react-native-svg so it runs on desktop + mobile without a GPU dependency. All artwork is
// original. The scene is deliberately alive: characters blink, breathe, glance around, type (their
// laptop glow spills onto their face), sip coffee, stretch, and float a small vector emote for mood —
// informed by petdex's activity-driven state machine.

const O = {
  floorTop: "#17171d",
  floorBottom: "#0c0c10",
  wallTop: "#171a29",
  wallBottom: "#0b0b0f",
  grid: "#1e1e26",
  deskWoodTop: "#4b3b2d",
  deskWoodBottom: "#2c231b",
  deskEdge: "#5a4636",
  deskFront: "#241c15",
  chairTop: "#2c2f39",
  chairBottom: "#16181e",
  laptopTop: "#262a31",
  laptopBottom: "#13151a",
  keyboard: "#1b1e24",
  monitorOn: "#123a2a",
  monitorScan: "#2bd48f",
  text: "#efeff2",
  muted: "#9a9aa4",
  faint: "#43434c",
  skinHi: "#e7c6a0",
  skinLo: "#c39d74",
  skinLine: "#9c744f",
  green: "#3ac162",
  amber: "#f5a623",
  red: "#e0503f",
  blue: "#4a97dd",
  teal: "#1fc3ba",
  violet: "#8b7cf6",
  plant: "#2f8a4c",
  plantDark: "#22643a",
  pot: "#3a2f28",
  mug: "#d05a48",
  steam: "#cfcfd6",
  windowSky: "#26456f",
  windowGlow: "#4f7fc0",
  dust: "#7a7a88",
  spark: "#8ff2c6",
  bubble: "#1c1c22",
  shadow: "#000000",
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

// Deterministic pseudo-random in 0..1 from a numeric seed, so every character gets a stable
// "personality" (blink cadence, glance timing, hair, skin tone) without persistent state.
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

const HAIRS = ["#2a1d15", "#171a20", "#4a3324", "#5a3d2a", "#20242c", "#6b4a2e"] as const;
const SKINS = ["#e7c6a0", "#d8b48a", "#c69a6f", "#b98a63", "#eccfae"] as const;

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

// A small vector "emote" floating above a character's head — original shapes so it renders the same on
// web and native. `pop` (0..1) drives a gentle bob so the emote feels alive.
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
  const cy = y - Math.sin(pop * Math.PI) * 3;
  switch (state) {
    case "working":
      return (
        <G opacity={0.92}>
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
      return (
        <G opacity={0.92}>
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
      return (
        <G opacity={0.94}>
          <Ellipse cx={x} cy={cy} rx={9} ry={6} fill={O.bubble} stroke={O.blue} strokeWidth={0.7} />
          <Circle cx={x - 3.2} cy={cy} r={1} fill={O.muted} />
          <Circle cx={x} cy={cy} r={1} fill={O.muted} />
          <Circle cx={x + 3.2} cy={cy} r={1} fill={O.muted} />
        </G>
      );
    default:
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

// The head: shaded skin, volumetric hair with a highlight, ears, brows, eyes with catchlights + a
// wandering gaze, a nose and a mood-tinted mouth. A soft laptop-glow tints the face while working.
const Head = memo(function Head({
  cx,
  cy,
  skin,
  hair,
  look,
  eyeOpen,
  mood,
  glow,
}: {
  cx: number;
  cy: number;
  skin: string;
  hair: string;
  look: number;
  eyeOpen: number;
  mood: OfficeState;
  glow: number;
}): ReactElement {
  const px = look * 1.5;
  const smile = mood === "done" || mood === "talking";
  const frown = mood === "waiting";
  return (
    <G>
      {/* ears */}
      <Ellipse cx={cx - 8.6} cy={cy + 1} rx={1.8} ry={2.6} fill={skin} />
      <Ellipse cx={cx + 8.6} cy={cy + 1} rx={1.8} ry={2.6} fill={skin} />
      {/* face */}
      <Circle cx={cx} cy={cy} r={9} fill={skin} />
      <Path d={`M ${cx} ${cy - 9} A 9 9 0 0 1 ${cx + 9} ${cy}`} fill="#000" opacity={0.06} />
      {/* laptop glow on the lower face */}
      {glow > 0 ? (
        <Ellipse cx={cx} cy={cy + 4} rx={7} ry={4} fill={O.teal} opacity={0.14 * glow} />
      ) : null}
      {/* hair: swept volume + highlight */}
      <Path
        d={`M ${cx - 9} ${cy - 1} C ${cx - 10} ${cy - 12}, ${cx + 10} ${cy - 12}, ${cx + 9} ${cy - 1} C ${cx + 6} ${cy - 7}, ${cx - 2} ${cy - 6}, ${cx - 9} ${cy - 1} Z`}
        fill={hair}
      />
      <Path
        d={`M ${cx - 6} ${cy - 6} Q ${cx - 1} ${cy - 9} ${cx + 3} ${cy - 7}`}
        fill="none"
        stroke="#fff"
        strokeWidth={0.7}
        opacity={0.12}
        strokeLinecap="round"
      />
      {/* brows */}
      <Line
        x1={cx - 5}
        y1={cy - 2.6}
        x2={cx - 1.5}
        y2={cy - 3}
        stroke={O.skinLine}
        strokeWidth={0.7}
        strokeLinecap="round"
      />
      <Line
        x1={cx + 1.5}
        y1={cy - 3}
        x2={cx + 5}
        y2={cy - 2.6}
        stroke={O.skinLine}
        strokeWidth={0.7}
        strokeLinecap="round"
      />
      {/* eyes */}
      {eyeOpen > 0.14 ? (
        <G>
          <Ellipse cx={cx - 3} cy={cy - 0.6} rx={1.7} ry={1.9} fill="#fff" />
          <Ellipse cx={cx + 3} cy={cy - 0.6} rx={1.7} ry={1.9} fill="#fff" />
          <Circle cx={cx - 3 + px} cy={cy - 0.4} r={0.95} fill="#241c16" />
          <Circle cx={cx + 3 + px} cy={cy - 0.4} r={0.95} fill="#241c16" />
          <Circle cx={cx - 3.4 + px} cy={cy - 0.9} r={0.32} fill="#fff" />
          <Circle cx={cx + 2.6 + px} cy={cy - 0.9} r={0.32} fill="#fff" />
        </G>
      ) : (
        <G stroke={O.skinLine} strokeWidth={0.9} strokeLinecap="round">
          <Line x1={cx - 4.4} y1={cy - 0.6} x2={cx - 1.6} y2={cy - 0.6} />
          <Line x1={cx + 1.6} y1={cy - 0.6} x2={cx + 4.4} y2={cy - 0.6} />
        </G>
      )}
      {/* nose */}
      <Path d={`M ${cx} ${cy + 0.5} l -1 3 h 2 Z`} fill={O.skinLo} opacity={0.7} />
      {/* mouth */}
      {smile ? (
        <Path
          d={`M ${cx - 2.6} ${cy + 4.4} Q ${cx} ${cy + 6.6} ${cx + 2.6} ${cy + 4.4}`}
          fill="none"
          stroke={O.skinLine}
          strokeWidth={0.9}
          strokeLinecap="round"
        />
      ) : null}
      {frown ? (
        <Path
          d={`M ${cx - 2.4} ${cy + 5.6} Q ${cx} ${cy + 3.8} ${cx + 2.4} ${cy + 5.6}`}
          fill="none"
          stroke={O.skinLine}
          strokeWidth={0.9}
          strokeLinecap="round"
        />
      ) : null}
      {!smile && !frown ? (
        <Line
          x1={cx - 1.8}
          y1={cy + 5}
          x2={cx + 1.8}
          y2={cy + 5}
          stroke={O.skinLine}
          strokeWidth={0.9}
          strokeLinecap="round"
        />
      ) : null}
    </G>
  );
});

type ArmMode = "typing" | "pointing" | "gesturing" | "walk";

function poseMode(typing: boolean, pointing: boolean, gesturing: boolean): ArmMode {
  if (typing) return "typing";
  if (pointing) return "pointing";
  if (gesturing) return "gesturing";
  return "walk";
}

// Head gaze (−1..1) by activity: on the screen while working, on the board while reviewing, toward the
// boss while waiting, around the circle while chatting, wandering when idle.
function gazeFor(state: OfficeState, seed: number, t: number, facing: number): number {
  if (state === "working") return 0.4 * facing;
  if (state === "reviewing") return -0.9 + Math.sin(t * 2 + seed) * 0.15;
  if (state === "waiting") return Math.sin(t * 3 + seed) * 0.3;
  if (state === "talking") return Math.sin(t * 1.4 + seed) * 0.8;
  return Math.sin(t * 0.6 + seed) * (state === "idle" ? 1 : 0.4);
}

// The three review poses so a huddle reads like real people: 0 = pointing at the board, 1 = reading a
// tablet (hands forward), 2 = hand on chin, scrutinising.
function reviewArms(
  x: number,
  shoulderY: number,
  hipY: number,
  gesture: number,
  variant: number,
): ReactElement {
  if (variant === 1) {
    return (
      <>
        <Line x1={x - 6} y1={shoulderY + 3} x2={x - 4} y2={shoulderY + 9} />
        <Line x1={x + 6} y1={shoulderY + 3} x2={x + 4} y2={shoulderY + 9} />
      </>
    );
  }
  if (variant === 2) {
    return (
      <>
        <Line x1={x - 6} y1={shoulderY + 3} x2={x - 2} y2={shoulderY - 6 + gesture * 1.5} />
        <Line x1={x + 6} y1={shoulderY + 3} x2={x + 5} y2={hipY} />
      </>
    );
  }
  return (
    <>
      <Line x1={x - 6} y1={shoulderY + 3} x2={x - 12} y2={shoulderY - 7 - gesture * 4} />
      <Line x1={x + 6} y1={shoulderY + 3} x2={x + 4} y2={hipY + 1} />
    </>
  );
}

const CharacterArms = memo(function CharacterArms({
  mode,
  x,
  shoulderY,
  hipY,
  skin,
  walk,
  gesture,
  typeL,
  typeR,
  variant,
}: {
  mode: ArmMode;
  x: number;
  shoulderY: number;
  hipY: number;
  skin: string;
  walk: number;
  gesture: number;
  typeL: number;
  typeR: number;
  variant: number;
}): ReactElement {
  let lines: ReactElement;
  if (mode === "typing") {
    lines = (
      <>
        <Line x1={x - 6} y1={shoulderY + 3} x2={x - 5} y2={hipY - 1 + typeL} />
        <Line x1={x + 6} y1={shoulderY + 3} x2={x + 5} y2={hipY - 1 + typeR} />
      </>
    );
  } else if (mode === "pointing") {
    lines = reviewArms(x, shoulderY, hipY, gesture, variant);
  } else if (mode === "gesturing") {
    lines = (
      <>
        <Line x1={x - 6} y1={shoulderY + 3} x2={x - 9} y2={shoulderY - 2 - gesture * 5} />
        <Line x1={x + 6} y1={shoulderY + 3} x2={x + 9} y2={shoulderY - 1 - (1 - gesture) * 5} />
      </>
    );
  } else {
    lines = (
      <>
        <Line x1={x - 6} y1={shoulderY + 3} x2={x - 7 - walk * 2} y2={hipY + 2} />
        <Line x1={x + 6} y1={shoulderY + 3} x2={x + 7 + walk * 2} y2={hipY + 2} />
      </>
    );
  }
  return (
    <G stroke={skin} strokeWidth={3} strokeLinecap="round">
      {lines}
    </G>
  );
});

// The back of a head — hair covering it with ears — shown when a character walks away from the viewer,
// so movement reads as turning like a real person rather than sliding.
const BackHead = memo(function BackHead({
  cx,
  cy,
  skin,
  hair,
}: {
  cx: number;
  cy: number;
  skin: string;
  hair: string;
}): ReactElement {
  return (
    <G>
      <Ellipse cx={cx - 8.6} cy={cy + 1} rx={1.8} ry={2.6} fill={skin} />
      <Ellipse cx={cx + 8.6} cy={cy + 1} rx={1.8} ry={2.6} fill={skin} />
      <Circle cx={cx} cy={cy} r={9} fill={skin} />
      <Path
        d={`M ${cx - 9} ${cy + 4} A 9 9 0 1 1 ${cx + 9} ${cy + 4} Q ${cx} ${cy + 2} ${cx - 9} ${cy + 4} Z`}
        fill={hair}
      />
    </G>
  );
});

interface CharMotion {
  yb: number;
  legSwing: number;
  hipY: number;
  shoulderY: number;
  headCY: number;
  typeL: number;
  typeR: number;
  eyeOpen: number;
  walk: number;
  gesture: number;
}

// Per-frame body geometry: walking bob + leg swing, idle sway, active lean, typing hands, blink.
function characterMotion(input: {
  state: OfficeState;
  seed: number;
  t: number;
  moving: boolean;
  typing: boolean;
  pointing: boolean;
  gesturing: boolean;
  baseY: number;
}): CharMotion {
  const { state, seed, t, moving, typing, pointing, gesturing, baseY } = input;
  const gesture = Math.sin(t * 3.4 + seed) * 0.5 + 0.5;
  const nod = Math.sin(t * 2.2 + seed);
  const walk = moving ? Math.sin(t * 9 + seed) : 0;
  const idleShift =
    !moving && (state === "idle" || state === "done") ? Math.sin(t * 1.1 + seed) * 0.6 : 0;
  const activeLean = pointing || gesturing ? nod * 0.8 : 0;
  const bob = moving
    ? Math.abs(Math.cos(t * 9 + seed)) * 1.4
    : Math.sin(t * 1.6 + seed) * 0.5 + idleShift;
  const yb = -bob;
  const blinkPeriod = 3.5 + rand(seed + 2) * 1.5;
  return {
    yb,
    legSwing: walk * 3.6,
    hipY: baseY - 15 + yb,
    shoulderY: baseY - 29 + yb,
    headCY: baseY - 39 + yb + activeLean,
    typeL: typing ? (Math.sin(t * 11 + seed) * 0.5 + 0.5) * 2 : 0,
    typeR: typing ? (Math.sin(t * 11 + seed + Math.PI) * 0.5 + 0.5) * 2 : 0,
    eyeOpen: (t + rand(seed) * 6) % blinkPeriod < 0.13 ? 0 : 1,
    walk,
    gesture,
  };
}

// Which way a walking character faces: a mostly-sideways step turns them left/right; heading up (away
// from the viewer) shows their back. `leanX` tilts the upper body into the direction of travel.
function headingFor(
  dirX: number,
  dirY: number,
  moving: boolean,
): { mv: boolean; away: boolean; sideDir: number; leanX: number } {
  const mag = Math.hypot(dirX, dirY);
  const mv = moving && mag > 0.4;
  if (!mv) return { mv: false, away: false, sideDir: 0, leanX: 0 };
  const away = dirY < -Math.abs(dirX) * 0.5;
  let sideDir = 0;
  if (Math.abs(dirX) > Math.abs(dirY) * 0.55) sideDir = dirX >= 0 ? 1 : -1;
  const leanX = sideDir * 2.4 + (dirX / (mag || 1)) * 1.6;
  return { mv, away, sideDir, leanX };
}

// A teammate as a small figure that WALKS between places: it turns to face where it's going (shows its
// back when heading away), and sits/types/points/gestures based on its real state.
const GameCharacter = memo(function GameCharacter({
  p,
  state,
  x,
  baseY,
  dirX,
  dirY,
  moving,
  t,
}: {
  p: ForumParticipant;
  state: OfficeState;
  x: number;
  baseY: number;
  dirX: number;
  dirY: number;
  moving: boolean;
  t: number;
}): ReactElement {
  const shirt = roleShirt(p.role);
  const meta = STATE_META[state];
  const seed = (p.agentId.charCodeAt(0) || 7) + (p.agentId.charCodeAt(3) || 3) * 2;
  const hair = HAIRS[Math.floor(rand(seed) * HAIRS.length) % HAIRS.length] ?? HAIRS[0];
  const skin = SKINS[Math.floor(rand(seed + 5) * SKINS.length) % SKINS.length] ?? SKINS[0];
  const working = state === "working";
  const typing = working && !moving;
  const pointing = state === "reviewing" && !moving;
  const gesturing = state === "talking" && !moving;
  const { yb, legSwing, hipY, shoulderY, headCY, typeL, typeR, eyeOpen, walk, gesture } =
    characterMotion({ state, seed, t, moving, typing, pointing, gesturing, baseY });
  const mode = poseMode(typing, pointing, gesturing);
  const variant = seed % 3;
  const heading = headingFor(dirX, dirY, moving);
  const away = heading.away;
  const look = heading.mv ? heading.sideDir * 0.95 : gazeFor(state, seed, t, 1);
  const sx = x + heading.leanX;

  return (
    <G>
      <Ellipse cx={x} cy={baseY + 2} rx={12} ry={3.2} fill={O.shadow} opacity={0.34} />
      {/* legs */}
      <G stroke="#2b2f38" strokeWidth={3.2} strokeLinecap="round">
        <Line x1={x - 3} y1={hipY} x2={x - 3 + legSwing} y2={baseY + yb} />
        <Line x1={x + 3} y1={hipY} x2={x + 3 - legSwing} y2={baseY + yb} />
      </G>
      {/* torso (leans toward travel direction) */}
      <Path
        d={`M ${x - 8} ${hipY} L ${sx - 7} ${shoulderY} Q ${sx} ${shoulderY - 4} ${sx + 7} ${shoulderY} L ${x + 8} ${hipY} Z`}
        fill={shirt}
      />
      <Path
        d={`M ${x - 8} ${hipY} L ${sx - 7} ${shoulderY} Q ${sx - 4} ${shoulderY - 2} ${sx - 2} ${shoulderY - 1} L ${x - 2} ${hipY} Z`}
        fill="#fff"
        opacity={0.08}
      />
      {/* a tablet for the "reading the diff" reviewer */}
      {pointing && variant === 1 ? (
        <Rect
          x={sx - 5}
          y={shoulderY + 5}
          width={10}
          height={7}
          rx={1}
          fill="#11141a"
          stroke={O.monitorScan}
          strokeWidth={0.6}
        />
      ) : null}
      <CharacterArms
        mode={mode}
        x={sx}
        shoulderY={shoulderY}
        hipY={hipY}
        skin={skin}
        walk={walk}
        gesture={gesture}
        typeL={typeL}
        typeR={typeR}
        variant={variant}
      />
      <Rect x={sx - 2} y={headCY + 6} width={4} height={5} fill={skin} />
      {away ? (
        <BackHead cx={sx} cy={headCY} skin={skin} hair={hair} />
      ) : (
        <Head
          cx={sx}
          cy={headCY}
          skin={skin}
          hair={hair}
          look={look}
          eyeOpen={eyeOpen}
          mood={state}
          glow={working ? 1 : 0}
        />
      )}
      <Circle cx={x + 10} cy={headCY - 6} r={2.6} fill={meta.color} />
      <Emote state={state} x={x + 18} y={headCY - 11} pop={(Math.sin(t * 0.9 + seed) + 1) / 2} />
      <SvgText
        x={x}
        y={baseY + 13}
        fill={O.text}
        fontSize={8}
        textAnchor="middle"
        fontFamily={FONT_MONO}
      >
        {p.label.length > 14 ? `${p.label.slice(0, 13)}…` : p.label}
      </SvgText>
      <SvgText
        x={x}
        y={baseY + 22}
        fill={meta.color}
        fontSize={7}
        textAnchor="middle"
        fontFamily={FONT_MONO}
      >
        {meta.label.toUpperCase()}
      </SvgText>
    </G>
  );
});

// A small worker desk with a laptop that glows when someone is sitting there working.
const WorkerDesk = memo(function WorkerDesk({
  x,
  y,
  busy,
}: {
  x: number;
  y: number;
  busy: boolean;
}): ReactElement {
  return (
    <G>
      <Path
        d={`M ${x - 26} ${y - 4} L ${x + 26} ${y - 4} L ${x + 34} ${y + 4} L ${x - 34} ${y + 4} Z`}
        fill="url(#deskWood)"
        stroke={O.deskEdge}
        strokeWidth={0.6}
      />
      <Rect x={x - 34} y={y + 4} width={68} height={16} fill={O.deskFront} />
      <Rect
        x={x - 12}
        y={y - 11}
        width={24}
        height={14}
        rx={1.5}
        fill="url(#laptop)"
        stroke={busy ? O.monitorScan : O.faint}
        strokeWidth={busy ? 0.8 : 0.5}
      />
      {busy ? <Ellipse cx={x} cy={y - 4} rx={18} ry={8} fill={O.teal} opacity={0.12} /> : null}
    </G>
  );
});

// A framed glass office door on the back wall, lit from the hallway, with a handle + sign.
const OfficeDoor = memo(function OfficeDoor({
  x,
  y,
  h,
}: {
  x: number;
  y: number;
  h: number;
}): ReactElement {
  const w = 48;
  return (
    <G>
      <Rect x={x - 3} y={y - h - 3} width={w + 6} height={h + 3} rx={2} fill="#2b303a" />
      <Rect x={x} y={y - h} width={w} height={h} fill="#161a21" />
      <Rect
        x={x + 6}
        y={y - h + 9}
        width={w - 12}
        height={h * 0.52}
        rx={2}
        fill="url(#winGrad)"
        opacity={0.55}
      />
      <Rect x={x + 3} y={y - 10} width={w - 6} height={7} fill="#20242c" />
      <Circle cx={x + w - 8} cy={y - h * 0.5} r={1.7} fill="#c9cfd8" />
      <Ellipse cx={x + w / 2} cy={y + 6} rx={w * 0.7} ry={8} fill="#ffe6b0" opacity={0.05} />
      <Rect
        x={x + 5}
        y={y - h - 13}
        width={w - 10}
        height={9}
        rx={2}
        fill="#12141a"
        stroke="#2b303a"
        strokeWidth={0.5}
      />
      <SvgText
        x={x + w / 2}
        y={y - h - 6}
        fill="#6fe08a"
        fontSize={5.4}
        textAnchor="middle"
        fontFamily={FONT_MONO}
      >
        OFFICE
      </SvgText>
    </G>
  );
});

// The boss's desk at the head of the room: a bigger executive desk, monitor, nameplate, crowned boss.
const BossDesk = memo(function BossDesk({
  x,
  y,
  waiting,
  t,
}: {
  x: number;
  y: number;
  waiting: boolean;
  t: number;
}): ReactElement {
  const pulse = (Math.sin(t * 3) + 1) / 2;
  return (
    <G>
      {waiting ? (
        <Ellipse cx={x} cy={y + 6} rx={72} ry={26} fill="#ffcf7a" opacity={0.06 + pulse * 0.06} />
      ) : null}
      <Path
        d={`M ${x - 60} ${y + 6} L ${x + 60} ${y + 6} L ${x + 72} ${y + 18} L ${x - 72} ${y + 18} Z`}
        fill="url(#deskWood)"
        stroke={O.deskEdge}
        strokeWidth={0.8}
      />
      <Rect x={x - 72} y={y + 18} width={144} height={20} fill={O.deskFront} />
      <Rect
        x={x - 18}
        y={y - 8}
        width={36}
        height={16}
        rx={2}
        fill="url(#laptop)"
        stroke={O.monitorScan}
        strokeWidth={0.7}
      />
      <Ellipse cx={x} cy={y - 14} rx={9} ry={9} fill="#e7c6a0" />
      <Path
        d={`M ${x - 9} ${y - 15} C ${x - 10} ${y - 26}, ${x + 10} ${y - 26}, ${x + 9} ${y - 15} Z`}
        fill="#20242c"
      />
      <Path d={`M ${x - 7} ${y - 24} l 2 -5 l 3 4 l 2 -6 l 2 6 l 3 -4 l 2 5 Z`} fill="#f6c945" />
      <Rect
        x={x - 30}
        y={y + 22}
        width={60}
        height={11}
        rx={2}
        fill="#12141a"
        stroke={O.deskEdge}
        strokeWidth={0.5}
      />
      <SvgText
        x={x}
        y={y + 30}
        fill="#f6c945"
        fontSize={7.5}
        fontWeight="700"
        textAnchor="middle"
        fontFamily={FONT_MONO}
      >
        BOSS · YOU
      </SvgText>
      {waiting ? (
        <SvgText
          x={x + 40}
          y={y - 14}
          fill="#ffcf7a"
          fontSize={14}
          fontWeight="700"
          textAnchor="middle"
          opacity={0.5 + pulse * 0.5}
        >
          !
        </SvgText>
      ) : null}
    </G>
  );
});

// A round collaboration rug where teammates gather when they're chatting.
const CollabRug = memo(function CollabRug({ x, y }: { x: number; y: number }): ReactElement {
  return (
    <G>
      <Ellipse cx={x} cy={y + 26} rx={64} ry={26} fill="#171a22" />
      <Ellipse
        cx={x}
        cy={y + 26}
        rx={64}
        ry={26}
        fill="none"
        stroke={O.teal}
        strokeWidth={0.6}
        opacity={0.25}
      />
      <Ellipse
        cx={x}
        cy={y + 24}
        rx={16}
        ry={7}
        fill="url(#deskWood)"
        stroke={O.deskEdge}
        strokeWidth={0.5}
      />
    </G>
  );
});

// A whiteboard on the side wall where reviewers stand to go over the diff.
const Whiteboard = memo(function Whiteboard({ x, y }: { x: number; y: number }): ReactElement {
  return (
    <G>
      <Rect
        x={x - 34}
        y={y - 26}
        width={68}
        height={40}
        rx={2}
        fill="#eef1f4"
        stroke={O.deskEdge}
        strokeWidth={1}
      />
      <Line
        x1={x - 26}
        y1={y - 16}
        x2={x + 20}
        y2={y - 16}
        stroke="#3b7d4f"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
      <Line
        x1={x - 26}
        y1={y - 8}
        x2={x + 8}
        y2={y - 8}
        stroke="#c0563c"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
      <Line
        x1={x - 26}
        y1={y}
        x2={x + 24}
        y2={y}
        stroke="#3b6bd6"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
      <SvgText
        x={x}
        y={y + 26}
        fill={O.muted}
        fontSize={7}
        textAnchor="middle"
        fontFamily={FONT_MONO}
      >
        REVIEW
      </SvgText>
    </G>
  );
});

const Plant = memo(function Plant({ x, y, t }: { x: number; y: number; t: number }): ReactElement {
  const sway = Math.sin(t * 0.8 + x) * 2;
  return (
    <G>
      <Ellipse cx={x} cy={y + 15} rx={13} ry={3} fill={O.shadow} opacity={0.3} />
      <Path
        d={`M ${x - 8} ${y} L ${x - 6} ${y + 14} L ${x + 6} ${y + 14} L ${x + 8} ${y} Z`}
        fill={O.pot}
      />
      <Ellipse cx={x + sway} cy={y - 8} rx={9} ry={12} fill={O.plant} />
      <Ellipse cx={x - 5 + sway} cy={y - 4} rx={5} ry={9} fill={O.plantDark} />
      <Ellipse cx={x + 5 + sway * 0.6} cy={y - 5} rx={5} ry={9} fill={O.plantDark} />
    </G>
  );
});

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
      <Circle cx={x} cy={y} r={11} fill="#14141a" stroke={O.faint} strokeWidth={1.2} />
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
        return <Circle key={`dust-${k}`} cx={bx} cy={by} r={0.7} opacity={0.22 + rand(k) * 0.18} />;
      })}
    </G>
  );
});

const SCENE_W = 640;
const SCENE_H = 400;
const HORIZON = 96; // wall/floor junction — the back wall rises to here
const BOSS_POS = { x: SCENE_W / 2, y: 108 };
const COLLAB_POS = { x: 300, y: 214 };
const BOARD_POS = { x: 96, y: 150 };
const WALK_STEP = 3.2; // px/frame (~30fps → ~96px/s walking speed)

// Each teammate's home desk, laid out in up to two rows along the lower half of the room.
function homeDesks(n: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const perRow = Math.min(5, Math.max(1, n));
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const inRow = Math.min(perRow, n - row * perRow);
    const spread = SCENE_W - 150;
    const step = inRow > 1 ? spread / (inRow - 1) : 0;
    const startX = inRow > 1 ? 75 : SCENE_W / 2;
    out.push({ x: startX + col * step, y: 316 + row * 58 });
  }
  return out;
}

// Where a teammate should be RIGHT NOW given what they're doing: at their desk (working/done/idle), on
// the collab rug (talking), at the whiteboard (reviewing), or in front of the boss's desk (waiting).
function targetFor(
  state: OfficeState,
  home: { x: number; y: number },
  gi: number,
  gsize: number,
  seed: number,
  t: number,
): { x: number; y: number } {
  const driftX = Math.sin(t * 0.55 + seed) * 4;
  const driftY = Math.cos(t * 0.4 + seed * 1.3) * 2.5;
  if (state === "talking") {
    const a = (gi / Math.max(1, gsize)) * Math.PI * 2 - Math.PI / 2;
    return {
      x: COLLAB_POS.x + Math.cos(a) * 58 + driftX,
      y: COLLAB_POS.y + 34 + Math.sin(a) * 20 + driftY,
    };
  }
  if (state === "reviewing") return { x: 72 + gi * 58 + driftX, y: BOARD_POS.y + 80 + driftY };
  if (state === "waiting")
    return { x: BOSS_POS.x - 70 + gi * 56 + driftX * 0.6, y: BOSS_POS.y + 64 };
  const sway = state === "idle" ? Math.sin(t * 0.5 + seed) * 10 : driftX * 0.4;
  return { x: home.x + sway, y: home.y };
}

export const OfficeScene = memo(function OfficeScene({
  topic,
}: {
  topic: StoredForumTopic;
}): ReactElement {
  const workers = useMemo(
    () => topic.participants.filter((p) => p.agentId !== "user" && p.agentId !== "system"),
    [topic.participants],
  );
  const sceneH = SCENE_H;
  const [width, setWidth] = useState(SCENE_W);
  const onLayout = useCallback(
    (e: LayoutChangeEvent): void => setWidth(e.nativeEvent.layout.width),
    [],
  );
  const scale = width / SCENE_W;

  // Continuous, framerate-independent clock (seconds). ~30fps keeps the walking + micro-animations
  // smooth while a handful of workers keeps the redraw cheap on both desktop and mobile.
  const [t, setT] = useState(() => 0);
  const startRef = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tick = useCallback(() => setT((Date.now() - startRef.current) / 1000), []);
  useEffect(() => {
    timer.current = setInterval(tick, 33);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [tick]);

  const states = useMemo(() => workers.map((p) => deriveOfficeState(topic, p)), [workers, topic]);
  const desks = useMemo(() => homeDesks(workers.length), [workers.length]);

  // Persistent per-worker positions so movement is continuous across frames: each tick we step the
  // current position toward the state-derived target, which reads as walking to that spot.
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const placed = useMemo(() => {
    const positions = posRef.current;
    const groupSizes = { talking: 0, reviewing: 0, waiting: 0 } as Record<string, number>;
    for (const s of states) if (s in groupSizes) groupSizes[s] = (groupSizes[s] ?? 0) + 1;
    const counters = { talking: 0, reviewing: 0, waiting: 0 } as Record<string, number>;
    return workers.map((p, i) => {
      const state = states[i] ?? "idle";
      const home = desks[i] ?? { x: SCENE_W / 2, y: 316 };
      const gi = state in counters ? counters[state]++ : 0;
      const gsize = groupSizes[state] ?? 1;
      const seed = (p.agentId.charCodeAt(0) || 7) * 3 + i;
      const target = targetFor(state, home, gi, gsize, seed, t);
      const prev = positions.get(p.agentId) ?? { x: target.x, y: target.y };
      const dx = target.x - prev.x;
      const dy = target.y - prev.y;
      const dist = Math.hypot(dx, dy);
      const stepLen = WALK_STEP * (0.72 + rand(seed) * 0.6);
      let nx = target.x;
      let ny = target.y;
      let moving = false;
      if (dist > stepLen) {
        nx = prev.x + (dx / dist) * stepLen;
        ny = prev.y + (dy / dist) * stepLen;
        moving = dist > stepLen * 1.15;
      }
      positions.set(p.agentId, { x: nx, y: ny });
      return { p, state, home, x: nx, y: ny, moving, dirX: dx, dirY: dy };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-steps every clock tick
  }, [workers, states, desks, t]);

  // Depth order: characters further back (smaller y) draw first so nearer ones overlap them.
  const drawOrder = useMemo(
    () => placed.map((_, i) => i).sort((a, b) => (placed[a]!.y ?? 0) - (placed[b]!.y ?? 0)),
    [placed],
  );
  const bossWaiting = topic.pendingHumanQuestion != null || states.some((s) => s === "waiting");

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <Svg width={width} height={sceneH * scale} viewBox={`0 0 ${SCENE_W} ${sceneH}`}>
        <Defs>
          <LinearGradient id="wallGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={O.wallTop} />
            <Stop offset="1" stopColor={O.wallBottom} />
          </LinearGradient>
          <LinearGradient id="floorGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={O.floorTop} />
            <Stop offset="1" stopColor={O.floorBottom} />
          </LinearGradient>
          <LinearGradient id="deskWood" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={O.deskWoodTop} />
            <Stop offset="1" stopColor={O.deskWoodBottom} />
          </LinearGradient>
          <LinearGradient id="chair" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={O.chairTop} />
            <Stop offset="1" stopColor={O.chairBottom} />
          </LinearGradient>
          <LinearGradient id="laptop" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={O.laptopTop} />
            <Stop offset="1" stopColor={O.laptopBottom} />
          </LinearGradient>
          <LinearGradient id="winGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={O.windowGlow} />
            <Stop offset="1" stopColor={O.windowSky} />
          </LinearGradient>
          <RadialGradient id="lamp" cx="0.5" cy="0.2" r="0.9">
            <Stop offset="0" stopColor="#ffd9a0" stopOpacity="0.14" />
            <Stop offset="1" stopColor="#ffd9a0" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        {/* ── room as a 3D box: ceiling, back wall, side walls, floor ── */}
        <Rect x={0} y={0} width={SCENE_W} height={16} fill="#0a0c11" />
        {[0.22, 0.4, 0.6, 0.78].map((f) => (
          <Rect
            key={`ceil-${f}`}
            x={SCENE_W * f - 15}
            y={6}
            width={30}
            height={4}
            rx={2}
            fill="#ffe6b0"
            opacity={0.5}
          />
        ))}
        <Rect x={0} y={16} width={SCENE_W} height={HORIZON - 16} fill="url(#wallGrad)" />
        {[0.12, 0.88].map((f) => (
          <Rect
            key={`pil-${f}`}
            x={SCENE_W * f - 2}
            y={18}
            width={4}
            height={HORIZON - 22}
            fill="#000"
            opacity={0.13}
          />
        ))}
        <Path
          d={`M 0 0 L 36 22 L 36 ${sceneH - 26} L 0 ${sceneH} Z`}
          fill="#0c0e13"
          opacity={0.6}
        />
        <Path
          d={`M ${SCENE_W} 0 L ${SCENE_W - 36} 22 L ${SCENE_W - 36} ${sceneH - 26} L ${SCENE_W} ${sceneH} Z`}
          fill="#0c0e13"
          opacity={0.6}
        />
        <Rect x={0} y={HORIZON} width={SCENE_W} height={sceneH - HORIZON} fill="url(#floorGrad)" />
        <Rect x={0} y={HORIZON - 3} width={SCENE_W} height={3} fill="#20242c" opacity={0.7} />
        <Rect x={0} y={HORIZON} width={SCENE_W} height={4} fill="#000" opacity={0.4} />
        <Rect x={0} y={0} width={SCENE_W} height={sceneH} fill="url(#lamp)" />
        {Array.from({ length: 11 }, (_, i) => {
          const fx = (SCENE_W / 10) * i;
          const bx = SCENE_W / 2 + (fx - SCENE_W / 2) * 0.5;
          return (
            <Line
              key={`v${i}`}
              x1={bx}
              y1={HORIZON + 2}
              x2={fx}
              y2={sceneH}
              stroke={O.grid}
              strokeWidth={0.45}
              opacity={0.5}
            />
          );
        })}
        {[0, 1, 2].map((r) => {
          const gy = HORIZON + 14 + r * ((sceneH - HORIZON - 14) / 3);
          return (
            <Line
              key={`h${r}`}
              x1={36}
              y1={gy}
              x2={SCENE_W - 36}
              y2={gy}
              stroke={O.grid}
              strokeWidth={0.4}
              opacity={0.4}
            />
          );
        })}
        <Rect x={0} y={HORIZON + 4} width={SCENE_W} height={16} fill="#ffffff" opacity={0.02} />
        <OfficeDoor x={96} y={HORIZON} h={HORIZON - 26} />
        <Rect
          x={SCENE_W - 132}
          y={26}
          width={104}
          height={40}
          rx={3}
          fill="url(#winGrad)"
          opacity={0.85}
        />
        <Rect
          x={SCENE_W - 132}
          y={26}
          width={104}
          height={40}
          rx={3}
          fill="none"
          stroke="#2b303a"
          strokeWidth={2}
        />
        <Line
          x1={SCENE_W - 80}
          y1={26}
          x2={SCENE_W - 80}
          y2={66}
          stroke="#2b303a"
          strokeWidth={1.6}
        />
        <Line
          x1={SCENE_W - 132}
          y1={46}
          x2={SCENE_W - 28}
          y2={46}
          stroke="#2b303a"
          strokeWidth={1.6}
        />
        <WallClock x={SCENE_W / 2 - 128} y={44} t={t} />
        <Dust t={t} width={SCENE_W} height={sceneH} />
        <Plant x={48} y={sceneH - 30} t={t} />
        <Plant x={SCENE_W - 48} y={sceneH - 30} t={t} />
        {/* header sign */}
        <SvgText
          x={SCENE_W / 2}
          y={36}
          fill={O.muted}
          fontSize={13}
          fontWeight="700"
          textAnchor="middle"
          fontFamily={FONT_MONO}
        >
          TEAM OFFICE · LIVE
        </SvgText>
        {/* fixed furniture: whiteboard (review), boss desk (head of room), collab rug (chat) */}
        <Whiteboard x={BOARD_POS.x} y={BOARD_POS.y} />
        <BossDesk x={BOSS_POS.x} y={BOSS_POS.y} waiting={bossWaiting} t={t} />
        <CollabRug x={COLLAB_POS.x} y={COLLAB_POS.y} />
        {/* each teammate's home desk (glows when they're sitting there working) */}
        {placed.map((w) => (
          <WorkerDesk
            key={`desk-${w.p.agentId}`}
            x={w.home.x}
            y={w.home.y}
            busy={w.state === "working" && !w.moving}
          />
        ))}
        {/* teammates, drawn back-to-front so nearer figures overlap */}
        {drawOrder.map((i) => {
          const w = placed[i]!;
          return (
            <GameCharacter
              key={w.p.agentId}
              p={w.p}
              state={w.state}
              x={w.x}
              baseY={w.y}
              dirX={w.dirX}
              dirY={w.dirY}
              moving={w.moving}
              t={t}
            />
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
    borderColor: "#2a2a30",
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#0b0b0f",
  },
}));
