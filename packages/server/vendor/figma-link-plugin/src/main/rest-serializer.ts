// Serializes live Figma plugin nodes into the shape Figma's REST API returns from
// `GET /v1/files/:key/nodes` (docs/spec/32-figma.md: the app renders the REST node
// format from either source — link-provided subtrees must be indistinguishable).
// The renderer consumes id/name/type/children plus the styling fields; unknown
// properties pass through untouched on the client, so extra fields are harmless
// and missing ones just leave a feature dark.

type AnyNode = BaseNode & { [key: string]: unknown };

const isMixed = (value: unknown): boolean => String(value) === "figma.mixed";

function rectOf(node: AnyNode): Record<string, number> | null {
  const box = node.absoluteBoundingBox as { x: number; y: number; width: number; height: number } | null;
  if (!box) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function colorHex(color: { r: number; g: number; b: number; a?: number }): string {
  const channel = (value: number): string =>
    Math.min(255, Math.max(0, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}${channel(color.a ?? 1)}`;
}

function paint(paint: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { type: paint.type };
  switch (paint.type) {
    case "SOLID": {
      const color = paint.color as { r: number; g: number; b: number };
      out.color = { r: color.r, g: color.g, b: color.b, a: (paint.opacity as number) ?? 1 };
      break;
    }
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND": {
      out.gradientStops = ((paint.gradientStops as Record<string, unknown>[]) ?? []).map((stop) => ({
        position: (stop as { position: number }).position,
        color: {
          ...((stop as { color: { r: number; g: number; b: number } }).color ?? { r: 0, g: 0, b: 0 }),
          a: (stop as { color: { a?: number } }).color?.a ?? 1
        }
      }));
      out.gradientTransform = paint.gradientTransform;
      break;
    }
    case "IMAGE": {
      out.imageRef = paint.imageHash ?? null;
      out.scaleMode = paint.scaleMode;
      out.imageTransform = paint.imageTransform;
      break;
    }
    default:
      break;
  }
  if (paint.blendMode && paint.blendMode !== "NORMAL") out.blendMode = paint.blendMode;
  return out;
}

function paintArray(node: AnyNode, key: "fills" | "strokes"): unknown {
  const value = node[key];
  if (value === undefined || isMixed(value)) return value === undefined ? undefined : "mixed";
  return (value as Record<string, unknown>[]).map(paint);
}

function effect(effect: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { type: effect.type, visible: effect.visible !== false };
  if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
    const color = (effect.color ?? { r: 0, g: 0, b: 0, a: 0.5 }) as {
      r: number;
      g: number;
      b: number;
      a?: number;
    };
    out.color = { r: color.r, g: color.g, b: color.b, a: color.a ?? 1 };
    out.offset = effect.offset ?? { x: 0, y: 0 };
    out.radius = effect.radius ?? 0;
    if (effect.spread !== undefined) out.spread = effect.spread;
  } else {
    out.radius = effect.radius ?? 0;
  }
  return out;
}

function geometry(node: AnyNode, out: Record<string, unknown>): void {
  if ("visible" in node) out.visible = node.visible;
  if ("locked" in node) out.locked = node.locked;
  if ("opacity" in node && !isMixed(node.opacity)) out.opacity = node.opacity;
  if ("blendMode" in node && node.blendMode !== "PASS_THROUGH") out.blendMode = node.blendMode;
  const box = rectOf(node);
  if (box) out.absoluteBoundingBox = box;
  const renderBox = node.absoluteRenderBounds as typeof box | null;
  if (renderBox) out.absoluteRenderBounds = renderBox;
  if ("cornerRadius" in node && !isMixed(node.cornerRadius)) out.cornerRadius = node.cornerRadius;
  if ("rectangleCornerRadii" in node) out.rectangleCornerRadii = node.rectangleCornerRadii;
  if ("fills" in node) {
    const fills = paintArray(node, "fills");
    if (fills !== undefined) out.fills = fills;
  }
  if ("strokes" in node) {
    const strokes = paintArray(node, "strokes");
    if (strokes !== undefined) out.strokes = strokes;
    if ("strokeWeight" in node && !isMixed(node.strokeWeight)) out.strokeWeight = node.strokeWeight;
    if ("dashPattern" in node) out.dashPattern = node.dashPattern;
  }
  if ("effects" in node && !isMixed(node.effects)) {
    out.effects = (node.effects as Record<string, unknown>[]).map(effect);
  }
  if ("constraints" in node) out.constraints = node.constraints;
  if ("exportSettings" in node && Array.isArray(node.exportSettings) && node.exportSettings.length > 0) {
    out.exportSettings = node.exportSettings;
  }
  if ("style" in node && node.style && Object.keys(node.style as object).length > 0) {
    out.style = node.style;
  }
}

function autoLayout(node: AnyNode, out: Record<string, unknown>): void {
  if (!("layoutMode" in node)) return;
  const mode = node.layoutMode as string;
  if (mode === "NONE") {
    out.layoutMode = "NONE";
    return;
  }
  out.layoutMode = mode;
  if ("itemSpacing" in node && !isMixed(node.itemSpacing)) out.itemSpacing = node.itemSpacing;
  if ("counterAxisSpacing" in node && !isMixed(node.counterAxisSpacing))
    out.counterAxisSpacing = node.counterAxisSpacing;
  if ("paddingTop" in node && !isMixed(node.paddingTop)) out.paddingTop = node.paddingTop;
  if ("paddingRight" in node && !isMixed(node.paddingRight)) out.paddingRight = node.paddingRight;
  if ("paddingBottom" in node && !isMixed(node.paddingBottom)) out.paddingBottom = node.paddingBottom;
  if ("paddingLeft" in node && !isMixed(node.paddingLeft)) out.paddingLeft = node.paddingLeft;
  if ("primaryAxisAlignItems" in node) out.primaryAxisAlignItems = node.primaryAxisAlignItems;
  if ("counterAxisAlignItems" in node) out.counterAxisAlignItems = node.counterAxisAlignItems;
  if ("primaryAxisSizingMode" in node) out.primaryAxisSizingMode = node.primaryAxisSizingMode;
  if ("counterAxisSizingMode" in node) out.counterAxisSizingMode = node.counterAxisSizingMode;
  if ("layoutWrap" in node) out.layoutWrap = node.layoutWrap;
  if ("clipsContent" in node) out.clipsContent = node.clipsContent;
}

function textContent(node: AnyNode, out: Record<string, unknown>): void {
  if (node.type !== "TEXT") return;
  const text = node as unknown as {
    characters: string | typeof figma.mixed;
    textStyleId?: string;
  };
  out.characters = typeof text.characters === "string" ? text.characters : "";
  const style = node.style as Record<string, unknown> | undefined;
  if (style) {
    out.style = {
      fontFamily: typeof style.fontFamily === "string" ? style.fontFamily : "mixed",
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      italic: style.italic,
      textAlignHorizontal: style.textAlignHorizontal,
      textAlignVertical: style.textAlignVertical,
      textCase: style.textCase,
      textDecoration: style.textDecoration,
      lineHeightUnit: style.lineHeightUnit,
      lineHeightPx: style.lineHeightPx
    };
  }
  if ("textStyleId" in text && text.textStyleId) out.styles = { text: text.textStyleId };
}

function reflow(node: AnyNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type
  };
  if (node.parent && node.parent.type === "PAGE") {
    const index = (node.parent as ChildrenMixin<BaseNode>).children.indexOf(node as SceneNode);
    if (index >= 0) out.childIndex = index;
  }
  geometry(node, out);
  autoLayout(node, out);
  textContent(node, out);
  if (node.type === "INSTANCE" && "componentId" in node) out.componentId = node.componentId;
  if ("componentPropertyReferences" in node && node.componentPropertyReferences) {
    out.componentPropertyReferences = node.componentPropertyReferences;
  }
  return out;
}

/** Serialize a node and its subtree in REST node format (docs/spec/32-figma.md). */
export function serializeRestNode(node: BaseNode): Record<string, unknown> {
  const out = reflow(node as AnyNode);
  if ("children" in node) {
    out.children = (node as unknown as { children: readonly BaseNode[] }).children.map(serializeRestNode);
  }
  return out;
}

/** The current page skeleton the outline view needs: top-level frames with bounds. */
export function serializeFrameSummaries(page: PageNode): Record<string, unknown>[] {
  return page.children.map((child) => {
    const box = (child as AnyNode).absoluteBoundingBox as {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null;
    return {
      id: child.id,
      name: child.name,
      type: child.type,
      bounds: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : { x: 0, y: 0, width: 0, height: 0 }
    };
  });
}
