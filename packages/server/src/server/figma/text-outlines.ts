import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_SVG_CHARS = 16 * 1024 * 1024;
const TAGS = new Set([
  "g",
  "path",
  "use",
  "defs",
  "clipPath",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "line",
]);

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function box(value: unknown): Box | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  if (![b.x, b.y, b.width, b.height].every((v) => typeof v === "number" && Number.isFinite(v)))
    return null;
  return (b.width as number) > 0 && (b.height as number) > 0 ? (b as unknown as Box) : null;
}

function children(element: Element): Element[] {
  const result: Element[] = [];
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child as Element);
  }
  return result;
}

function elements(root: Element): Element[] {
  const result = [root];
  for (let i = 0; i < result.length; i++) result.push(...children(result[i]!));
  return result;
}

function translationOnly(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Array.isArray(value[0]) ||
    !Array.isArray(value[1])
  )
    return false;
  return value[0][0] === 1 && value[0][1] === 0 && value[1][0] === 0 && value[1][1] === 1;
}

function simpleText(node: FigmaNode): boolean {
  return (
    node.type === "TEXT" &&
    node.visible !== false &&
    (node.opacity === undefined || node.opacity === 1) &&
    (node.blendMode === undefined ||
      node.blendMode === "NORMAL" ||
      node.blendMode === "PASS_THROUGH") &&
    node.isMask !== true &&
    translationOnly(node.relativeTransform) &&
    (!Array.isArray(node.effects) || node.effects.every((effect) => effect.visible === false)) &&
    (!Array.isArray(node.strokes) || node.strokes.every((stroke) => stroke.visible === false)) &&
    Array.isArray(node.fills) &&
    node.fills.every((fill) => fill.visible === false || fill.type === "SOLID")
  );
}

function svgTranslationOnly(transform: string): boolean {
  if (!transform.trim()) return true;
  const terms = transform.match(/(?:translate|matrix)\([^)]*\)/g);
  if (!terms || terms.join("").replace(/\s/g, "") !== transform.replace(/\s/g, "")) return false;
  return terms.every((term) => {
    const values = term
      .slice(term.indexOf("(") + 1, -1)
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (!values.every(Number.isFinite)) return false;
    return term.startsWith("translate")
      ? values.length >= 1 && values.length <= 2
      : values.length === 6 &&
          values[0] === 1 &&
          values[1] === 0 &&
          values[2] === 0 &&
          values[3] === 1;
  });
}

/** Local references only; no executing SVG/XML or loading external resources. Unsupported
 * styling fails closed to the existing node-export path rather than approximating glyphs. */
function references(root: Element): Set<string> | null {
  const refs = new Set<string>();
  for (const element of elements(root)) {
    if (!TAGS.has(element.localName || element.tagName)) return null;
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes.item(i)!;
      if (/^on/i.test(attr.name) || ["style", "class", "filter"].includes(attr.name)) return null;
      if ((attr.localName === "href" || attr.name === "href") && !attr.value.startsWith("#"))
        return null;
      if (attr.localName === "href" || attr.name === "href") refs.add(attr.value.slice(1));
      for (const match of attr.value.matchAll(/url\(\s*["']?([^\s)'"\]]+)["']?\s*\)/g)) {
        if (!match[1]?.startsWith("#")) return null;
        refs.add(match[1].slice(1));
      }
    }
  }
  return refs;
}

interface SvgContext {
  source: Element;
  bounds: Box;
  viewBox: number[];
  parser: DOMParser;
  nodes: Map<string, Element>;
  definitions: Map<string, Element>;
  duplicates: Set<string>;
}

function indexSvgElements(source: Element) {
  const nodes = new Map<string, Element>();
  const definitions = new Map<string, Element>();
  const duplicates = new Set<string>();
  for (const element of elements(source)) {
    const nodeId = element.getAttribute("data-node-id");
    if (nodeId) {
      if (nodes.has(nodeId)) duplicates.add(nodeId);
      else nodes.set(nodeId, element);
    }
    const id = element.getAttribute("id");
    if (id) {
      if (definitions.has(id)) duplicates.add(`#${id}`);
      else definitions.set(id, element);
    }
  }
  return { nodes, definitions, duplicates };
}

