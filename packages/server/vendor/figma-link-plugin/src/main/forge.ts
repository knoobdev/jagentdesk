import { qualityPreflight, qualityAudit, checkpointGet, checkpointCommit } from "./forgeQuality";
// Forge additions: authoring tools the upstream bridge does not provide.
// Tool names and parameters follow the figma-mcp-go plugin (MIT) so agents can
// call them the same way. The manifest uses documentAccess "dynamic-page", so
// every lookup and style/reaction setter here uses the async Plugin API.

type Params = Record<string, unknown>;

export const FORGE_READ_TYPES = [
  "design_preflight",
  "audit_design",
  "get_build_checkpoint",
  "get_local_components",
  "export_tokens",
  "get_reactions",
  "scan_text_nodes",
  "search_nodes",
  "scan_nodes_by_types",
  "get_fonts",
  "get_viewport",
  "get_annotations",
] as const;

export const FORGE_EDIT_TYPES = [
  "commit_build_checkpoint",
  "create_component",
  "create_instance",
  "combine_as_variants",
  "swap_component",
  "detach_instance",
  "create_variable_collection",
  "add_variable_mode",
  "create_variable",
  "set_variable_value",
  "bind_variable_to_node",
  "delete_variable",
  "create_paint_style",
  "create_text_style",
  "create_effect_style",
  "create_grid_style",
  "update_paint_style",
  "delete_style",
  "apply_style_to_node",
  "set_reactions",
  "remove_reactions",
  "set_layout_child",
  "set_constraints",
  "rotate_nodes",
  "reorder_nodes",
  "set_blend_mode",
  "lock_nodes",
  "unlock_nodes",
  "find_replace_text",
  "batch_rename_nodes",
  "navigate_to_page",
  "rename_page",
  "delete_page",
] as const;

const READ = new Set<string>(FORGE_READ_TYPES);
const EDIT = new Set<string>(FORGE_EDIT_TYPES);

export const isForgeRequestType = (type: string): boolean => READ.has(type) || EDIT.has(type);
export const isForgeEditType = (type: string): boolean => EDIT.has(type);

// ---------------------------------------------------------------------------
// helpers

const str = (p: Params, key: string): string | undefined =>
  typeof p[key] === "string" ? (p[key] as string) : undefined;
const num = (p: Params, key: string): number | undefined =>
  typeof p[key] === "number" && Number.isFinite(p[key]) ? (p[key] as number) : undefined;
const bool = (p: Params, key: string): boolean | undefined =>
  typeof p[key] === "boolean" ? (p[key] as boolean) : undefined;
const reqStr = (p: Params, key: string, tool: string): string => {
  const v = str(p, key);
  if (!v) throw new Error(`${key} is required for ${tool}`);
  return v;
};

function ids(nodeIds: string[] | undefined, tool: string): string[] {
  if (!nodeIds || nodeIds.length === 0) throw new Error(`nodeIds is required for ${tool}`);
  return nodeIds;
}

async function sceneNode(id: string): Promise<SceneNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw new Error(`Node not found: ${id}`);
  if (node.type === "DOCUMENT" || node.type === "PAGE") {
    throw new Error(`Expected a scene node, got ${node.type}: ${id}`);
  }
  return node as SceneNode;
}

async function scopeNode(id: string | undefined): Promise<BaseNode & ChildrenMixin> {
  if (!id) return figma.currentPage;
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw new Error(`Node not found: ${id}`);
  if (!("children" in node)) throw new Error(`Node has no children: ${id}`);
  return node as BaseNode & ChildrenMixin;
}

async function pageByIdOrName(p: Params, tool: string): Promise<PageNode> {
  const pageId = str(p, "pageId");
  const pageName = str(p, "pageName");
  if (pageId) {
    const node = await figma.getNodeByIdAsync(pageId);
    if (!node || node.type !== "PAGE") throw new Error(`Page not found: ${pageId}`);
    return node;
  }
  if (pageName) {
    const page = figma.root.children.find((pg) => pg.name === pageName);
    if (!page) throw new Error(`Page not found: ${pageName}`);
    return page;
  }
  throw new Error(`pageId or pageName is required for ${tool}`);
}

export function parseHex(hex: string): RGBA {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex color: ${hex}`);
  let h = m[1];
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

export function toHex(c: RGB | RGBA): string {
  const b = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  const a = "a" in c && c.a < 1 ? b(c.a) : "";
  return `#${b(c.r)}${b(c.g)}${b(c.b)}${a}`;
}

function solid(hex: string, opacity?: number): SolidPaint {
  const { r, g, b, a } = parseHex(hex);
  return { type: "SOLID", color: { r, g, b }, opacity: opacity ?? a };
}

