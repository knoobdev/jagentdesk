// Path construction for the renderer. On web/desktop the native `Path2D` is used; under Node (the
// vitest environment, and the unit tests' recording context) a recording implementation stands in
// that keeps every command as data so tests can assert the exact drawing stream and hit testing can
// reuse the same shapes.
import { parseSvgPath, type PathCommand } from "./svg-path";

/** Anything accepted by ctx.fill/stroke/clip — the native Path2D or the recording stand-in. */
export type RenderPath = Path2D;

interface Path2DCtor {
  new (d?: string | Path2D | RenderPath): Path2D;
}

function nativeCtor(): Path2DCtor | null {
  const candidate = (globalThis as { Path2D?: unknown }).Path2D;
  return typeof candidate === "function" ? (candidate as Path2DCtor) : null;
}

/** A Path2D stand-in that records its construction commands. */
export class RecordingPath {
  readonly commands: (string | number)[][] = [];
  /** Original path data for hit testing when the path came from an SVG string. */
  svgData: string | null = null;

  constructor(d?: string) {
    if (d !== undefined) {
      this.svgData = d;
      for (const command of parseSvgPath(d)) this.replayParsed(command);
    }
  }

  private replayParsed(command: PathCommand): void {
    if (command.cmd === "Z") {
      this.closePath();
      return;
    }
    const [p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0] = command.points;
    if (command.cmd === "M") this.moveTo(p0, p1);
    else if (command.cmd === "L") this.lineTo(p0, p1);
    else if (command.cmd === "C") this.bezierCurveTo(p0, p1, p2, p3, p4, p5);
    else this.quadraticCurveTo(p0, p1, p2, p3);
  }

  private push(op: string, ...args: number[]): void {
    this.commands.push([op, ...args]);
  }

  moveTo(x: number, y: number): void {
    this.push("moveTo", x, y);
  }
  lineTo(x: number, y: number): void {
    this.push("lineTo", x, y);
  }
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.push("bezierCurveTo", cp1x, cp1y, cp2x, cp2y, x, y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.push("quadraticCurveTo", cpx, cpy, x, y);
  }
  closePath(): void {
    this.push("closePath");
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.push("rect", x, y, w, h);
  }
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    this.push("arc", x, y, radius, startAngle, endAngle, counterclockwise ? 1 : 0);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    this.push("arcTo", x1, y1, x2, y2, radius);
  }
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    this.push(
      "ellipse",
      x,
      y,
      radiusX,
      radiusY,
      rotation,
      startAngle,
      endAngle,
      counterclockwise ? 1 : 0,
    );
  }
}

/** Creates a drawing path, optionally from an SVG `d` string (Figma fillGeometry/strokeGeometry). */
export function newPath(d?: string): RenderPath {
  const Ctor = nativeCtor();
  if (Ctor) return new Ctor(d);
  // Under Node (tests, SSR) there is no Path2D: the recording stand-in implements the subset the
  // renderer uses, so the cast holds at every call site.
  return new RecordingPath(d) as unknown as RenderPath;
}

/** Serialises a path's construction for the recording context's command stream. */
export function serializePath(path: RenderPath | null | undefined): unknown {
  if (!path) return null;
  if (path instanceof RecordingPath) {
    return path.svgData !== null ? { svg: path.svgData } : { commands: path.commands };
  }
  return { native: true };
}
