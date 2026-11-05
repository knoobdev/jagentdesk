// SVG path-data parser and polygon flattener. Figma's `fillGeometry`/`strokeGeometry` arrive as
// SVG path strings; the web draws them with the native Path2D, but hit testing (and the Node test
// environment, which has no Path2D) needs the commands as data.

export type PathCommand =
  | { cmd: "M"; points: number[] }
  | { cmd: "L"; points: number[] }
  | { cmd: "C"; points: number[] }
  | { cmd: "Q"; points: number[] }
  | { cmd: "Z" };

const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g;

interface SegState {
  x: number;
  y: number;
  startx: number;
  starty: number;
  lastCtrl: number[] | null;
}

/** Parses an SVG path `d` string into absolute M/L/C/Q/Z commands (H/V/S/T/A are converted). */
export function parseSvgPath(d: string): PathCommand[] {
  const commands: PathCommand[] = [];
  const tokens: (string | number)[] = [];
  for (const match of d.matchAll(TOKEN)) {
    tokens.push(match[1] !== undefined ? match[1] : Number(match[2]));
  }
  const state: SegState = { x: 0, y: 0, startx: 0, starty: 0, lastCtrl: null };
  let i = 0;
  let cmd = "";
  let implicit = "";
  const read = (n: number): number[] => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(tokens[i++] as number);
    return out;
  };

  while (i < tokens.length) {
    const token = tokens[i];
    if (typeof token === "string") {
      cmd = token;
      implicit = /[Mm]/.test(cmd) ? (cmd === "M" ? "L" : "l") : cmd;
      i++;
    } else {
      cmd = implicit;
    }
    const relative = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();
    if (upper === "Z") {
      commands.push({ cmd: "Z" });
      state.x = state.startx;
      state.y = state.starty;
      state.lastCtrl = null;
      continue;
    }
    if (upper === "M" || upper === "L") {
      const args = read(2);
      const pts = relative ? [args[0] + state.x, args[1] + state.y] : args;
      commands.push({ cmd: upper, points: pts });
      state.x = pts[0];
      state.y = pts[1];
      if (upper === "M") {
        state.startx = pts[0];
        state.starty = pts[1];
      }
      state.lastCtrl = null;
      continue;
    }
    if (upper === "H" || upper === "V") {
      const value = (tokens[i++] as number) + (relative ? (upper === "H" ? state.x : state.y) : 0);
      const pts = upper === "H" ? [value, state.y] : [state.x, value];
      commands.push({ cmd: "L", points: pts });
      state.x = pts[0];
      state.y = pts[1];
      state.lastCtrl = null;
      continue;
    }
    if (upper === "C") {
      const args = read(6);
      const pts = relative ? args.map((v, k) => v + (k % 2 === 0 ? state.x : state.y)) : args;
      commands.push({ cmd: "C", points: pts });
      state.lastCtrl = [pts[2], pts[3]];
      state.x = pts[4];
      state.y = pts[5];
      continue;
    }
    if (upper === "S") {
      const args = read(4);
      const ref = state.lastCtrl
        ? [2 * state.x - state.lastCtrl[0], 2 * state.y - state.lastCtrl[1]]
        : [state.x, state.y];
      const pts = relative ? args.map((v, k) => v + (k % 2 === 0 ? state.x : state.y)) : args;
      commands.push({ cmd: "C", points: [ref[0], ref[1], pts[0], pts[1], pts[2], pts[3]] });
      state.lastCtrl = [pts[0], pts[1]];
      state.x = pts[2];
      state.y = pts[3];
      continue;
    }
    if (upper === "Q") {
      const args = read(4);
      const pts = relative ? args.map((v, k) => v + (k % 2 === 0 ? state.x : state.y)) : args;
      commands.push({ cmd: "Q", points: pts });
      state.lastCtrl = [pts[0], pts[1]];
      state.x = pts[2];
      state.y = pts[3];
      continue;
    }
    if (upper === "T") {
      const ref = state.lastCtrl
        ? [2 * state.x - state.lastCtrl[0], 2 * state.y - state.lastCtrl[1]]
        : [state.x, state.y];
      const args = read(2);
      const pts = relative ? args.map((v, k) => v + (k % 2 === 0 ? state.x : state.y)) : args;
      commands.push({ cmd: "Q", points: [ref[0], ref[1], pts[0], pts[1]] });
      state.lastCtrl = [ref[0], ref[1]];
      state.x = pts[0];
      state.y = pts[1];
      continue;
    }
    if (upper === "A") {
      const args = read(7);
      const rx = Math.abs(args[0]);
      const ry = Math.abs(args[1]);
      const x = relative ? args[5] + state.x : args[5];
      const y = relative ? args[6] + state.y : args[6];
      for (const cubic of arcToCubics(state.x, state.y, rx, ry, args[2], args[3], args[4], x, y)) {
        commands.push({ cmd: "C", points: cubic });
      }
      state.lastCtrl = null;
      state.x = x;
      state.y = y;
      continue;
    }
    // Unknown command letter — skip its token to avoid spinning.
    i++;
  }
  return commands;
}

