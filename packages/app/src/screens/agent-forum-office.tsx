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

// Rising "typing spark" particles off the keyboard while a character is heads-down working.
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
        const sx = x - 8 + k * 8 + Math.sin((t + k) * 3) * 2;
        const sy = y - 6 - life * 12;
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

// The desk (in slight perspective), a laptop whose lid glows when working, keyboard, and coffee mug.
const Workstation = memo(function Workstation({
  x,
  y,
  working,
  steam,
}: {
  x: number;
  y: number;
  working: boolean;
  steam: number;
}): ReactElement {
  return (
    <G>
      {/* desk top in perspective (back edge narrower) + front panel + legs */}
      <Path
        d={`M ${x - 30} ${y - 4} L ${x + 30} ${y - 4} L ${x + 40} ${y + 4} L ${x - 40} ${y + 4} Z`}
        fill="url(#deskWood)"
        stroke={O.deskEdge}
        strokeWidth={0.6}
      />
      <Rect x={x - 40} y={y + 4} width={80} height={22} fill={O.deskFront} />
      <Rect x={x - 40} y={y + 4} width={80} height={2} fill={O.deskEdge} opacity={0.5} />
      <Rect x={x - 37} y={y + 26} width={4} height={12} fill="#1b150f" />
      <Rect x={x + 33} y={y + 26} width={4} height={12} fill="#1b150f" />
      {/* laptop: base + lid (we see the outside of the lid) */}
      <Path
        d={`M ${x - 13} ${y + 2} L ${x + 13} ${y + 2} L ${x + 15} ${y + 6} L ${x - 15} ${y + 6} Z`}
        fill={O.keyboard}
      />
      <Rect
        x={x - 12}
        y={y - 12}
        width={24}
        height={15}
        rx={1.6}
        fill="url(#laptop)"
        stroke={working ? O.monitorScan : O.faint}
        strokeWidth={working ? 0.8 : 0.5}
        opacity={0.98}
      />
      {working ? (
        <>
          <Circle cx={x} cy={y - 4.5} r={1.6} fill={O.monitorScan} opacity={0.75} />
          <Ellipse cx={x} cy={y - 4} rx={18} ry={9} fill={O.teal} opacity={0.1} />
        </>
      ) : (
        <Circle cx={x} cy={y - 4.5} r={1.4} fill={O.faint} />
      )}
      {/* mug + steam */}
      <Rect x={x + 20} y={y - 3} width={6} height={6} rx={1} fill={O.mug} />
      <Path d={`M ${x + 26} ${y - 1} h 2 v 2 h -2`} fill="none" stroke={O.mug} strokeWidth={0.8} />
      <Path
        d={`M ${x + 23} ${y - 5} q ${2 * Math.sin(steam * 6)} -3 0 -6`}
        fill="none"
        stroke={O.steam}
        strokeWidth={0.8}
        strokeLinecap="round"
        opacity={0.3}
      />
    </G>
  );
});

interface WorkerMotion {
  working: boolean;
  intensity: number;
  stretch: number;
  eyeOpen: number;
  look: number;
  shoulderY: number;
  headCY: number;
  emotePop: number;
  armPose: "sip" | "stretch" | "rest";
  leftHandY: number;
  rightHandY: number;
}

// Derive all of a character's per-frame motion from the shared clock + their personal seed. Kept out
// of the component so the render stays simple: blink cadence, gaze, typing intensity (+ alternating
// hands), breathing, idle stretch, and coffee sips are all deterministic functions of (state, seed, t).
function computeMotion(state: OfficeState, seed: number, t: number, y: number): WorkerMotion {
  const working = state === "working";
  let intensity = 0;
  if (working) intensity = 1;
  else if (state === "reviewing") intensity = 0.5;
  const typeFreq = 9 + rand(seed) * 3;
  const type = intensity > 0 ? (Math.sin(t * typeFreq + seed) * 0.5 + 0.5) * intensity : 0;
  const typeAlt = Math.sin(t * typeFreq + seed + Math.PI) * 0.5 + 0.5;

  const breathe = Math.sin(t * 1.5 + seed) * 0.7;
  const stretchCycle = (t * 0.12 + rand(seed) * 5) % 5;
  const stretch = state === "idle" && stretchCycle > 4.2 ? (stretchCycle - 4.2) / 0.8 : 0;
  const sipCycle = (t * 0.1 + rand(seed + 1) * 7) % 7;
  const sipping = (state === "idle" || state === "talking") && sipCycle > 6.3;

  const blinkCycle = (t + rand(seed) * 6) % (3.5 + rand(seed + 2) * 1.5);
  const eyeOpen = blinkCycle < 0.13 ? 0 : 1;
  const idleGaze = state === "idle" ? 1 : 0.4;
  const look = working ? 0.7 : Math.sin(t * 0.6 + seed) * idleGaze;

  const lift = breathe - stretch * 3;
  let armPose: "sip" | "stretch" | "rest" = "rest";
  if (sipping) armPose = "sip";
  else if (stretch > 0) armPose = "stretch";
  const resting = armPose === "rest";

  return {
    working,
    intensity,
    stretch,
    eyeOpen,
    look,
    shoulderY: y - 20 + lift,
    headCY: y - 33 + lift - stretch * 2,
    emotePop: (Math.sin(t * 0.9 + seed) + 1) / 2,
    armPose,
    leftHandY: y + 1 + (resting ? type * 1.6 : 0),
    rightHandY: y + 1 + (resting ? typeAlt * intensity * 1.6 : 0),
  };
}