function describe(node: BaseNode) {
  return { id: node.id, name: node.name, type: node.type };
}

function walk(root: BaseNode, visit: (n: SceneNode) => boolean | void, limit = Infinity): void {
  let count = 0;
  const stack: BaseNode[] =
    "children" in root ? [...(root as ChildrenMixin).children].reverse() : [];
  while (stack.length > 0 && count < limit) {
    const node = stack.pop() as SceneNode;
    if (visit(node) === true) count++;
    if ("children" in node) {
      const kids = (node as ChildrenMixin).children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
}

async function loadTextFonts(node: TextNode): Promise<void> {
  if (node.characters.length === 0) {
    if (node.fontName !== figma.mixed) await figma.loadFontAsync(node.fontName);
    return;
  }
  const fonts = node.getRangeAllFontNames(0, node.characters.length);
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
}

function parseVariableValue(type: VariableResolvedDataType, raw: unknown): VariableValue {
  switch (type) {
    case "COLOR":
      if (typeof raw !== "string") throw new Error("COLOR value must be a hex string");
      return parseHex(raw);
    case "FLOAT": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`FLOAT value must be a number, got ${String(raw)}`);
      return n;
    }
    case "BOOLEAN":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      throw new Error("BOOLEAN value must be true or false");
    case "STRING":
      return String(raw);
    default:
      throw new Error(`Unsupported variable type: ${String(type)}`);
  }
}

function serializeVariableValue(v: VariableValue): unknown {
  if (typeof v === "object" && v !== null) {
    if ("type" in v && v.type === "VARIABLE_ALIAS") return { alias: v.id };
    if ("r" in v) return toHex(v as RGBA);
  }
  return v;
}

async function getVariable(id: string): Promise<Variable> {
  const v = await figma.variables.getVariableByIdAsync(id);
  if (!v) throw new Error(`Variable not found: ${id}`);
  return v;
}

async function getCollection(id: string): Promise<VariableCollection> {
  const c = await figma.variables.getVariableCollectionByIdAsync(id);
  if (!c) throw new Error(`Variable collection not found: ${id}`);
  return c;
}

async function getStyle(id: string): Promise<BaseStyle> {
  const s = await figma.getStyleByIdAsync(id);
  if (!s) throw new Error(`Style not found: ${id}`);
  return s;
}

const cssName = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ---------------------------------------------------------------------------
// handlers