function parseFrame(svgText: string, root: FigmaNode): SvgContext | null {
  const bounds = box(root.absoluteBoundingBox);
  if (
    !bounds ||
    !["FRAME", "COMPONENT", "INSTANCE"].includes(root.type) ||
    !translationOnly(root.relativeTransform) ||
    svgText.length > MAX_SVG_CHARS ||
    /<!DOCTYPE|<!ENTITY/i.test(svgText)
  )
    return null;
  const parser = new DOMParser({
    onError: () => {
      throw new Error("Invalid SVG XML");
    },
  });
  const source = parser.parseFromString(svgText, "image/svg+xml").documentElement;
  if (
    !source ||
    source.localName !== "svg" ||
    source.namespaceURI !== SVG_NS ||
    ["transform", "style", "class", "stroke", "color"].some((attr) => source.hasAttribute(attr))
  )
    return null;
  const rootFill = source.getAttribute("fill");
  if (rootFill && !/^(?:none|black|white|#[0-9a-f]{3,8})$/i.test(rootFill)) return null;
  const viewBox = source
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    !viewBox ||
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    Math.abs(viewBox[2]! - Math.ceil(bounds.width)) > 0.001 ||
    Math.abs(viewBox[3]! - Math.ceil(bounds.height)) > 0.001
  )
    return null;
  return { source, bounds, viewBox, parser, ...indexSvgElements(source) };
}

function ancestorTransforms(element: Element, source: Element): string[] | null {
  const result: string[] = [];
  for (let parent = element.parentNode; parent && parent !== source; parent = parent.parentNode) {
    if (parent.nodeType !== 1) return null;
    const ancestor = parent as Element;
    const transform = ancestor.getAttribute("transform") ?? "";
    if (
      !svgTranslationOnly(transform) ||
      ["fill", "stroke", "color", "style", "class"].some((attr) => ancestor.hasAttribute(attr))
    )
      return null;
    if (transform) result.unshift(transform);
  }
  return result;
}

function glyphDefinitions(context: SvgContext, refs: Set<string>): Element[] | null {
  const needed: Element[] = [];
  const visited = new Set<string>();
  for (const ref of refs) {
    if (visited.has(ref)) continue;
    visited.add(ref);
    const definition = context.definitions.get(ref);
    const more = definition && !context.duplicates.has(`#${ref}`) ? references(definition) : null;
    if (!definition || !more) return null;
    needed.push(definition);
    for (const id of more) refs.add(id);
  }
  return needed;
}

function serializeGlyph(
  context: SvgContext,
  element: Element,
  bounds: Box,
  ancestors: string[],
  definitions: Element[],
): string {
  const doc = context.parser.parseFromString(`<svg xmlns="${SVG_NS}"/>`, "image/svg+xml");
  const svg = doc.documentElement!;
  // Figma's scale-1 absolute SVG export rounds its viewport up, including fractional text
  // line boxes. Preserve that viewport so the existing renderer applies the same box mapping.
  const width = Math.ceil(bounds.width);
  const height = Math.ceil(bounds.height);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("fill", context.source.getAttribute("fill") || "none");
  if (definitions.length) {
    const defs = doc.createElementNS(SVG_NS, "defs");
    for (const definition of definitions) defs.appendChild(doc.importNode(definition, true));
    svg.appendChild(defs);
  }
  let container = doc.createElementNS(SVG_NS, "g");
  container.setAttribute(
    "transform",
    `translate(${context.bounds.x - bounds.x - context.viewBox[0]!} ${context.bounds.y - bounds.y - context.viewBox[1]!})`,
  );
  svg.appendChild(container);
  for (const transform of ancestors) {
    const group = doc.createElementNS(SVG_NS, "g");
    group.setAttribute("transform", transform);
    container.appendChild(group);
    container = group;
  }
  container.appendChild(doc.importNode(element, true));
  return new XMLSerializer().serializeToString(svg);
}

function extractGlyph(context: SvgContext, node: FigmaNode): string | null {
  if (!simpleText(node) || context.duplicates.has(node.id)) return null;
  const bounds = box(node.absoluteBoundingBox);
  const element = context.nodes.get(node.id);
  if (!bounds || !element || !svgTranslationOnly(element.getAttribute("transform") ?? ""))
    return null;
  const refs = references(element);
  const ancestors = ancestorTransforms(element, context.source);
  if (!refs || !ancestors) return null;
  const definitions = glyphDefinitions(context, refs);
  return definitions ? serializeGlyph(context, element, bounds, ancestors, definitions) : null;
}

/** Extract only simple TEXT glyphs whose layout coordinates are provably in this frame's
 * exported SVG space. The caller keeps the normal node export for all other IDs. */
export function extractFrameTextOutlines(svgText: string, root: FigmaNode): Map<string, string> {
  const output = new Map<string, string>();
  try {
    const context = parseFrame(svgText, root);
    if (!context) return output;
    const nodes: FigmaNode[] = [root];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.visible === false || !translationOnly(node.relativeTransform)) continue;
      if (Array.isArray(node.children)) nodes.push(...node.children);
      const glyph = extractGlyph(context, node);
      if (glyph) output.set(node.id, glyph);
    }
  } catch {
    return new Map();
  }
  return output;
}
