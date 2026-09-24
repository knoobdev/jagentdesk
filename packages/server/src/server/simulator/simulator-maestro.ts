import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { execCommand } from "../../utils/spawn.js";
import type { SimUiElement } from "@jagentdesk/protocol/simulator/rpc-schemas";

// Maestro-backed HID + element-tree backend. Maestro drives the simulator through an on-device
// XCUITest driver (the same WebDriverAgent family MobAI's own CI uses), so tap/swipe/type and the
// accessibility hierarchy work smoothly, target elements precisely, run concurrently per device,
// and don't touch the host cursor — and, unlike idb_companion, install on macOS versions Xcode's
// newest idb build refuses. One flow is generated per action; coordinates are sent as percentages
// of the device screen so we never depend on point-vs-pixel scale.

function maestroBin(): string {
  // Prefer PATH; fall back to the default installer location.
  return process.env.MAESTRO_BIN || join(homedir(), ".maestro", "bin", "maestro");
}

async function runMaestro(args: string[], timeout = 120_000): Promise<string> {
  // Maestro's own launcher resolves the JDK it bundles; run via PATH first, else the absolute bin.
  try {
    const result = await execCommand("maestro", args, { timeout, maxBuffer: 32 * 1024 * 1024 });
    return result.stdout ?? "";
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      const result = await execCommand(maestroBin(), args, {
        timeout,
        maxBuffer: 32 * 1024 * 1024,
      });
      return result.stdout ?? "";
    }
    throw error;
  }
}

export async function probeMaestro(): Promise<boolean> {
  try {
    await runMaestro(["--version"], 15_000);
    return true;
  } catch {
    return false;
  }
}

interface RawNode {
  attributes?: Record<string, string>;
  children?: RawNode[];
}

// Maestro bounds are "[x1,y1][x2,y2]" in device points.
function parseBounds(b: string | undefined): { x: number; y: number; w: number; h: number } | null {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b ?? "");
  if (!m) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export class MaestroBackend {
  // Device screen size in points, learned from the hierarchy root bounds; caches so a tap needn't
  // re-query it every call.
  private readonly sizeByUdid = new Map<string, { w: number; h: number }>();

  async describeUi(udid: string): Promise<SimUiElement[]> {
    const raw = await runMaestro(["--device", udid, "hierarchy"]);
    const start = raw.indexOf("{");
    if (start < 0) return [];
    let tree: RawNode;
    try {
      tree = JSON.parse(raw.slice(start)) as RawNode;
    } catch {
      return [];
    }
    const rootBounds = parseBounds(tree.attributes?.bounds);
    if (rootBounds && rootBounds.w > 0 && rootBounds.h > 0) {
      this.sizeByUdid.set(udid, { w: rootBounds.w, h: rootBounds.h });
    }
    const out: SimUiElement[] = [];
    const walk = (node: RawNode) => {
      const a = node.attributes ?? {};
      const bounds = parseBounds(a.bounds);
      const label = a.accessibilityText || a.text || a.title || a.value || "";
      // Keep nodes that are actually addressable: they have a real frame and either a label,
      // an id, or are interactive. Skip the zero-size container noise.
      if (bounds && (bounds.w > 0 || bounds.h > 0) && (label || a["resource-id"])) {
        out.push({
          role: a["resource-id"] ? "control" : "text",
          label,
          identifier: a["resource-id"] ?? "",
          x: bounds.x,
          y: bounds.y,
          width: bounds.w,
          height: bounds.h,
          enabled: a.enabled !== "false",
        });
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    return out;
  }

  private async deviceSize(udid: string): Promise<{ w: number; h: number }> {
    const cached = this.sizeByUdid.get(udid);
    if (cached) return cached;
    await this.describeUi(udid); // populates the cache from the hierarchy root
    return this.sizeByUdid.get(udid) ?? { w: 393, h: 852 };
  }

  private async pct(udid: string, x: number, y: number): Promise<{ px: number; py: number }> {
    const { w, h } = await this.deviceSize(udid);
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    return { px: clamp((x / w) * 100), py: clamp((y / h) * 100) };
  }

  private async runFlow(udid: string, body: string): Promise<void> {
    const file = join(tmpdir(), `simfleet-flow-${randomUUID()}.yaml`);
    await writeFile(file, `appId: any\n---\n${body}\n`, "utf8");
    try {
      await runMaestro(["--device", udid, "test", file]);
    } finally {
      await unlink(file).catch(() => {});
    }
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    const { px, py } = await this.pct(udid, x, y);
    // Maestro's point-percent parser only accepts integers.
    await this.runFlow(udid, `- tapOn:\n    point: ${Math.round(px)}%, ${Math.round(py)}%`);
  }

  async swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
  ): Promise<void> {
    const a = await this.pct(udid, x1, y1);
    const b = await this.pct(udid, x2, y2);
    const dur = durationMs && durationMs > 0 ? durationMs : 400;
    await this.runFlow(
      udid,
      `- swipe:\n    start: ${Math.round(a.px)}%, ${Math.round(a.py)}%\n    end: ${Math.round(b.px)}%, ${Math.round(b.py)}%\n    duration: ${dur}`,
    );
  }

  async inputText(udid: string, text: string): Promise<void> {
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await this.runFlow(udid, `- inputText: "${escaped}"`);
  }
}