type Handler = (nodeIds: string[] | undefined, p: Params) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  // --- components --------------------------------------------------------
  async create_component(nodeIds, p) {
    const id = str(p, "nodeId") ?? nodeIds?.[0];
    if (!id) throw new Error("nodeId is required for create_component");
    const node = await sceneNode(id);
    const component = figma.createComponentFromNode(node);
    const name = str(p, "name");
    if (name) component.name = name;
    return { ...describe(component), key: component.key };
  },

  async create_instance(_nodeIds, p) {
    const target = await figma.getNodeByIdAsync(reqStr(p, "componentId", "create_instance"));
    if (!target) throw new Error("Component not found");
    let component: ComponentNode;
    if (target.type === "COMPONENT") component = target;
    else if (target.type === "COMPONENT_SET") component = target.defaultVariant;
    else throw new Error(`componentId must be a COMPONENT or COMPONENT_SET, got ${target.type}`);
    const instance = component.createInstance();
    const parentId = str(p, "parentId");
    if (parentId) {
      const parent = await figma.getNodeByIdAsync(parentId);
      if (!parent || !("appendChild" in parent)) throw new Error(`Invalid parent: ${parentId}`);
      (parent as BaseNode & ChildrenMixin).appendChild(instance);
    }
    const x = num(p, "x");
    const y = num(p, "y");
    if (x !== undefined) instance.x = x;
    if (y !== undefined) instance.y = y;
    const variantProperties = p.variantProperties;
    if (variantProperties && typeof variantProperties === "object") {
      instance.setProperties(variantProperties as Record<string, string | boolean>);
    }
    const name = str(p, "name");
    if (name) instance.name = name;
    return { ...describe(instance), mainComponentId: component.id };
  },

  async combine_as_variants(nodeIds, p) {
    const nodes = await Promise.all(ids(nodeIds, "combine_as_variants").map(sceneNode));
    const components = nodes.map((n) => {
      if (n.type !== "COMPONENT") throw new Error(`Only COMPONENT nodes can be combined: ${n.id}`);
      return n;
    });
    const parent = components[0].parent;
    if (!parent || !("appendChild" in parent)) throw new Error("Components need a parent");
    const set = figma.combineAsVariants(components, parent as BaseNode & ChildrenMixin);
    const name = str(p, "name");
    if (name) set.name = name;
    return { ...describe(set), variants: set.children.map(describe) };
  },

  async get_local_components(_nodeIds, p) {
    await figma.loadAllPagesAsync();
    const types: Array<"COMPONENT" | "COMPONENT_SET"> = ["COMPONENT", "COMPONENT_SET"];
    const found = figma.root.findAllWithCriteria({ types });
    const includeVariants = bool(p, "includeVariants") ?? false;
    return found
      .filter(
        (n) => includeVariants || n.type === "COMPONENT_SET" || n.parent?.type !== "COMPONENT_SET"
      )
      .map((n) => {
        let page: BaseNode | null = n.parent;
        while (page && page.type !== "PAGE") page = page.parent;
        return {
          ...describe(n),
          key: n.key,
          description: n.description,
          page: page?.name ?? null,
          variantCount: n.type === "COMPONENT_SET" ? n.children.length : undefined,
        };
      });
  },

  async swap_component(nodeIds, p) {
    const node = await sceneNode(str(p, "nodeId") ?? ids(nodeIds, "swap_component")[0]);
    if (node.type !== "INSTANCE") throw new Error(`nodeId must be an INSTANCE, got ${node.type}`);
    const target = await figma.getNodeByIdAsync(reqStr(p, "componentId", "swap_component"));
    if (!target || target.type !== "COMPONENT") throw new Error("componentId must be a COMPONENT");
    node.swapComponent(target);
    return { ...describe(node), mainComponentId: target.id };
  },

  async detach_instance(nodeIds) {
    const out = [];
    for (const id of ids(nodeIds, "detach_instance")) {
      const node = await sceneNode(id);
      if (node.type !== "INSTANCE") throw new Error(`Not an INSTANCE: ${id}`);
      out.push(describe(node.detachInstance()));
    }
    return out;
  },

  // --- variables ---------------------------------------------------------
  async create_variable_collection(_nodeIds, p) {
    const collection = figma.variables.createVariableCollection(
      reqStr(p, "name", "create_variable_collection")
    );
    const initialModeName = str(p, "initialModeName");
    if (initialModeName) collection.renameMode(collection.modes[0].modeId, initialModeName);
    return { id: collection.id, name: collection.name, modes: collection.modes };
  },

  async add_variable_mode(_nodeIds, p) {
    const collection = await getCollection(reqStr(p, "collectionId", "add_variable_mode"));
    const modeId = collection.addMode(reqStr(p, "modeName", "add_variable_mode"));
    return { collectionId: collection.id, modeId, modes: collection.modes };
  },

  async create_variable(_nodeIds, p) {
    const collection = await getCollection(reqStr(p, "collectionId", "create_variable"));
    const type = reqStr(p, "type", "create_variable").toUpperCase() as VariableResolvedDataType;
    if (!["COLOR", "FLOAT", "STRING", "BOOLEAN"].includes(type)) {
      throw new Error("type must be COLOR, FLOAT, STRING, or BOOLEAN");
    }
    const variable = figma.variables.createVariable(
      reqStr(p, "name", "create_variable"),
      collection,
      type
    );
    if (p.value !== undefined) {
      variable.setValueForMode(collection.defaultModeId, parseVariableValue(type, p.value));
    }
    const description = str(p, "description");
    if (description) variable.description = description;
    return { id: variable.id, name: variable.name, type, collectionId: collection.id };
  },

  async set_variable_value(_nodeIds, p) {
    const variable = await getVariable(reqStr(p, "variableId", "set_variable_value"));
    const modeId = reqStr(p, "modeId", "set_variable_value");
    const aliasOf = str(p, "aliasOf");
    if (aliasOf) {
      variable.setValueForMode(
        modeId,
        figma.variables.createVariableAlias(await getVariable(aliasOf))
      );
    } else {
      if (p.value === undefined)
        throw new Error("value or aliasOf is required for set_variable_value");
      variable.setValueForMode(modeId, parseVariableValue(variable.resolvedType, p.value));
    }
    return {
      id: variable.id,
      modeId,
      value: serializeVariableValue(variable.valuesByMode[modeId]),
    };
  },

  async bind_variable_to_node(nodeIds, p) {
    const node = await sceneNode(str(p, "nodeId") ?? ids(nodeIds, "bind_variable_to_node")[0]);
    const variable = await getVariable(reqStr(p, "variableId", "bind_variable_to_node"));
    const field = reqStr(p, "field", "bind_variable_to_node");
    if (field === "fillColor" || field === "strokeColor") {
      const key = field === "fillColor" ? "fills" : "strokes";
      if (!(key in node)) throw new Error(`Node has no ${key}: ${node.id}`);
      const current = (node as GeometryMixin)[key];
      const paints = current === figma.mixed ? [] : [...(current as readonly Paint[])];
      const index = paints.findIndex((pt) => pt.type === "SOLID");
      const base: SolidPaint =
        index >= 0 ? (paints[index] as SolidPaint) : { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
      const bound = figma.variables.setBoundVariableForPaint(base, "color", variable);
      if (index >= 0) paints[index] = bound;
      else paints.unshift(bound);
      (node as GeometryMixin)[key] = paints;
      return { nodeId: node.id, field, variableId: variable.id };
    }
    const textFields = [
      "fontFamily",
      "fontSize",
      "fontStyle",
      "fontWeight",
      "letterSpacing",
      "lineHeight",
      "paragraphSpacing",
      "paragraphIndent",
    ];
    if (textFields.includes(field)) {
      if (node.type !== "TEXT") throw new Error(`${field} can only be bound on TEXT nodes`);
      await loadTextFonts(node);
      node.setRangeBoundVariable(
        0,
        node.characters.length,
        field as VariableBindableTextField,
        variable
      );
      return { nodeId: node.id, field, variableId: variable.id };
    }
    if (!("setBoundVariable" in node))
      throw new Error(`Node cannot bind variables: ${(node as BaseNode).id}`);
    if (field === "characters" && node.type === "TEXT") await loadTextFonts(node);
    (
      node as SceneNode & {
        setBoundVariable: (f: VariableBindableNodeField, v: Variable | null) => void;
      }
    ).setBoundVariable(field as VariableBindableNodeField, variable);
    return { nodeId: node.id, field, variableId: variable.id };
  },

  async delete_variable(_nodeIds, p) {
    const variableId = str(p, "variableId");
    const collectionId = str(p, "collectionId");
    if (!!variableId === !!collectionId)
      throw new Error("Provide exactly one of variableId or collectionId");
    if (variableId) {
      (await getVariable(variableId)).remove();
      return { deleted: variableId };
    }
    (await getCollection(collectionId!)).remove();
    return { deleted: collectionId };
  },

  async export_tokens(_nodeIds, p) {
    const format = (str(p, "format") ?? "json").toLowerCase();
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    const byId = new Map(variables.map((v) => [v.id, v]));
    const paintStyles = await figma.getLocalPaintStylesAsync();

    const json: Record<string, unknown> = { collections: {}, paintStyles: {} };
    const css: string[] = [];
    const rootLines: string[] = [];

    for (const c of collections) {
      const modes: Record<string, Record<string, unknown>> = {};
      for (const mode of c.modes) {
        const values: Record<string, unknown> = {};
        const lines: string[] = [];
        for (const vid of c.variableIds) {
          const v = byId.get(vid);
          if (!v) continue;
          const raw = v.valuesByMode[mode.modeId];
          const value = serializeVariableValue(raw);
          values[v.name] = value;
          const varName = `--${cssName(c.name)}-${cssName(v.name)}`;
          let cssValue: string;
          if (typeof value === "object" && value && "alias" in value) {
            const target = byId.get((value as { alias: string }).alias);
            cssValue = target ? `var(--${cssName(c.name)}-${cssName(target.name)})` : "initial";
          } else if (v.resolvedType === "FLOAT") cssValue = `${value}px`;
          else if (v.resolvedType === "STRING") cssValue = JSON.stringify(value);
          else cssValue = String(value);
          lines.push(`  ${varName}: ${cssValue};`);
        }
        modes[mode.name] = values;
        if (mode.modeId === c.defaultModeId) rootLines.push(...lines);
        else
          css.push(`[data-${cssName(c.name)}="${cssName(mode.name)}"] {\n${lines.join("\n")}\n}`);
      }
      (json.collections as Record<string, unknown>)[c.name] = { id: c.id, modes };
    }
    for (const s of paintStyles) {
      const first = s.paints[0];
      if (first && first.type === "SOLID") {
        const hex = toHex({ ...first.color, a: first.opacity ?? 1 });
        (json.paintStyles as Record<string, unknown>)[s.name] = hex;
        rootLines.push(`  --style-${cssName(s.name)}: ${hex};`);
      }
    }
    if (format === "css") {
      return { format: "css", css: [`:root {\n${rootLines.join("\n")}\n}`, ...css].join("\n\n") };
    }
    return { format: "json", tokens: json };
  },

  // --- styles ------------------------------------------------------------
  async create_paint_style(_nodeIds, p) {
    const style = figma.createPaintStyle();
    style.name = reqStr(p, "name", "create_paint_style");
    style.paints = [solid(reqStr(p, "color", "create_paint_style"), num(p, "opacity"))];
    const description = str(p, "description");
    if (description) style.description = description;
    return { id: style.id, name: style.name, type: style.type };
  },

  async create_text_style(_nodeIds, p) {
    const fontName = {
      family: str(p, "fontFamily") ?? "Inter",
      style: str(p, "fontStyle") ?? "Regular",
    };
    await figma.loadFontAsync(fontName);
    const style = figma.createTextStyle();
    style.name = reqStr(p, "name", "create_text_style");
    style.fontName = fontName;
    style.fontSize = num(p, "fontSize") ?? 16;
    const lh = num(p, "lineHeightValue");
    if (lh !== undefined) {
      style.lineHeight = {
        value: lh,
        unit: str(p, "lineHeightUnit") === "PERCENT" ? "PERCENT" : "PIXELS",
      };
    }
    const ls = num(p, "letterSpacingValue");
    if (ls !== undefined) {
      style.letterSpacing = {
        value: ls,
        unit: str(p, "letterSpacingUnit") === "PERCENT" ? "PERCENT" : "PIXELS",
      };
    }
    const deco = str(p, "textDecoration");
    if (deco === "UNDERLINE" || deco === "STRIKETHROUGH" || deco === "NONE")
      style.textDecoration = deco;
    const textCase = str(p, "textCase");
    if (
      textCase === "UPPER" ||
      textCase === "LOWER" ||
      textCase === "TITLE" ||
      textCase === "ORIGINAL"
    ) {
      style.textCase = textCase;
    }
    const description = str(p, "description");
    if (description) style.description = description;
    return { id: style.id, name: style.name, type: style.type, fontName };
  },

  async create_effect_style(_nodeIds, p) {
    const type = (str(p, "type") ?? "DROP_SHADOW").toUpperCase();
    let effect: Effect;
    if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
      const { r, g, b } = parseHex(str(p, "color") ?? "#000000");
      effect = {
        type,
        color: { r, g, b, a: num(p, "opacity") ?? 0.25 },
        offset: { x: num(p, "offsetX") ?? 0, y: num(p, "offsetY") ?? 4 },
        radius: num(p, "radius") ?? 8,
        spread: num(p, "spread") ?? 0,
        visible: true,
        blendMode: "NORMAL",
      } as DropShadowEffect | InnerShadowEffect;
    } else if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
      effect = { type, radius: num(p, "radius") ?? 4, visible: true } as BlurEffect;
    } else {
      throw new Error("type must be DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, or BACKGROUND_BLUR");
    }
    const style = figma.createEffectStyle();
    style.name = reqStr(p, "name", "create_effect_style");
    style.effects = [effect];
    const description = str(p, "description");
    if (description) style.description = description;
    return { id: style.id, name: style.name, type: style.type };
  },

  async create_grid_style(_nodeIds, p) {
    const pattern = (str(p, "pattern") ?? "GRID").toUpperCase();
    let grid: LayoutGrid;
    if (pattern === "GRID") {
      const { r, g, b } = parseHex(str(p, "color") ?? "#FF0000");
      grid = {
        pattern: "GRID",
        sectionSize: num(p, "sectionSize") ?? 8,
        visible: true,
        color: { r, g, b, a: num(p, "opacity") ?? 0.1 },
      };
    } else if (pattern === "COLUMNS" || pattern === "ROWS") {
      const alignment = (str(p, "alignment") ?? "STRETCH").toUpperCase() as
        "MIN" | "MAX" | "STRETCH" | "CENTER";
      const base = {
        pattern,
        alignment,
        gutterSize: num(p, "gutterSize") ?? 16,
        count: num(p, "count") ?? 12,
        visible: true,
        color: { r: 1, g: 0, b: 0, a: 0.1 },
      };
      grid = (
        alignment === "CENTER"
          ? { ...base, sectionSize: num(p, "sectionSize") ?? 64 }
          : { ...base, offset: num(p, "offset") ?? 0 }
      ) as LayoutGrid;
    } else {
      throw new Error("pattern must be GRID, COLUMNS, or ROWS");
    }
    const style = figma.createGridStyle();
    style.name = reqStr(p, "name", "create_grid_style");
    style.layoutGrids = [grid];
    const description = str(p, "description");
    if (description) style.description = description;
    return { id: style.id, name: style.name, type: style.type };
  },

  async update_paint_style(_nodeIds, p) {
    const style = await getStyle(reqStr(p, "styleId", "update_paint_style"));
    if (style.type !== "PAINT") throw new Error(`Not a paint style: ${style.id}`);
    const paint = style as PaintStyle;
    const name = str(p, "name");
    const color = str(p, "color");
    const description = str(p, "description");
    if (name) paint.name = name;
    if (color) paint.paints = [solid(color, num(p, "opacity"))];
    if (description !== undefined) paint.description = description;
    return { id: paint.id, name: paint.name };
  },

  async delete_style(_nodeIds, p) {
    const style = await getStyle(reqStr(p, "styleId", "delete_style"));
    style.remove();
    return { deleted: style.id };
  },

  async apply_style_to_node(nodeIds, p) {
    const node = await sceneNode(str(p, "nodeId") ?? ids(nodeIds, "apply_style_to_node")[0]);
    const style = await getStyle(reqStr(p, "styleId", "apply_style_to_node"));
    const n = node as SceneNode & Record<string, unknown>;
    const call = async (method: string) => {
      if (typeof n[method] !== "function")
        throw new Error(`${node.type} does not support ${style.type} styles`);
      await (n[method] as (id: string) => Promise<void>).call(node, style.id);
    };
    switch (style.type) {
      case "PAINT":
        await call(str(p, "target") === "stroke" ? "setStrokeStyleIdAsync" : "setFillStyleIdAsync");
        break;
      case "TEXT":
        if (node.type !== "TEXT") throw new Error("Text styles apply to TEXT nodes only");
        await loadTextFonts(node);
        await figma.loadFontAsync((style as TextStyle).fontName);
        await call("setTextStyleIdAsync");
        break;
      case "EFFECT":
        await call("setEffectStyleIdAsync");
        break;
      case "GRID":
        await call("setGridStyleIdAsync");
        break;
    }
    return { nodeId: node.id, styleId: style.id, styleType: style.type };
  },

  // --- reactions ---------------------------------------------------------
  async get_reactions(nodeIds, p) {
    const node = await sceneNode(str(p, "nodeId") ?? ids(nodeIds, "get_reactions")[0]);
    if (!("reactions" in node)) throw new Error(`Node has no reactions: ${node.id}`);
    return { nodeId: node.id, reactions: (node as ReactionMixin).reactions };
  },

  async set_reactions(nodeIds, p) {
    const node = await sceneNode(str(p, "nodeId") ?? ids(nodeIds, "set_reactions")[0]);
    if (!("setReactionsAsync" in node))
      throw new Error(`Node does not support reactions: ${node.id}`);
    const incoming = p.reactions;
    if (!Array.isArray(incoming)) throw new Error("reactions must be an array");
    const target = node as SceneNode & ReactionMixin;
    const next =
      str(p, "mode") === "append"
        ? [...target.reactions, ...(incoming as Reaction[])]
        : (incoming as Reaction[]);
    await target.setReactionsAsync(next);
    return { nodeId: node.id, reactions: target.reactions };
  },

  async remove_reactions(nodeIds, p) {
    const node = await sceneNode(str(p, "nodeId") ?? ids(nodeIds, "remove_reactions")[0]);
    if (!("setReactionsAsync" in node))
      throw new Error(`Node does not support reactions: ${node.id}`);
    const target = node as SceneNode & ReactionMixin;
    const indices = Array.isArray(p.indices) ? new Set(p.indices as number[]) : null;
    const next =
      indices && indices.size > 0 ? target.reactions.filter((_, i) => !indices.has(i)) : [];
    await target.setReactionsAsync(next);
    return { nodeId: node.id, remaining: next.length };
  },

  // --- layout ------------------------------------------------------------
  async set_layout_child(nodeIds, p) {
    const results = [];
    for (const id of ids(nodeIds, "set_layout_child")) {
      const node = (await sceneNode(id)) as SceneNode & Record<string, unknown>;
      const applied: Record<string, unknown> = {};
      const parentIsAuto =
        node.parent &&
        "layoutMode" in node.parent &&
        (node.parent as FrameNode).layoutMode !== "NONE";
      const set = (key: string, value: unknown) => {
        if (!(key in node)) throw new Error(`${node.type} does not support ${key}: ${id}`);
        node[key] = value;
        applied[key] = value;
      };
      const positioning = str(p, "layoutPositioning");
      if (positioning === "AUTO" || positioning === "ABSOLUTE")
        set("layoutPositioning", positioning);
      for (const axis of ["layoutSizingHorizontal", "layoutSizingVertical"] as const) {
        const v = str(p, axis);
        if (v === undefined) continue;
        if (v !== "FIXED" && v !== "HUG" && v !== "FILL")
          throw new Error(`${axis} must be FIXED, HUG, or FILL`);
        if (v === "FILL" && !parentIsAuto)
          throw new Error(`FILL needs an auto-layout parent: ${id}`);
        if (v === "HUG" && !("layoutMode" in node) && node.type !== "TEXT") {
          throw new Error(`HUG applies to auto-layout frames and text: ${id}`);
        }
        set(axis, v);
      }
      const grow = num(p, "layoutGrow");
      if (grow !== undefined) set("layoutGrow", grow);
      const align = str(p, "layoutAlign");
      if (align) set("layoutAlign", align);
      for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
        if (p[key] === null) set(key, null);
        else {
          const v = num(p, key);
          if (v !== undefined) set(key, v);
        }
      }
      results.push({ nodeId: id, applied });
    }
    return results;
  },

  async set_constraints(nodeIds, p) {
    const horizontal = str(p, "horizontal") as ConstraintType | undefined;
    const vertical = str(p, "vertical") as ConstraintType | undefined;
    const out = [];
    for (const id of ids(nodeIds, "set_constraints")) {
      const node = await sceneNode(id);
      if (!("constraints" in node)) throw new Error(`Node does not support constraints: ${id}`);
      const c = (node as ConstraintMixin).constraints;
      (node as ConstraintMixin).constraints = {
        horizontal: horizontal ?? c.horizontal,
        vertical: vertical ?? c.vertical,
      };
      out.push({ nodeId: id, constraints: (node as ConstraintMixin).constraints });
    }
    return out;
  },

  async rotate_nodes(nodeIds, p) {
    const rotation = num(p, "rotation");
    if (rotation === undefined) throw new Error("rotation is required for rotate_nodes");
    const out = [];
    for (const id of ids(nodeIds, "rotate_nodes")) {
      const node = await sceneNode(id);
      if (!("rotation" in node)) throw new Error(`Node cannot rotate: ${id}`);
      (node as LayoutMixin).rotation = rotation;
      out.push({ nodeId: id, rotation });
    }
    return out;
  },

  async reorder_nodes(nodeIds, p) {
    const order = reqStr(p, "order", "reorder_nodes");
    const out = [];
    for (const id of ids(nodeIds, "reorder_nodes")) {
      const node = await sceneNode(id);
      const parent = node.parent as (BaseNode & ChildrenMixin) | null;
      if (!parent) throw new Error(`Node has no parent: ${id}`);
      const index = parent.children.indexOf(node);
      const last = parent.children.length - 1;
      const wanted = num(p, "index");
      const to =
        order === "bringToFront"
          ? last
          : order === "sendToBack"
            ? 0
            : order === "bringForward"
              ? Math.min(last, index + 1)
              : order === "sendBackward"
                ? Math.max(0, index - 1)
                : order === "index" && wanted !== undefined
                  ? Math.max(0, Math.min(last, Math.round(wanted)))
                  : -1;
      if (to < 0)
        throw new Error(
          "order must be bringToFront, sendToBack, bringForward, sendBackward, or index with an index param",
        );
      parent.insertChild(to, node);
      out.push({ nodeId: id, index: parent.children.indexOf(node) });
    }
    return out;
  },

  async set_blend_mode(nodeIds, p) {
    const blendMode = reqStr(p, "blendMode", "set_blend_mode") as BlendMode;
    for (const id of ids(nodeIds, "set_blend_mode")) {
      const node = await sceneNode(id);
      if (!("blendMode" in node)) throw new Error(`Node has no blend mode: ${id}`);
      (node as BlendMixin).blendMode = blendMode;
    }
    return { nodeIds, blendMode };
  },

  async lock_nodes(nodeIds) {
    for (const id of ids(nodeIds, "lock_nodes")) (await sceneNode(id)).locked = true;
    return { locked: nodeIds };
  },

  async unlock_nodes(nodeIds) {
    for (const id of ids(nodeIds, "unlock_nodes")) (await sceneNode(id)).locked = false;
    return { unlocked: nodeIds };
  },

  // --- text and search ---------------------------------------------------
  async find_replace_text(nodeIds, p) {
    const find = reqStr(p, "find", "find_replace_text");
    const replace = typeof p.replace === "string" ? p.replace : "";
    const pattern = bool(p, "useRegex")
      ? new RegExp(find, str(p, "regexFlags") ?? "g")
      : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
    const texts: TextNode[] = [];
    walk(root, (n) => {
      if (n.type === "TEXT") texts.push(n);
    });
    const changed = [];
    for (const t of texts) {
      pattern.lastIndex = 0;
      if (!pattern.test(t.characters)) continue;
      pattern.lastIndex = 0;
      await loadTextFonts(t);
      const before = t.characters;
      t.characters = before.replace(pattern, replace);
      changed.push({ id: t.id, name: t.name, before, after: t.characters });
    }
    return { scanned: texts.length, changed };
  },

  async scan_text_nodes(nodeIds, p) {
    const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
    const out: unknown[] = [];
    walk(
      root,
      (n) => {
        if (n.type !== "TEXT") return;
        out.push({
          id: n.id,
          name: n.name,
          characters: n.characters,
          fontName: n.fontName === figma.mixed ? "mixed" : n.fontName,
          fontSize: n.fontSize === figma.mixed ? "mixed" : n.fontSize,
        });
        return true;
      },
      num(p, "limit") ?? 2000
    );
    return out;
  },

  async search_nodes(nodeIds, p) {
    const query = (str(p, "query") ?? "").toLowerCase();
    const types = Array.isArray(p.types) ? new Set(p.types as string[]) : null;
    const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
    const out: unknown[] = [];
    walk(
      root,
      (n) => {
        if (types && !types.has(n.type)) return;
        if (query && !n.name.toLowerCase().includes(query)) return;
        out.push({ ...describe(n), parentId: n.parent?.id ?? null });
        return true;
      },
      num(p, "limit") ?? 50
    );
    return out;
  },

  async scan_nodes_by_types(nodeIds, p) {
    const types = Array.isArray(p.types) ? new Set(p.types as string[]) : null;
    if (!types || types.size === 0) throw new Error("types is required for scan_nodes_by_types");
    const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
    const out: unknown[] = [];
    walk(
      root,
      (n) => {
        if (!types.has(n.type)) return;
        out.push({
          ...describe(n),
          parentId: n.parent?.id ?? null,
          width: n.width,
          height: n.height,
        });
        return true;
      },
      num(p, "limit") ?? 2000
    );
    return out;
  },

  async batch_rename_nodes(nodeIds, p) {
    const find = str(p, "find");
    const replace = str(p, "replace");
    if (find !== undefined && replace === undefined)
      throw new Error("replace is required when find is provided");
    const pattern =
      find === undefined
        ? null
        : bool(p, "useRegex")
          ? new RegExp(find, str(p, "regexFlags") ?? "g")
          : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const prefix = str(p, "prefix") ?? "";
    const suffix = str(p, "suffix") ?? "";
    const out = [];
    for (const id of ids(nodeIds, "batch_rename_nodes")) {
      const node = await sceneNode(id);
      const before = node.name;
      let name = pattern ? before.replace(pattern, replace!) : before;
      name = `${prefix}${name}${suffix}`;
      node.name = name;
      out.push({ id, before, after: name });
    }
    return out;
  },

  async get_fonts(nodeIds, p) {
    const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
    const counts = new Map<string, { family: string; style: string; count: number }>();
    walk(root, (n) => {
      if (n.type !== "TEXT" || n.characters.length === 0) return;
      for (const f of n.getRangeAllFontNames(0, n.characters.length)) {
        const key = `${f.family}::${f.style}`;
        const entry = counts.get(key) ?? { family: f.family, style: f.style, count: 0 };
        entry.count++;
        counts.set(key, entry);
      }
    });
    return [...counts.values()].sort((a, b) => b.count - a.count);
  },

  // --- pages and view ----------------------------------------------------
  async navigate_to_page(_nodeIds, p) {
    const page = await pageByIdOrName(p, "navigate_to_page");
    await figma.setCurrentPageAsync(page);
    return { id: page.id, name: page.name };
  },

  async rename_page(_nodeIds, p) {
    const page = await pageByIdOrName(p, "rename_page");
    page.name = reqStr(p, "newName", "rename_page");
    return { id: page.id, name: page.name };
  },

  async delete_page(_nodeIds, p) {
    const page = await pageByIdOrName(p, "delete_page");
    if (figma.root.children.length <= 1) throw new Error("Cannot delete the only page");
    if (figma.currentPage.id === page.id) {
      const other = figma.root.children.find((pg) => pg.id !== page.id)!;
      await figma.setCurrentPageAsync(other);
    }
    const info = { id: page.id, name: page.name };
    page.remove();
    return { deleted: info };
  },

  async get_viewport() {
    return {
      center: figma.viewport.center,
      zoom: figma.viewport.zoom,
      bounds: figma.viewport.bounds,
    };
  },

  async get_annotations(nodeIds, p) {
    const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
    const out: unknown[] = [];
    const collect = (n: BaseNode) => {
      const anns = (n as { annotations?: readonly Annotation[] }).annotations;
      if (anns && anns.length > 0) out.push({ ...describe(n), annotations: anns });
    };
    collect(root);
    walk(root, (n) => {
      collect(n);
    });
    return out;
  },
};

export async function handleForgeRequest(
  type: string,
  nodeIds: string[] | undefined,
  params: Params | undefined
): Promise<unknown> {
  if (type === "design_preflight") return qualityPreflight(params ?? {});
  if (type === "audit_design") return qualityAudit(params ?? {});
  if (type === "get_build_checkpoint") return checkpointGet(params ?? {});
  if (type === "commit_build_checkpoint") return checkpointCommit(params ?? {});
  const handler = handlers[type];
  if (!handler) throw new Error(`Unknown forge request type: ${type}`);
  return handler(nodeIds, params ?? {});
}