/** Converts an SVG arc segment to absolute cubic Bézier control points (endpoint → center). */
function arcToCubics(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  angleDeg: number,
  largeArc: number,
  sweep: number,
  x1In: number,
  y1In: number,
): number[][] {
  if (x0 === x1In && y0 === y1In) return [];
  if (rxIn === 0 || ryIn === 0) return [[x0, y0, x1In, y1In, x1In, y1In]];
  const phi = (angleDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x0 - x1In) / 2;
  const dy = (y0 - y1In) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  let rx = rxIn;
  let ry = ryIn;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const f = Math.sqrt(lambda);
    rx *= f;
    ry *= f;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = den === 0 ? 0 : sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x1In) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y1In) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    const acos = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    return ux * vy - uy * vx < 0 ? -acos : acos;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (sweep === 0 && delta > 0) delta -= 2 * Math.PI;
  if (sweep === 1 && delta < 0) delta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  const kappa = ((4 / 3) * Math.tan(step / 4)) as number;
  const out: number[][] = [];
  let t = theta1;
  for (let s = 0; s < segments; s++) {
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    const t2 = t + step;
    const cosT2 = Math.cos(t2);
    const sinT2 = Math.sin(t2);
    const ep1x = cosPhi * rx * cosT - sinPhi * ry * sinT + cx;
    const ep1y = sinPhi * rx * cosT + cosPhi * ry * sinT + cy;
    const ep2x = cosPhi * rx * cosT2 - sinPhi * ry * sinT2 + cx;
    const ep2y = sinPhi * rx * cosT2 + cosPhi * ry * sinT2 + cy;
    const c1x = ep1x + kappa * (cosPhi * -rx * sinT - sinPhi * ry * cosT);
    const c1y = ep1y + kappa * (sinPhi * -rx * sinT + cosPhi * ry * cosT);
    const c2x = ep2x - kappa * (cosPhi * -rx * sinT2 - sinPhi * ry * cosT2);
    const c2y = ep2y - kappa * (sinPhi * -rx * sinT2 + cosPhi * ry * cosT2);
    out.push([c1x, c1y, c2x, c2y, ep2x, ep2y]);
    t = t2;
  }
  return out;
}

const MAX_FLAT_DEPTH = 12;

function cubicPoints(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  flatness: number,
  out: number[],
  depth = 0,
): void {
  // Flatness test via control-point distance to the chord, the standard technique.
  const ux = 3 * x1 - 2 * x0 - x3;
  const uy = 3 * y1 - 2 * y0 - y3;
  const vx = 3 * x2 - 2 * x0 - x3;
  const vy = 3 * y2 - 2 * y0 - y3;
  if (
    depth >= MAX_FLAT_DEPTH ||
    Math.max(ux * ux + uy * uy, vx * vx + vy * vy) <= flatness * flatness
  ) {
    out.push(x3, y3);
    return;
  }
  const x01 = (x0 + x1) / 2;
  const y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2;
  const y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2;
  const y23 = (y2 + y3) / 2;
  const xm1 = (x01 + x12) / 2;
  const ym1 = (y01 + y12) / 2;
  const xm2 = (x12 + x23) / 2;
  const ym2 = (y12 + y23) / 2;
  const xMid = (xm1 + xm2) / 2;
  const yMid = (ym1 + ym2) / 2;
  cubicPoints(x0, y0, x01, y01, xm1, ym1, xMid, yMid, flatness, out, depth + 1);
  cubicPoints(xMid, yMid, xm2, ym2, x23, y23, x3, y3, flatness, out, depth + 1);
}

/**
 * Flattens parsed commands into closed contours of [x, y, x, y, …] numbers, sampling curves to
 * the given flatness. Used for hit testing only; drawing goes through Path2D.
 */
export function flattenContours(commands: PathCommand[], flatness = 0.1): number[][] {
  const contours: number[][] = [];
  let current: number[] = [];
  let x = 0;
  let y = 0;
  const startContour = (px: number, py: number): void => {
    if (current.length > 1) contours.push(current);
    current = [px, py];
  };
  for (const command of commands) {
    if (command.cmd === "M") {
      x = command.points[0];
      y = command.points[1];
      startContour(x, y);
    } else if (command.cmd === "L") {
      x = command.points[0];
      y = command.points[1];
      current.push(x, y);
    } else if (command.cmd === "C") {
      const p = command.points;
      const out: number[] = [];
      cubicPoints(x, y, p[0], p[1], p[2], p[3], p[4], p[5], flatness, out);
      current.push(...out);
      x = p[4];
      y = p[5];
    } else if (command.cmd === "Q") {
      const p = command.points;
      // Quadratic → cubic for sampling.
      const out: number[] = [];
      cubicPoints(
        x,
        y,
        x + (2 / 3) * (p[0] - x),
        y + (2 / 3) * (p[1] - y),
        p[2] + (2 / 3) * (p[0] - p[2]),
        p[3] + (2 / 3) * (p[1] - p[3]),
        p[2],
        p[3],
        flatness,
        out,
      );
      current.push(...out);
      x = p[2];
      y = p[3];
    } else if (command.cmd === "Z") {
      if (current.length >= 2) current.push(current[0], current[1]);
      x = current[0] ?? x;
      y = current[1] ?? y;
    }
  }
  if (current.length > 1) contours.push(current);
  return contours;
}

/** Point-in-path test honouring the winding rule (SVG path string as Figma sends it). */
export function pathContainsPoint(d: string, windingRule: string, px: number, py: number): boolean {
  const contours = flattenContours(parseSvgPath(d));
  let crossings = 0;
  let winding = 0;
  for (const contour of contours) {
    const n = contour.length;
    for (let i = 0; i < n - 2; i += 2) {
      const x0 = contour[i];
      const y0 = contour[i + 1];
      const x1 = contour[i + 2];
      const y1 = contour[i + 3];
      if (y0 === y1) continue;
      // Half-open interval: a vertex shared by two segments must count exactly once.
      const up = y1 > y0 ? y0 <= py && py < y1 : y1 <= py && py < y0;
      if (!up) continue;
      const t = (py - y0) / (y1 - y0);
      const xAt = x0 + t * (x1 - x0);
      if (xAt > px) {
        winding += y0 < y1 ? 1 : -1;
        crossings++;
      }
    }
  }
  return windingRule === "EVENODD" ? crossings % 2 === 1 : winding !== 0;
}