// One full workstation: contact shadow + office chair + a shaded, breathing, blinking, typing/sipping/
// stretching seated character + its mood emote.
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
  const seed = (p.agentId.charCodeAt(0) || 7) + (p.agentId.charCodeAt(3) || 3) * 2;
  const hair = HAIRS[Math.floor(rand(seed) * HAIRS.length) % HAIRS.length] ?? HAIRS[0];
  const skin = SKINS[Math.floor(rand(seed + 5) * SKINS.length) % SKINS.length] ?? SKINS[0];
  const m = computeMotion(state, seed, t, y);
  const { working, intensity, shoulderY, headCY, armPose, leftHandY, rightHandY } = m;

  return (
    <G>
      {/* contact shadow grounds the whole station */}
      <Ellipse cx={x} cy={y + 40} rx={38} ry={6} fill={O.shadow} opacity={0.32} />
      {/* office chair back behind the torso */}
      <Rect x={x - 15} y={shoulderY - 6} width={30} height={30} rx={9} fill="url(#chair)" />
      <Rect x={x - 11} y={shoulderY - 10} width={22} height={9} rx={5} fill="url(#chair)" />
      {/* torso: shirt with shading */}
      <Path
        d={`M ${x - 13} ${y + 6} L ${x - 12} ${shoulderY + 2} Q ${x} ${shoulderY - 5} ${x + 12} ${shoulderY + 2} L ${x + 13} ${y + 6} Z`}
        fill={shirt}
      />
      <Path
        d={`M ${x - 13} ${y + 6} L ${x - 12} ${shoulderY + 2} Q ${x - 8} ${shoulderY} ${x - 5} ${shoulderY + 1} L ${x - 5} ${y + 6} Z`}
        fill="#fff"
        opacity={0.08}
      />
      <Path
        d={`M ${x + 5} ${y + 6} L ${x + 5} ${shoulderY + 1} Q ${x + 9} ${shoulderY} ${x + 12} ${shoulderY + 2} L ${x + 13} ${y + 6} Z`}
        fill="#000"
        opacity={0.14}
      />
      {/* collar + neck */}
      <Rect x={x - 2.5} y={headCY + 6} width={5} height={5} fill={skin} />
      <Path
        d={`M ${x - 4} ${shoulderY + 1} L ${x} ${headCY + 9} L ${x + 4} ${shoulderY + 1}`}
        fill="none"
        stroke="#000"
        strokeWidth={0.6}
        opacity={0.15}
      />
      {/* arms + hands */}
      {armPose === "sip" ? (
        <G stroke={skin} strokeWidth={3.4} strokeLinecap="round">
          <Line x1={x - 9} y1={shoulderY + 8} x2={x - 13} y2={y + 2} />
          <Line x1={x + 9} y1={shoulderY + 8} x2={x + 2} y2={headCY + 5} />
        </G>
      ) : null}
      {armPose === "stretch" ? (
        <G stroke={skin} strokeWidth={3.4} strokeLinecap="round">
          <Line x1={x - 9} y1={shoulderY + 6} x2={x - 13} y2={headCY - 2 - m.stretch * 3} />
          <Line x1={x + 9} y1={shoulderY + 6} x2={x + 13} y2={headCY - 2 - m.stretch * 3} />
        </G>
      ) : null}
      {armPose === "rest" ? (
        <G stroke={skin} strokeWidth={3.4} strokeLinecap="round">
          <Line x1={x - 9} y1={shoulderY + 8} x2={x - 9} y2={leftHandY} />
          <Line x1={x + 9} y1={shoulderY + 8} x2={x + 9} y2={rightHandY} />
        </G>
      ) : null}
      <Head
        cx={x}
        cy={headCY}
        skin={skin}
        hair={hair}
        look={m.look}
        eyeOpen={m.eyeOpen}
        mood={state}
        glow={working ? 1 : 0}
      />
      {/* laptop drawn in front so hands rest on it and it occludes the lower torso */}
      <Workstation x={x} y={y} working={working} steam={t + seed} />
      <Sparks x={x} y={y} t={t} intensity={intensity} />
      {/* status dot + emote */}
      <Circle cx={x + 13} cy={headCY - 7} r={3} fill={meta.color} />
      <Emote state={state} x={x + 21} y={headCY - 12} pop={m.emotePop} />
      {/* name + role */}
      <SvgText
        x={x}
        y={y + 50}
        fill={O.text}
        fontSize={9}
        textAnchor="middle"
        fontFamily={FONT_MONO}
      >
        {p.label.length > 16 ? `${p.label.slice(0, 15)}…` : p.label}
      </SvgText>
      <SvgText
        x={x}
        y={y + 60}
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
const DESK_COLS = 3;
const CELL_W = 184;
const CELL_H = 168;
const MARGIN_X = 68;
const MARGIN_TOP = 92;

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
  const sceneH = MARGIN_TOP + rows * CELL_H + 44;
  const [width, setWidth] = useState(SCENE_W);
  const onLayout = useCallback(
    (e: LayoutChangeEvent): void => setWidth(e.nativeEvent.layout.width),
    [],
  );
  const scale = width / SCENE_W;

  // Continuous, framerate-independent clock (seconds). ~30fps keeps micro-animations smooth while a
  // handful of workers keeps the redraw cheap on both desktop and mobile.
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
        {/* room */}
        <Rect x={0} y={0} width={SCENE_W} height={sceneH} fill="url(#wallGrad)" />
        <Rect x={0} y={54} width={SCENE_W} height={sceneH - 54} fill="url(#floorGrad)" />
        <Rect x={0} y={54} width={SCENE_W} height={3} fill="#000" opacity={0.35} />
        {/* warm ambient pools */}
        <Rect x={0} y={0} width={SCENE_W} height={sceneH} fill="url(#lamp)" />
        {/* floor grid in perspective (fans out toward the viewer) */}
        {Array.from({ length: 11 }, (_, i) => {
          const fx = (SCENE_W / 10) * i;
          const bx = SCENE_W / 2 + (fx - SCENE_W / 2) * 0.55;
          return (
            <Line
              key={`v${i}`}
              x1={bx}
              y1={57}
              x2={fx}
              y2={sceneH}
              stroke={O.grid}
              strokeWidth={0.5}
            />
          );
        })}
        {[0, 1, 2].map((r) => {
          const gy = 70 + r * ((sceneH - 70) / 3);
          return (
            <Line
              key={`h${r}`}
              x1={0}
              y1={gy}
              x2={SCENE_W}
              y2={gy}
              stroke={O.grid}
              strokeWidth={0.4}
              opacity={0.6}
            />
          );
        })}
        {/* window with daylight */}
        <Rect
          x={SCENE_W - 122}
          y={12}
          width={100}
          height={32}
          rx={3}
          fill="url(#winGrad)"
          opacity={0.85}
        />
        <Line
          x1={SCENE_W - 72}
          y1={12}
          x2={SCENE_W - 72}
          y2={44}
          stroke={O.wallBottom}
          strokeWidth={2}
        />
        <Line
          x1={SCENE_W - 122}
          y1={28}
          x2={SCENE_W - 22}
          y2={28}
          stroke={O.wallBottom}
          strokeWidth={2}
        />
        <WallClock x={64} y={32} t={t} />
        <Dust t={t} width={SCENE_W} height={sceneH} />
        <Plant x={26} y={sceneH - 44} t={t} />
        <Plant x={SCENE_W - 26} y={sceneH - 44} t={t} />
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
        {workers.map((p, i) => {
          const col = i % DESK_COLS;
          const row = Math.floor(i / DESK_COLS);
          const x = MARGIN_X + col * CELL_W + CELL_W / 2 - 20;
          const y = MARGIN_TOP + row * CELL_H + 44;
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
    borderColor: "#2a2a30",
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#0b0b0f",
  },
}));
