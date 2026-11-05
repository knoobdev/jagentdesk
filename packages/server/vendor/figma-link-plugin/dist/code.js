"use strict";
(() => {
  // src/main/serializer.ts
  var isMixed = (value) => typeof value === "symbol";
  var toHex = (color) => {
    const clamp = (value) => Math.min(255, Math.max(0, Math.round(value * 255)));
    const [r, g, b] = [clamp(color.r), clamp(color.g), clamp(color.b)];
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };
  var serializeGradientStops = (stops) => stops.map((stop) => ({
    color: toHex(stop.color),
    opacity: stop.color.a,
    position: stop.position
  }));
  var serializePaints = (paints) => {
    if (isMixed(paints)) return "mixed";
    if (!paints || !Array.isArray(paints)) return [];
    return paints.filter((paint2) => paint2.visible !== false).flatMap((paint2) => {
      switch (paint2.type) {
        case "SOLID":
          return [
            {
              type: "SOLID",
              color: toHex(paint2.color),
              opacity: paint2.opacity
            }
          ];
        case "GRADIENT_LINEAR":
        case "GRADIENT_RADIAL":
        case "GRADIENT_ANGULAR":
        case "GRADIENT_DIAMOND":
          return [
            {
              type: paint2.type,
              gradientStops: serializeGradientStops(paint2.gradientStops),
              gradientTransform: paint2.gradientTransform,
              opacity: paint2.opacity
            }
          ];
        case "IMAGE":
          return [
            {
              type: "IMAGE",
              scaleMode: paint2.scaleMode,
              imageHash: paint2.imageHash,
              imageTransform: paint2.imageTransform,
              opacity: paint2.opacity
            }
          ];
        default:
          return [];
      }
    });
  };
  var serializeEffects = (effects) => effects.filter((effect2) => effect2.visible !== false).flatMap((effect2) => {
    switch (effect2.type) {
      case "DROP_SHADOW":
      case "INNER_SHADOW":
        return [
          {
            type: effect2.type,
            color: toHex(effect2.color),
            opacity: effect2.color.a,
            offset: effect2.offset,
            radius: effect2.radius,
            spread: effect2.spread,
            blendMode: effect2.blendMode
          }
        ];
      case "LAYER_BLUR":
      case "BACKGROUND_BLUR":
        return [{ type: effect2.type, radius: effect2.radius }];
      default:
        return [];
    }
  });
  var serializeLineHeight = (lineHeight) => {
    if (isMixed(lineHeight)) return "mixed";
    if ("value" in lineHeight) {
      return { value: lineHeight.value, unit: lineHeight.unit };
    }
    return { unit: lineHeight.unit };
  };
  var serializeLetterSpacing = (letterSpacing) => {
    if (isMixed(letterSpacing)) return "mixed";
    return { value: letterSpacing.value, unit: letterSpacing.unit };
  };
  var getBounds = (node) => {
    if ("x" in node && "y" in node && "width" in node && "height" in node) {
      return {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height
      };
    }
    return void 0;
  };
  var serializeText = (node, base) => {
    let fontFamily;
    let fontStyle;
    if (typeof node.fontName === "symbol") {
      fontFamily = "mixed";
      fontStyle = "mixed";
    } else if (node.fontName) {
      fontFamily = node.fontName.family;
      fontStyle = node.fontName.style;
    }
    return {
      ...base,
      characters: node.characters,
      styles: {
        ...base.styles,
        fontSize: isMixed(node.fontSize) ? "mixed" : node.fontSize,
        fontFamily,
        fontStyle,
        fontWeight: isMixed(node.fontWeight) ? "mixed" : node.fontWeight,
        textDecoration: isMixed(node.textDecoration) ? "mixed" : node.textDecoration,
        lineHeight: serializeLineHeight(node.lineHeight),
        letterSpacing: serializeLetterSpacing(node.letterSpacing),
        textAlignHorizontal: isMixed(node.textAlignHorizontal) ? "mixed" : node.textAlignHorizontal,
        textAlignVertical: isMixed(node.textAlignVertical) ? "mixed" : node.textAlignVertical,
        textAutoResize: node.textAutoResize
      }
    };
  };
  var serializeStyles = (node) => {
    const styles = {};
    if ("opacity" in node) {
      styles.opacity = node.opacity;
    }
    if ("blendMode" in node) {
      styles.blendMode = node.blendMode;
    }
    if ("visible" in node) {
      styles.visible = node.visible;
    }
    if ("fills" in node) {
      styles.fills = serializePaints(node.fills);
    }
    if ("strokes" in node) {
      styles.strokes = serializePaints(node.strokes);
    }
    if ("strokeWeight" in node) {
      styles.strokeWeight = isMixed(node.strokeWeight) ? "mixed" : node.strokeWeight;
    }
    if ("strokeAlign" in node) {
      styles.strokeAlign = node.strokeAlign;
    }
    if ("dashPattern" in node) {
      const pattern = node.dashPattern;
      if (pattern.length > 0) {
        styles.dashPattern = [...pattern];
      }
    }
    if ("effects" in node) {
      const effects = node.effects;
      if (effects.length > 0) {
        styles.effects = serializeEffects(effects);
      }
    }
    if ("cornerRadius" in node) {
      styles.cornerRadius = isMixed(node.cornerRadius) ? "mixed" : node.cornerRadius;
    }
    if ("topLeftRadius" in node) {
      const tl = node.topLeftRadius;
      const tr = node.topRightRadius;
      const br = node.bottomRightRadius;
      const bl = node.bottomLeftRadius;
      if (tl !== tr || tr !== br || br !== bl) {
        styles.cornerRadii = {
          topLeft: tl,
          topRight: tr,
          bottomRight: br,
          bottomLeft: bl
        };
      }
    }
    if ("cornerSmoothing" in node) {
      const smoothing = node.cornerSmoothing;
      if (smoothing > 0) {
        styles.cornerSmoothing = smoothing;
      }
    }
    if ("layoutMode" in node) {
      const mode = node.layoutMode;
      if (mode !== "NONE") {
        styles.autoLayout = {
          direction: mode,
          gap: node.itemSpacing,
          primaryAxisAlign: node.primaryAxisAlignItems,
          counterAxisAlign: node.counterAxisAlignItems,
          primaryAxisSizing: node.primaryAxisSizingMode,
          counterAxisSizing: node.counterAxisSizingMode,
          wrap: "layoutWrap" in node ? node.layoutWrap : void 0,
          counterAxisSpacing: "counterAxisSpacing" in node ? node.counterAxisSpacing : void 0
        };
      }
    }
    if ("paddingLeft" in node) {
      const top = node.paddingTop;
      const right = node.paddingRight;
      const bottom = node.paddingBottom;
      const left = node.paddingLeft;
      if (top > 0 || right > 0 || bottom > 0 || left > 0) {
        styles.padding = { top, right, bottom, left };
      }
    }
    if ("clipsContent" in node) {
      styles.clipsContent = node.clipsContent;
    }
    if ("rotation" in node) {
      const rotation = node.rotation;
      if (rotation !== 0) {
        styles.rotation = rotation;
      }
    }
    if ("constraints" in node) {
      const c = node.constraints;
      styles.constraints = { horizontal: c.horizontal, vertical: c.vertical };
    }
    return styles;
  };
  var serializeNode = (node) => {
    const base = {
      id: node.id,
      name: node.name,
      type: node.type,
      bounds: getBounds(node),
      styles: serializeStyles(node)
    };
    if (node.type === "TEXT") {
      return serializeText(node, base);
    }
    if ((node.type === "STICKY" || node.type === "SHAPE_WITH_TEXT") && "text" in node) {
      try {
        const textNode = node.text;
        return {
          ...base,
          characters: textNode.characters
        };
      } catch {
      }
    }
    if ("children" in node) {
      return {
        ...base,
        children: node.children.filter((child) => child.visible !== false).map((child) => serializeNode(child))
      };
    }
    return base;
  };

  // src/html-figma/utils.ts
  var hasChildren = (node) => (
    // @ts-expect-error
    node && Array.isArray(node.children)
  );
  async function traverseAsync(layer, cb, parent = null) {
    if (layer) {
      await cb(layer, parent);
      if (hasChildren(layer)) {
        for (let child of layer.children.reverse()) {
          await traverseAsync(child, cb, layer);
        }
      }
    }
  }
  function getRgb(colorString) {
    if (!colorString) {
      return null;
    }
    const [_1, r, g, b, _2, a] = colorString.match(
      /rgba?\(([\d\.]+), ([\d\.]+), ([\d\.]+)(, ([\d\.]+))?\)/
    ) || [];
    const none = a && parseFloat(a) === 0;
    if (r && g && b && !none) {
      return {
        r: parseInt(r) / 255,
        g: parseInt(g) / 255,
        b: parseInt(b) / 255,
        a: a ? parseFloat(a) : 1
      };
    }
    return null;
  }
  function getImageFills(layer) {
    const images = Array.isArray(layer.fills) && layer.fills.filter((item) => item.type === "IMAGE");
    return images;
  }
  var defaultPlaceholderColor = getRgb("rgba(178, 178, 178, 1)");

  // src/html-figma/figma/images.ts
  async function processImages(layer) {
    const images = getImageFills(layer);
    return images && Promise.all(
      images.map(async (image) => {
        if (image && image.intArr) {
          image.imageHash = await figma.createImage(image.intArr).hash;
          delete image.intArr;
        }
      })
    );
  }

  // src/html-figma/figma/getFont.ts
  var fontCache = {};
  var normalizeName = (str2) => str2.toLowerCase().replace(/[^a-z]/gi, "");
  var defaultFont = { family: "Roboto", style: "Regular" };
  var cachedAvailableFonts = null;
  var getAvailableFonts = async () => {
    if (!cachedAvailableFonts) {
      cachedAvailableFonts = await figma.listAvailableFontsAsync();
    }
    return cachedAvailableFonts;
  };
  var styleCandidates = (fontWeight) => {
    if (typeof fontWeight !== "number" || fontWeight < 500) return ["Regular"];
    if (fontWeight >= 900) return ["Black", "ExtraBold", "Bold", "Regular"];
    if (fontWeight >= 800) return ["ExtraBold", "Bold", "Regular"];
    if (fontWeight >= 700) return ["Bold", "SemiBold", "Regular"];
    if (fontWeight >= 600) return ["SemiBold", "Bold", "Medium", "Regular"];
    return ["Medium", "SemiBold", "Regular"];
  };
  async function getMatchingFont(fontStr, fontWeight) {
    const cacheKey = `${fontStr}|${fontWeight ?? ""}`;
    const cached = fontCache[cacheKey];
    if (cached) {
      return cached;
    }
    const availableFonts = await getAvailableFonts();
    const candidates = styleCandidates(fontWeight);
    for (const family of fontStr.split(/\s*,\s*/)) {
      const normalized = normalizeName(family);
      const familyFonts = availableFonts.filter(
        (font) => normalizeName(font.fontName.family) === normalized
      );
      if (!familyFonts.length) {
        continue;
      }
      for (const style of candidates) {
        const match = familyFonts.find((font) => font.fontName.style === style);
        if (!match) {
          continue;
        }
        await figma.loadFontAsync(match.fontName);
        fontCache[cacheKey] = match.fontName;
        return match.fontName;
      }
    }
    await figma.loadFontAsync(defaultFont);
    fontCache[cacheKey] = defaultFont;
    return defaultFont;
  }

  // src/html-figma/figma/helpers.ts
  function assign(a, b) {
    for (const key in b) {
      const value = b[key];
      if (key === "data" && value && typeof value === "object") {
        const currentData = JSON.parse(a.getSharedPluginData("builder", "data") || "{}") || {};
        const newData = value;
        const mergedData = Object.assign({}, currentData, newData);
        a.setSharedPluginData("builder", "data", JSON.stringify(mergedData));
      } else if (typeof value != "undefined" && ["width", "height", "type", "ref", "children", "svg"].indexOf(key) === -1) {
        try {
          a[key] = b[key];
        } catch (err) {
          console.warn(`Assign error for property "${key}"`, a, b, err);
        }
      }
    }
  }

  // src/html-figma/figma/processLayer.ts
  var processDefaultElement = (layer, node) => {
    node.x = layer.x;
    node.y = layer.y;
    node.resize(layer.width || 1, layer.height || 1);
    assign(node, layer);
    return node;
  };
  var createNodeFromLayer = (layer) => {
    if (layer.type === "FRAME" || layer.type === "GROUP") {
      return figma.createFrame();
    }
    if (layer.type === "SVG" && layer.svg) {
      return figma.createNodeFromSvg(layer.svg);
    }
    if (layer.type === "RECTANGLE") {
      return figma.createRectangle();
    }
    if (layer.type === "TEXT") {
      return figma.createText();
    }
    if (layer.type === "COMPONENT") {
      return figma.createComponent();
    }
  };
  var SIMPLE_TYPES = ["FRAME", "GROUP", "SVG", "RECTANGLE", "COMPONENT"];
  var processLayer = async (layer, parent, baseFrame) => {
    const parentFrame = parent?.ref || baseFrame;
    if (typeof layer.x !== "number" || typeof layer.y !== "number") {
      throw Error("Layer coords not defined");
    }
    const node = createNodeFromLayer(layer);
    if (!node) {
      throw Error(`${layer.type} not implemented`);
    }
    if (SIMPLE_TYPES.includes(layer.type)) {
      parentFrame.appendChild(processDefaultElement(layer, node));
    }
    layer.ref = node;
    if (layer.type === "RECTANGLE") {
      if (getImageFills(layer)) {
        await processImages(layer);
      }
    }
    if (layer.type === "TEXT") {
      const text = node;
      if (layer.fontFamily) {
        text.fontName = await getMatchingFont(layer.fontFamily, layer.fontWeight);
        delete layer.fontFamily;
      }
      delete layer.fontWeight;
      assign(text, layer);
      text.resize(layer.width || 1, layer.height || 1);
      text.textAutoResize = "HEIGHT";
      let adjustments = 0;
      if (layer.lineHeight) {
        text.lineHeight = layer.lineHeight;
      }
      while (typeof layer.height === "number" && text.height > layer.height) {
        if (adjustments++ > 5) {
          console.warn("Too many font adjustments", text, layer);
          break;
        }
        try {
          text.resize(text.width + 1, text.height);
        } catch (err) {
          console.warn("Error on resize text:", layer, text, err);
        }
      }
      parentFrame.appendChild(text);
    }
    return node;
  };

  // src/html-figma/figma/index.ts
  async function addLayersToFrame(layers, baseFrame, onLayerProcess) {
    for (const rootLayer of layers) {
      await traverseAsync(rootLayer, async (layer, parent) => {
        try {
          const node = await processLayer(layer, parent, baseFrame);
          onLayerProcess?.({ node, layer, parent });
        } catch (err) {
          console.warn("Error on layer:", layer, err);
        }
      });
    }
  }

  // src/main/prototype.ts
  var DEFAULT_MAX_NODES = 5e3;
  var DEFAULT_MAX_SCREENS = 25;
  var SCREEN_PARENT_TYPES = /* @__PURE__ */ new Set(["DOCUMENT", "PAGE", "SECTION"]);
  var SCREEN_NAVIGATIONS = /* @__PURE__ */ new Set(["NAVIGATE", "SWAP", "OVERLAY"]);
  var OVERLAY_NAVIGATIONS = /* @__PURE__ */ new Set(["SWAP", "OVERLAY"]);
  var toRef = (node) => ({ id: node.id, name: node.name, type: node.type });
  function screenChain(node) {
    const chain = [];
    for (let current = node; current; current = current.parent) {
      if (SCREEN_PARENT_TYPES.has(current.type)) break;
      chain.push(current);
    }
    return chain.reverse();
  }
  var screenOf = (node) => screenChain(node)[0] ?? null;
  function pageOf(node) {
    for (let current = node; current; current = current.parent) {
      if (current.type === "PAGE") return current;
    }
    return null;
  }
  var isScreenNavigation = (action) => action.type === "NODE" && SCREEN_NAVIGATIONS.has(action.navigation);
  function edgeKind(action) {
    switch (action.type) {
      case "NODE":
        return isScreenNavigation(action) ? "screen" : "in-screen";
      case "BACK":
        return "back";
      case "CLOSE":
        return "close";
      case "URL":
        return "url";
      case "SET_VARIABLE":
      case "SET_VARIABLE_MODE":
        return "variable";
      case "UPDATE_MEDIA_RUNTIME":
        return "media";
      default:
        return "unsupported";
    }
  }
  function* flattenActions(actions, path, conditions = []) {
    for (const [i, action] of actions.entries()) {
      const actionPath = `${path}.actions[${i}]`;
      if (action.type !== "CONDITIONAL") {
        yield { action, actionPath, conditions };
        continue;
      }
      for (const [b, block] of action.conditionalBlocks.entries()) {
        yield* flattenActions(block.actions, `${actionPath}.conditionalBlocks[${b}]`, [
          ...conditions,
          block.condition
        ]);
      }
    }
  }
  function memoize(load) {
    const cache = /* @__PURE__ */ new Map();
    return (id) => {
      let result = cache.get(id);
      if (!result) {
        result = load(id);
        cache.set(id, result);
      }
      return result;
    };
  }
  var PrototypeReader = class {
    constructor() {
      this.getNode = memoize((id) => figma.getNodeByIdAsync(id));
      this.getVariable = memoize((id) => figma.variables.getVariableByIdAsync(id));
      this.getCollection = memoize(
        (id) => figma.variables.getVariableCollectionByIdAsync(id)
      );
    }
    async scan(root, { maxNodes = DEFAULT_MAX_NODES, includeEmpty = false } = {}) {
      const connections = [];
      const stack = [root];
      let nodesScanned = 0;
      while (stack.length > 0 && nodesScanned < maxNodes) {
        const node = stack.pop();
        nodesScanned++;
        if ("reactions" in node && (includeEmpty || node.reactions.length > 0)) {
          connections.push(this.describeNode(node));
        }
        if ("children" in node) {
          for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
        }
      }
      return {
        root: toRef(root),
        nodesScanned,
        truncated: stack.length > 0,
        connections: await Promise.all(connections)
      };
    }
    async trace(start, { maxScreens = DEFAULT_MAX_SCREENS, maxNodesPerScreen = DEFAULT_MAX_NODES } = {}) {
      const startScreen = screenOf(start) ?? start;
      const trace = {
        start: toRef(startScreen),
        screens: [],
        edges: [],
        unresolved: [],
        truncated: false,
        pending: []
      };
      const reached = /* @__PURE__ */ new Set([startScreen.id]);
      const queue = [{ screen: startScreen, depth: 0, reachedVia: null }];
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (trace.screens.length >= maxScreens) {
          trace.truncated = true;
          trace.pending = [next, ...queue].map(({ screen: screen2 }) => toRef(screen2));
          break;
        }
        const { screen, depth, reachedVia } = next;
        const fromScreen = toRef(screen);
        trace.screens.push({ ...fromScreen, depth, reachedVia });
        const scan = await this.scan(screen, { maxNodes: maxNodesPerScreen });
        trace.truncated || (trace.truncated = scan.truncated);
        for (const { reactions, screen: _screen, ...source } of scan.connections) {
          for (const [r, { trigger, actions }] of reactions.entries()) {
            for (const { action, actionPath, conditions } of flattenActions(
              actions,
              `reactions[${r}]`
            )) {
              const edge = {
                fromScreen,
                source,
                trigger,
                actionPath,
                conditions,
                action,
                kind: edgeKind(action)
              };
              const edgeIndex = trace.edges.push(edge) - 1;
              if (!isScreenNavigation(action)) continue;
              const { destination } = action;
              const targetId = destination?.status === "resolved" ? (destination.screen ?? destination).id : null;
              const target = targetId ? await this.getNode(targetId) : null;
              if (!target) {
                edge.toScreen = null;
                trace.unresolved.push({ edgeIndex, destinationId: action.destinationId });
                continue;
              }
              edge.toScreen = toRef(target);
              edge.revisit = reached.has(target.id);
              if (edge.revisit) continue;
              reached.add(target.id);
              queue.push({ screen: target, depth: depth + 1, reachedVia: source.id });
            }
          }
        }
      }
      return trace;
    }
    async describeNode(node) {
      const chain = screenChain(node);
      return {
        ...toRef(node),
        instanceSublayer: node.id.startsWith("I"),
        path: chain.map((ancestor) => ancestor.name),
        screen: chain.length > 0 ? toRef(chain[0]) : null,
        reactions: await Promise.all(
          node.reactions.map(async ({ trigger, action, actions }) => ({
            trigger,
            // `action` is the deprecated single-action form of `actions`.
            actions: await this.resolveActions(actions ?? (action ? [action] : []))
          }))
        )
      };
    }
    resolveActions(actions) {
      return Promise.all(actions.map((action) => this.resolveAction(action)));
    }
    async resolveAction(action) {
      switch (action.type) {
        case "NODE":
          return {
            ...action,
            destination: await this.resolveDestination(action.destinationId, action.navigation)
          };
        case "UPDATE_MEDIA_RUNTIME":
          return { ...action, destination: await this.resolveDestination(action.destinationId) };
        case "SET_VARIABLE": {
          const variable = action.variableId ? await this.getVariable(action.variableId) : null;
          return {
            ...action,
            variable: variable && {
              id: variable.id,
              name: variable.name,
              resolvedType: variable.resolvedType
            }
          };
        }
        case "SET_VARIABLE_MODE": {
          const collection = action.variableCollectionId ? await this.getCollection(action.variableCollectionId) : null;
          return {
            ...action,
            collectionName: collection?.name ?? null,
            modeName: collection?.modes.find((m) => m.modeId === action.variableModeId)?.name ?? null
          };
        }
        case "CONDITIONAL":
          return {
            type: "CONDITIONAL",
            conditionalBlocks: await Promise.all(
              action.conditionalBlocks.map(async ({ condition, actions }) => ({
                condition: condition ?? null,
                actions: await this.resolveActions(actions)
              }))
            )
          };
        default:
          return action;
      }
    }
    async resolveDestination(id, navigation) {
      if (!id) return null;
      const node = await this.getNode(id);
      if (!node) return { status: "missing", id };
      const screen = screenOf(node);
      const page = pageOf(node);
      const destination = {
        status: "resolved",
        ...toRef(node),
        screen: screen && toRef(screen),
        page: page && toRef(page)
      };
      if (navigation && OVERLAY_NAVIGATIONS.has(navigation) && "overlayPositionType" in node) {
        destination.overlay = {
          overlayPositionType: node.overlayPositionType,
          overlayBackground: node.overlayBackground,
          overlayBackgroundInteraction: node.overlayBackgroundInteraction
        };
      }
      return destination;
    }
  };
  function describeFile(node) {
    const page = pageOf(node);
    return {
      schemaVersion: 1,
      fileKey: figma.fileKey ?? null,
      fileName: figma.root.name,
      page: page && toRef(page),
      flowStartingPoints: page?.flowStartingPoints ?? []
    };
  }
  async function scanPrototype(root, options) {
    if (root.type === "PAGE") await root.loadAsync();
    return new PrototypeReader().scan(root, options);
  }
  async function getPrototypeConnections(root, options) {
    const scan = await scanPrototype(root, options);
    return { ...describeFile(root), ...scan };
  }
  async function tracePrototypeFlow(start, options) {
    const trace = await new PrototypeReader().trace(start, options);
    return { ...describeFile(start), ...trace };
  }

  // src/main/forgeQuality.ts
  var CHECKPOINT_PREFIX = "forge.checkpoint.";
  var keyOf = (value) => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
      throw new Error("checkpoint key must be 1\u201380 letters, numbers, _ or -");
    return CHECKPOINT_PREFIX + value;
  };
  var finiteLimit = (v, fallback, max) => {
    if (v === void 0) return fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max)
      throw new Error(`limit must be an integer between 1 and ${max}`);
    return v;
  };
  var resolveNode = async (id) => {
    if (typeof id !== "string") throw new Error("node ID must be a string");
    const n = await figma.getNodeByIdAsync(id);
    if (!n) throw new Error(`Node not found: ${id}`);
    return n;
  };
  async function qualityPreflight(p) {
    const requested = p.fonts ?? [];
    if (!Array.isArray(requested) || requested.length > 40)
      throw new Error("fonts must contain at most 40 faces");
    const available = await figma.listAvailableFontsAsync();
    const fonts = [];
    for (const face of requested) {
      if (typeof face?.family !== "string" || typeof face?.style !== "string")
        throw new Error("Each font needs family and style");
      const installed = available.some(
        (f) => f.fontName.family === face.family && f.fontName.style === face.style
      );
      let loadable = false;
      let error;
      if (installed)
        try {
          await figma.loadFontAsync(face);
          loadable = true;
        } catch (e) {
          error = String(e);
        }
      fonts.push({ ...face, installed, loadable, ...error ? { error } : {} });
    }
    const roots = [];
    const ids2 = p.roots ?? [];
    if (!Array.isArray(ids2) || ids2.length > 50) throw new Error("At most 50 node IDs");
    for (const id of ids2) {
      const n = await resolveNode(id);
      roots.push({ id: n.id, name: n.name, type: n.type });
    }
    return {
      file: { name: figma.root.name, pageId: figma.currentPage.id, pageName: figma.currentPage.name },
      roots,
      fonts,
      ready: fonts.every((f) => f.loadable),
      note: "Font availability/loading does not prove glyph rendering. Audit actual text nodes after building; never silently substitute a different font."
    };
  }
  async function qualityAudit(p) {
    const maxNodes = finiteLimit(p.maxNodes, 2e3, 2e4);
    const deadline = Date.now() + finiteLimit(p.maxDurationMs, 5e3, 3e4);
    const timeout = new Error("Audit time budget reached");
    let timedOut = false;
    const bounded = async (work) => {
      let timer;
      try {
        return await Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(timeout), Math.max(0, deadline - Date.now()));
          })
        ]);
      } finally {
        if (timer !== void 0) clearTimeout(timer);
      }
    };
    const maxIssues = finiteLimit(p.maxIssues, 100, 1e3);
    const root = p.rootId ? await resolveNode(p.rootId) : figma.currentPage;
    if (root.type === "DOCUMENT")
      throw new Error("Audit a page or scene subtree, not the whole document");
    const radii = p.allowedRadii;
    const fontSizes = p.allowedFontSizes;
    for (const scale of [radii, fontSizes])
      if (scale !== void 0 && (!Array.isArray(scale) || scale.length > 100 || scale.some((v) => typeof v !== "number" || !Number.isFinite(v))))
        throw new Error("Token scales must be finite numeric arrays of at most 100 values");
    const issues = [];
    let issueCount = 0;
    let visited = 0;
    const counts = {};
    const add = (n, code, detail) => {
      issueCount++;
      counts[code] = (counts[code] ?? 0) + 1;
      if (issues.length < maxIssues) issues.push({ nodeId: n.id, name: n.name, code, detail });
    };
    const stack = [root];
    try {
      while (stack.length && visited < maxNodes) {
        if (Date.now() >= deadline) throw timeout;
        const n = stack.pop();
        visited++;
        if ("visible" in n && !n.visible) continue;
        if ("children" in n) stack.push(...n.children);
        if (n.type === "TEXT") {
          if (n.hasMissingFont)
            add(n, "missing_font", "Resolve/install the exact font face; do not silently replace it");
          if (n.characters.trim() && (n.width <= 0 || n.height <= 0))
            add(n, "zero_size_text", `${n.width} \xD7 ${n.height}`);
          if (n.characters.trim() && n.textStyleId === "")
            add(n, "unstyled_text", "No text style bound (may be intentional)");
          if (fontSizes && typeof n.fontSize === "number" && !fontSizes.includes(n.fontSize))
            add(n, "off_scale_font_size", String(n.fontSize));
        }
        if (radii && "cornerRadius" in n && typeof n.cornerRadius === "number" && !radii.includes(n.cornerRadius))
          add(n, "off_scale_radius", String(n.cornerRadius));
        if (n.type === "INSTANCE") {
          try {
            if (!await bounded(n.getMainComponentAsync()))
              add(n, "missing_main", "Instance main component cannot be resolved");
          } catch (e) {
            if (e === timeout) throw e;
            add(n, "main_lookup_failed", String(e));
          }
        }
        if ("reactions" in n) {
          for (const r of n.reactions) {
            for (const a of r.actions ?? []) {
              if (a.type === "NODE" && a.destinationId && !await bounded(figma.getNodeByIdAsync(a.destinationId)))
                add(n, "dead_reaction", a.destinationId);
            }
          }
        }
        if ("x" in n && "width" in n && n.parent && "clipsContent" in n.parent && n.parent.clipsContent && "width" in n.parent) {
          if ((!("rotation" in n) || n.rotation === 0) && (n.x < -0.5 || n.y < -0.5 || n.x + n.width > n.parent.width + 0.5 || n.y + n.height > n.parent.height + 0.5))
            add(
              n,
              "clipped_bounds",
              "Visible node extends outside clipping parent; may be intentional scrolling/decorative content"
            );
        }
      }
    } catch (e) {
      if (e !== timeout) throw e;
      timedOut = true;
    }
    return {
      rootId: root.id,
      visited,
      complete: stack.length === 0 && !timedOut,
      timedOut,
      issueCount,
      counts,
      issues,
      issuesTruncated: issueCount > issues.length,
      note: "Structural findings, not visual approval. Hidden branches skipped. Mixed text runs, glyph overflow inside text boxes, arbitrary transforms and URL reaction destinations require separate review. Export a fresh screenshot after mutations."
    };
  }
  async function checkpointGet(p) {
    const raw = figma.root.getPluginData(keyOf(p.key));
    if (!raw) return { key: p.key, revision: 0, receipt: null };
    const receipt = JSON.parse(raw);
    const nodes = [];
    for (const id of receipt.nodeIds) {
      const n = await figma.getNodeByIdAsync(id);
      nodes.push({ id, exists: Boolean(n), ...n ? { name: n.name, type: n.type } : {} });
    }
    return { key: p.key, revision: receipt.revision, receipt, nodes };
  }
  var checkpointQueues = /* @__PURE__ */ new Map();
  async function checkpointCommit(p) {
    const key = keyOf(p.key);
    const previous = checkpointQueues.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {
    }).then(async () => {
      if (typeof p.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.operationId))
        throw new Error("operationId is required (1\u2013100 letters, numbers, _ or -)");
      if (typeof p.expectedRevision !== "number" || !Number.isInteger(p.expectedRevision) || p.expectedRevision < 0)
        throw new Error("expectedRevision must be a non-negative integer");
      if (!Array.isArray(p.roots) || p.roots.length > 500 || p.roots.some((id) => typeof id !== "string"))
        throw new Error("roots must be an array of at most 500 IDs");
      if (p.note !== void 0 && (typeof p.note !== "string" || p.note.length > 4e3))
        throw new Error("note must be at most 4000 characters");
      const body = { nodeIds: [...new Set(p.roots)].sort(), note: p.note ?? "" };
      const raw = figma.root.getPluginData(key);
      const current = raw ? JSON.parse(raw) : null;
      if (current?.operationId === p.operationId) {
        if (JSON.stringify(body) !== JSON.stringify({ nodeIds: current.nodeIds, note: current.note }))
          throw new Error("operationId already used with different content");
        return { ...current, replayed: true };
      }
      if ((current?.revision ?? 0) !== p.expectedRevision)
        throw new Error(
          `Revision conflict: expected ${p.expectedRevision}, current ${current?.revision ?? 0}; read checkpoint and reconcile before retrying`
        );
      for (const id of body.nodeIds) await resolveNode(id);
      const receipt = {
        key: p.key,
        revision: p.expectedRevision + 1,
        operationId: p.operationId,
        ...body,
        savedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (JSON.stringify(receipt).length > 5e4) throw new Error("Checkpoint too large");
      figma.root.setPluginData(key, JSON.stringify(receipt));
      return { ...receipt, replayed: false };
    });
    checkpointQueues.set(key, work);
    try {
      return await work;
    } finally {
      if (checkpointQueues.get(key) === work) checkpointQueues.delete(key);
    }
  }

  // src/main/forge.ts
  var FORGE_READ_TYPES = [
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
    "get_annotations"
  ];
  var FORGE_EDIT_TYPES = [
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
    "delete_page"
  ];
  var READ = new Set(FORGE_READ_TYPES);
  var EDIT = new Set(FORGE_EDIT_TYPES);
  var isForgeRequestType = (type) => READ.has(type) || EDIT.has(type);
  var isForgeEditType = (type) => EDIT.has(type);
  var str = (p, key) => typeof p[key] === "string" ? p[key] : void 0;
  var num = (p, key) => typeof p[key] === "number" && Number.isFinite(p[key]) ? p[key] : void 0;
  var bool = (p, key) => typeof p[key] === "boolean" ? p[key] : void 0;
  var reqStr = (p, key, tool) => {
    const v = str(p, key);
    if (!v) throw new Error(`${key} is required for ${tool}`);
    return v;
  };
  function ids(nodeIds, tool) {
    if (!nodeIds || nodeIds.length === 0) throw new Error(`nodeIds is required for ${tool}`);
    return nodeIds;
  }
  async function sceneNode(id) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    if (node.type === "DOCUMENT" || node.type === "PAGE") {
      throw new Error(`Expected a scene node, got ${node.type}: ${id}`);
    }
    return node;
  }
  async function scopeNode(id) {
    if (!id) return figma.currentPage;
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    if (!("children" in node)) throw new Error(`Node has no children: ${id}`);
    return node;
  }
  async function pageByIdOrName(p, tool) {
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
  function parseHex(hex) {
    const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
    if (!m) throw new Error(`Invalid hex color: ${hex}`);
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  function toHex2(c) {
    const b = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
    const a = "a" in c && c.a < 1 ? b(c.a) : "";
    return `#${b(c.r)}${b(c.g)}${b(c.b)}${a}`;
  }
  function solid(hex, opacity) {
    const { r, g, b, a } = parseHex(hex);
    return { type: "SOLID", color: { r, g, b }, opacity: opacity ?? a };
  }
  function describe(node) {
    return { id: node.id, name: node.name, type: node.type };
  }
  function walk(root, visit, limit = Infinity) {
    let count = 0;
    const stack = "children" in root ? [...root.children].reverse() : [];
    while (stack.length > 0 && count < limit) {
      const node = stack.pop();
      if (visit(node) === true) count++;
      if ("children" in node) {
        const kids = node.children;
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
    }
  }
  async function loadTextFonts(node) {
    if (node.characters.length === 0) {
      if (node.fontName !== figma.mixed) await figma.loadFontAsync(node.fontName);
      return;
    }
    const fonts = node.getRangeAllFontNames(0, node.characters.length);
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
  }
  function parseVariableValue(type, raw) {
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
  function serializeVariableValue(v) {
    if (typeof v === "object" && v !== null) {
      if ("type" in v && v.type === "VARIABLE_ALIAS") return { alias: v.id };
      if ("r" in v) return toHex2(v);
    }
    return v;
  }
  async function getVariable(id) {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (!v) throw new Error(`Variable not found: ${id}`);
    return v;
  }
  async function getCollection(id) {
    const c = await figma.variables.getVariableCollectionByIdAsync(id);
    if (!c) throw new Error(`Variable collection not found: ${id}`);
    return c;
  }
  async function getStyle(id) {
    const s = await figma.getStyleByIdAsync(id);
    if (!s) throw new Error(`Style not found: ${id}`);
    return s;
  }
  var cssName = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  var handlers = {
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
      let component;
      if (target.type === "COMPONENT") component = target;
      else if (target.type === "COMPONENT_SET") component = target.defaultVariant;
      else throw new Error(`componentId must be a COMPONENT or COMPONENT_SET, got ${target.type}`);
      const instance = component.createInstance();
      const parentId = str(p, "parentId");
      if (parentId) {
        const parent = await figma.getNodeByIdAsync(parentId);
        if (!parent || !("appendChild" in parent)) throw new Error(`Invalid parent: ${parentId}`);
        parent.appendChild(instance);
      }
      const x = num(p, "x");
      const y = num(p, "y");
      if (x !== void 0) instance.x = x;
      if (y !== void 0) instance.y = y;
      const variantProperties = p.variantProperties;
      if (variantProperties && typeof variantProperties === "object") {
        instance.setProperties(variantProperties);
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
      const set = figma.combineAsVariants(components, parent);
      const name = str(p, "name");
      if (name) set.name = name;
      return { ...describe(set), variants: set.children.map(describe) };
    },
    async get_local_components(_nodeIds, p) {
      await figma.loadAllPagesAsync();
      const types = ["COMPONENT", "COMPONENT_SET"];
      const found = figma.root.findAllWithCriteria({ types });
      const includeVariants = bool(p, "includeVariants") ?? false;
      return found.filter(
        (n) => includeVariants || n.type === "COMPONENT_SET" || n.parent?.type !== "COMPONENT_SET"
      ).map((n) => {
        let page = n.parent;
        while (page && page.type !== "PAGE") page = page.parent;
        return {
          ...describe(n),
          key: n.key,
          description: n.description,
          page: page?.name ?? null,
          variantCount: n.type === "COMPONENT_SET" ? n.children.length : void 0
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
      const type = reqStr(p, "type", "create_variable").toUpperCase();
      if (!["COLOR", "FLOAT", "STRING", "BOOLEAN"].includes(type)) {
        throw new Error("type must be COLOR, FLOAT, STRING, or BOOLEAN");
      }
      const variable = figma.variables.createVariable(
        reqStr(p, "name", "create_variable"),
        collection,
        type
      );
      if (p.value !== void 0) {
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
        if (p.value === void 0)
          throw new Error("value or aliasOf is required for set_variable_value");
        variable.setValueForMode(modeId, parseVariableValue(variable.resolvedType, p.value));
      }
      return {
        id: variable.id,
        modeId,
        value: serializeVariableValue(variable.valuesByMode[modeId])
      };
    },
    async bind_variable_to_node(nodeIds, p) {
      const node = await sceneNode(str(p, "nodeId") ?? ids(nodeIds, "bind_variable_to_node")[0]);
      const variable = await getVariable(reqStr(p, "variableId", "bind_variable_to_node"));
      const field = reqStr(p, "field", "bind_variable_to_node");
      if (field === "fillColor" || field === "strokeColor") {
        const key = field === "fillColor" ? "fills" : "strokes";
        if (!(key in node)) throw new Error(`Node has no ${key}: ${node.id}`);
        const current = node[key];
        const paints = current === figma.mixed ? [] : [...current];
        const index = paints.findIndex((pt) => pt.type === "SOLID");
        const base = index >= 0 ? paints[index] : { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
        const bound = figma.variables.setBoundVariableForPaint(base, "color", variable);
        if (index >= 0) paints[index] = bound;
        else paints.unshift(bound);
        node[key] = paints;
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
        "paragraphIndent"
      ];
      if (textFields.includes(field)) {
        if (node.type !== "TEXT") throw new Error(`${field} can only be bound on TEXT nodes`);
        await loadTextFonts(node);
        node.setRangeBoundVariable(
          0,
          node.characters.length,
          field,
          variable
        );
        return { nodeId: node.id, field, variableId: variable.id };
      }
      if (!("setBoundVariable" in node))
        throw new Error(`Node cannot bind variables: ${node.id}`);
      if (field === "characters" && node.type === "TEXT") await loadTextFonts(node);
      node.setBoundVariable(field, variable);
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
      (await getCollection(collectionId)).remove();
      return { deleted: collectionId };
    },
    async export_tokens(_nodeIds, p) {
      const format = (str(p, "format") ?? "json").toLowerCase();
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const variables = await figma.variables.getLocalVariablesAsync();
      const byId = new Map(variables.map((v) => [v.id, v]));
      const paintStyles = await figma.getLocalPaintStylesAsync();
      const json = { collections: {}, paintStyles: {} };
      const css = [];
      const rootLines = [];
      for (const c of collections) {
        const modes = {};
        for (const mode of c.modes) {
          const values = {};
          const lines = [];
          for (const vid of c.variableIds) {
            const v = byId.get(vid);
            if (!v) continue;
            const raw = v.valuesByMode[mode.modeId];
            const value = serializeVariableValue(raw);
            values[v.name] = value;
            const varName = `--${cssName(c.name)}-${cssName(v.name)}`;
            let cssValue;
            if (typeof value === "object" && value && "alias" in value) {
              const target = byId.get(value.alias);
              cssValue = target ? `var(--${cssName(c.name)}-${cssName(target.name)})` : "initial";
            } else if (v.resolvedType === "FLOAT") cssValue = `${value}px`;
            else if (v.resolvedType === "STRING") cssValue = JSON.stringify(value);
            else cssValue = String(value);
            lines.push(`  ${varName}: ${cssValue};`);
          }
          modes[mode.name] = values;
          if (mode.modeId === c.defaultModeId) rootLines.push(...lines);
          else
            css.push(`[data-${cssName(c.name)}="${cssName(mode.name)}"] {
${lines.join("\n")}
}`);
        }
        json.collections[c.name] = { id: c.id, modes };
      }
      for (const s of paintStyles) {
        const first = s.paints[0];
        if (first && first.type === "SOLID") {
          const hex = toHex2({ ...first.color, a: first.opacity ?? 1 });
          json.paintStyles[s.name] = hex;
          rootLines.push(`  --style-${cssName(s.name)}: ${hex};`);
        }
      }
      if (format === "css") {
        return { format: "css", css: [`:root {
${rootLines.join("\n")}
}`, ...css].join("\n\n") };
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
        style: str(p, "fontStyle") ?? "Regular"
      };
      await figma.loadFontAsync(fontName);
      const style = figma.createTextStyle();
      style.name = reqStr(p, "name", "create_text_style");
      style.fontName = fontName;
      style.fontSize = num(p, "fontSize") ?? 16;
      const lh = num(p, "lineHeightValue");
      if (lh !== void 0) {
        style.lineHeight = {
          value: lh,
          unit: str(p, "lineHeightUnit") === "PERCENT" ? "PERCENT" : "PIXELS"
        };
      }
      const ls = num(p, "letterSpacingValue");
      if (ls !== void 0) {
        style.letterSpacing = {
          value: ls,
          unit: str(p, "letterSpacingUnit") === "PERCENT" ? "PERCENT" : "PIXELS"
        };
      }
      const deco = str(p, "textDecoration");
      if (deco === "UNDERLINE" || deco === "STRIKETHROUGH" || deco === "NONE")
        style.textDecoration = deco;
      const textCase = str(p, "textCase");
      if (textCase === "UPPER" || textCase === "LOWER" || textCase === "TITLE" || textCase === "ORIGINAL") {
        style.textCase = textCase;
      }
      const description = str(p, "description");
      if (description) style.description = description;
      return { id: style.id, name: style.name, type: style.type, fontName };
    },
    async create_effect_style(_nodeIds, p) {
      const type = (str(p, "type") ?? "DROP_SHADOW").toUpperCase();
      let effect2;
      if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
        const { r, g, b } = parseHex(str(p, "color") ?? "#000000");
        effect2 = {
          type,
          color: { r, g, b, a: num(p, "opacity") ?? 0.25 },
          offset: { x: num(p, "offsetX") ?? 0, y: num(p, "offsetY") ?? 4 },
          radius: num(p, "radius") ?? 8,
          spread: num(p, "spread") ?? 0,
          visible: true,
          blendMode: "NORMAL"
        };
      } else if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
        effect2 = { type, radius: num(p, "radius") ?? 4, visible: true };
      } else {
        throw new Error("type must be DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, or BACKGROUND_BLUR");
      }
      const style = figma.createEffectStyle();
      style.name = reqStr(p, "name", "create_effect_style");
      style.effects = [effect2];
      const description = str(p, "description");
      if (description) style.description = description;
      return { id: style.id, name: style.name, type: style.type };
    },
    async create_grid_style(_nodeIds, p) {
      const pattern = (str(p, "pattern") ?? "GRID").toUpperCase();
      let grid;
      if (pattern === "GRID") {
        const { r, g, b } = parseHex(str(p, "color") ?? "#FF0000");
        grid = {
          pattern: "GRID",
          sectionSize: num(p, "sectionSize") ?? 8,
          visible: true,
          color: { r, g, b, a: num(p, "opacity") ?? 0.1 }
        };
      } else if (pattern === "COLUMNS" || pattern === "ROWS") {
        const alignment = (str(p, "alignment") ?? "STRETCH").toUpperCase();
        const base = {
          pattern,
          alignment,
          gutterSize: num(p, "gutterSize") ?? 16,
          count: num(p, "count") ?? 12,
          visible: true,
          color: { r: 1, g: 0, b: 0, a: 0.1 }
        };
        grid = alignment === "CENTER" ? { ...base, sectionSize: num(p, "sectionSize") ?? 64 } : { ...base, offset: num(p, "offset") ?? 0 };
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
      const paint2 = style;
      const name = str(p, "name");
      const color = str(p, "color");
      const description = str(p, "description");
      if (name) paint2.name = name;
      if (color) paint2.paints = [solid(color, num(p, "opacity"))];
      if (description !== void 0) paint2.description = description;
      return { id: paint2.id, name: paint2.name };
    },
    async delete_style(_nodeIds, p) {
      const style = await getStyle(reqStr(p, "styleId", "delete_style"));
      style.remove();
      return { deleted: style.id };
    },
    async apply_style_to_node(nodeIds, p) {
      const node = await sceneNode(str(p, "nodeId") ?? ids(nodeIds, "apply_style_to_node")[0]);
      const style = await getStyle(reqStr(p, "styleId", "apply_style_to_node"));
      const n = node;
      const call = async (method) => {
        if (typeof n[method] !== "function")
          throw new Error(`${node.type} does not support ${style.type} styles`);
        await n[method].call(node, style.id);
      };
      switch (style.type) {
        case "PAINT":
          await call(str(p, "target") === "stroke" ? "setStrokeStyleIdAsync" : "setFillStyleIdAsync");
          break;
        case "TEXT":
          if (node.type !== "TEXT") throw new Error("Text styles apply to TEXT nodes only");
          await loadTextFonts(node);
          await figma.loadFontAsync(style.fontName);
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
      return { nodeId: node.id, reactions: node.reactions };
    },
    async set_reactions(nodeIds, p) {
      const node = await sceneNode(str(p, "nodeId") ?? ids(nodeIds, "set_reactions")[0]);
      if (!("setReactionsAsync" in node))
        throw new Error(`Node does not support reactions: ${node.id}`);
      const incoming = p.reactions;
      if (!Array.isArray(incoming)) throw new Error("reactions must be an array");
      const target = node;
      const next = str(p, "mode") === "append" ? [...target.reactions, ...incoming] : incoming;
      await target.setReactionsAsync(next);
      return { nodeId: node.id, reactions: target.reactions };
    },
    async remove_reactions(nodeIds, p) {
      const node = await sceneNode(str(p, "nodeId") ?? ids(nodeIds, "remove_reactions")[0]);
      if (!("setReactionsAsync" in node))
        throw new Error(`Node does not support reactions: ${node.id}`);
      const target = node;
      const indices = Array.isArray(p.indices) ? new Set(p.indices) : null;
      const next = indices && indices.size > 0 ? target.reactions.filter((_, i) => !indices.has(i)) : [];
      await target.setReactionsAsync(next);
      return { nodeId: node.id, remaining: next.length };
    },
    // --- layout ------------------------------------------------------------
    async set_layout_child(nodeIds, p) {
      const results = [];
      for (const id of ids(nodeIds, "set_layout_child")) {
        const node = await sceneNode(id);
        const applied = {};
        const parentIsAuto = node.parent && "layoutMode" in node.parent && node.parent.layoutMode !== "NONE";
        const set = (key, value) => {
          if (!(key in node)) throw new Error(`${node.type} does not support ${key}: ${id}`);
          node[key] = value;
          applied[key] = value;
        };
        const positioning = str(p, "layoutPositioning");
        if (positioning === "AUTO" || positioning === "ABSOLUTE")
          set("layoutPositioning", positioning);
        for (const axis of ["layoutSizingHorizontal", "layoutSizingVertical"]) {
          const v = str(p, axis);
          if (v === void 0) continue;
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
        if (grow !== void 0) set("layoutGrow", grow);
        const align = str(p, "layoutAlign");
        if (align) set("layoutAlign", align);
        for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
          if (p[key] === null) set(key, null);
          else {
            const v = num(p, key);
            if (v !== void 0) set(key, v);
          }
        }
        results.push({ nodeId: id, applied });
      }
      return results;
    },
    async set_constraints(nodeIds, p) {
      const horizontal = str(p, "horizontal");
      const vertical = str(p, "vertical");
      const out = [];
      for (const id of ids(nodeIds, "set_constraints")) {
        const node = await sceneNode(id);
        if (!("constraints" in node)) throw new Error(`Node does not support constraints: ${id}`);
        const c = node.constraints;
        node.constraints = {
          horizontal: horizontal ?? c.horizontal,
          vertical: vertical ?? c.vertical
        };
        out.push({ nodeId: id, constraints: node.constraints });
      }
      return out;
    },
    async rotate_nodes(nodeIds, p) {
      const rotation = num(p, "rotation");
      if (rotation === void 0) throw new Error("rotation is required for rotate_nodes");
      const out = [];
      for (const id of ids(nodeIds, "rotate_nodes")) {
        const node = await sceneNode(id);
        if (!("rotation" in node)) throw new Error(`Node cannot rotate: ${id}`);
        node.rotation = rotation;
        out.push({ nodeId: id, rotation });
      }
      return out;
    },
    async reorder_nodes(nodeIds, p) {
      const order = reqStr(p, "order", "reorder_nodes");
      const out = [];
      for (const id of ids(nodeIds, "reorder_nodes")) {
        const node = await sceneNode(id);
        const parent = node.parent;
        if (!parent) throw new Error(`Node has no parent: ${id}`);
        const index = parent.children.indexOf(node);
        const last = parent.children.length - 1;
        const wanted = num(p, "index");
        const to = order === "bringToFront" ? last : order === "sendToBack" ? 0 : order === "bringForward" ? Math.min(last, index + 1) : order === "sendBackward" ? Math.max(0, index - 1) : order === "index" && wanted !== void 0 ? Math.max(0, Math.min(last, Math.round(wanted))) : -1;
        if (to < 0)
          throw new Error(
            "order must be bringToFront, sendToBack, bringForward, sendBackward, or index with an index param"
          );
        parent.insertChild(to, node);
        out.push({ nodeId: id, index: parent.children.indexOf(node) });
      }
      return out;
    },
    async set_blend_mode(nodeIds, p) {
      const blendMode = reqStr(p, "blendMode", "set_blend_mode");
      for (const id of ids(nodeIds, "set_blend_mode")) {
        const node = await sceneNode(id);
        if (!("blendMode" in node)) throw new Error(`Node has no blend mode: ${id}`);
        node.blendMode = blendMode;
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
      const pattern = bool(p, "useRegex") ? new RegExp(find, str(p, "regexFlags") ?? "g") : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
      const texts = [];
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
      const out = [];
      walk(
        root,
        (n) => {
          if (n.type !== "TEXT") return;
          out.push({
            id: n.id,
            name: n.name,
            characters: n.characters,
            fontName: n.fontName === figma.mixed ? "mixed" : n.fontName,
            fontSize: n.fontSize === figma.mixed ? "mixed" : n.fontSize
          });
          return true;
        },
        num(p, "limit") ?? 2e3
      );
      return out;
    },
    async search_nodes(nodeIds, p) {
      const query = (str(p, "query") ?? "").toLowerCase();
      const types = Array.isArray(p.types) ? new Set(p.types) : null;
      const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
      const out = [];
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
      const types = Array.isArray(p.types) ? new Set(p.types) : null;
      if (!types || types.size === 0) throw new Error("types is required for scan_nodes_by_types");
      const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
      const out = [];
      walk(
        root,
        (n) => {
          if (!types.has(n.type)) return;
          out.push({
            ...describe(n),
            parentId: n.parent?.id ?? null,
            width: n.width,
            height: n.height
          });
          return true;
        },
        num(p, "limit") ?? 2e3
      );
      return out;
    },
    async batch_rename_nodes(nodeIds, p) {
      const find = str(p, "find");
      const replace = str(p, "replace");
      if (find !== void 0 && replace === void 0)
        throw new Error("replace is required when find is provided");
      const pattern = find === void 0 ? null : bool(p, "useRegex") ? new RegExp(find, str(p, "regexFlags") ?? "g") : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      const prefix = str(p, "prefix") ?? "";
      const suffix = str(p, "suffix") ?? "";
      const out = [];
      for (const id of ids(nodeIds, "batch_rename_nodes")) {
        const node = await sceneNode(id);
        const before = node.name;
        let name = pattern ? before.replace(pattern, replace) : before;
        name = `${prefix}${name}${suffix}`;
        node.name = name;
        out.push({ id, before, after: name });
      }
      return out;
    },
    async get_fonts(nodeIds, p) {
      const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
      const counts = /* @__PURE__ */ new Map();
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
        const other = figma.root.children.find((pg) => pg.id !== page.id);
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
        bounds: figma.viewport.bounds
      };
    },
    async get_annotations(nodeIds, p) {
      const root = await scopeNode(str(p, "nodeId") ?? nodeIds?.[0]);
      const out = [];
      const collect = (n) => {
        const anns = n.annotations;
        if (anns && anns.length > 0) out.push({ ...describe(n), annotations: anns });
      };
      collect(root);
      walk(root, (n) => {
        collect(n);
      });
      return out;
    }
  };
  async function handleForgeRequest(type, nodeIds, params) {
    if (type === "design_preflight") return qualityPreflight(params ?? {});
    if (type === "audit_design") return qualityAudit(params ?? {});
    if (type === "get_build_checkpoint") return checkpointGet(params ?? {});
    if (type === "commit_build_checkpoint") return checkpointCommit(params ?? {});
    const handler = handlers[type];
    if (!handler) throw new Error(`Unknown forge request type: ${type}`);
    return handler(nodeIds, params ?? {});
  }

  // src/main/rest-serializer.ts
  var isMixed2 = (value) => String(value) === "figma.mixed";
  function rectOf(node) {
    const box = node.absoluteBoundingBox;
    if (!box) return null;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  function paint(paint2) {
    const out = { type: paint2.type };
    switch (paint2.type) {
      case "SOLID": {
        const color = paint2.color;
        out.color = { r: color.r, g: color.g, b: color.b, a: paint2.opacity ?? 1 };
        break;
      }
      case "GRADIENT_LINEAR":
      case "GRADIENT_RADIAL":
      case "GRADIENT_ANGULAR":
      case "GRADIENT_DIAMOND": {
        out.gradientStops = (paint2.gradientStops ?? []).map((stop) => ({
          position: stop.position,
          color: {
            ...stop.color ?? { r: 0, g: 0, b: 0 },
            a: stop.color?.a ?? 1
          }
        }));
        out.gradientTransform = paint2.gradientTransform;
        break;
      }
      case "IMAGE": {
        out.imageRef = paint2.imageHash ?? null;
        out.scaleMode = paint2.scaleMode;
        out.imageTransform = paint2.imageTransform;
        break;
      }
      default:
        break;
    }
    if (paint2.blendMode && paint2.blendMode !== "NORMAL") out.blendMode = paint2.blendMode;
    return out;
  }
  function paintArray(node, key) {
    const value = node[key];
    if (value === void 0 || isMixed2(value)) return value === void 0 ? void 0 : "mixed";
    return value.map(paint);
  }
  function effect(effect2) {
    const out = { type: effect2.type, visible: effect2.visible !== false };
    if (effect2.type === "DROP_SHADOW" || effect2.type === "INNER_SHADOW") {
      const color = effect2.color ?? { r: 0, g: 0, b: 0, a: 0.5 };
      out.color = { r: color.r, g: color.g, b: color.b, a: color.a ?? 1 };
      out.offset = effect2.offset ?? { x: 0, y: 0 };
      out.radius = effect2.radius ?? 0;
      if (effect2.spread !== void 0) out.spread = effect2.spread;
    } else {
      out.radius = effect2.radius ?? 0;
    }
    return out;
  }
  function geometry(node, out) {
    if ("visible" in node) out.visible = node.visible;
    if ("locked" in node) out.locked = node.locked;
    if ("opacity" in node && !isMixed2(node.opacity)) out.opacity = node.opacity;
    if ("blendMode" in node && node.blendMode !== "PASS_THROUGH") out.blendMode = node.blendMode;
    const box = rectOf(node);
    if (box) out.absoluteBoundingBox = box;
    const renderBox = node.absoluteRenderBounds;
    if (renderBox) out.absoluteRenderBounds = renderBox;
    if ("cornerRadius" in node && !isMixed2(node.cornerRadius)) out.cornerRadius = node.cornerRadius;
    if ("rectangleCornerRadii" in node) out.rectangleCornerRadii = node.rectangleCornerRadii;
    if ("fills" in node) {
      const fills = paintArray(node, "fills");
      if (fills !== void 0) out.fills = fills;
    }
    if ("strokes" in node) {
      const strokes = paintArray(node, "strokes");
      if (strokes !== void 0) out.strokes = strokes;
      if ("strokeWeight" in node && !isMixed2(node.strokeWeight)) out.strokeWeight = node.strokeWeight;
      if ("dashPattern" in node) out.dashPattern = node.dashPattern;
    }
    if ("effects" in node && !isMixed2(node.effects)) {
      out.effects = node.effects.map(effect);
    }
    if ("constraints" in node) out.constraints = node.constraints;
    if ("exportSettings" in node && Array.isArray(node.exportSettings) && node.exportSettings.length > 0) {
      out.exportSettings = node.exportSettings;
    }
    if ("style" in node && node.style && Object.keys(node.style).length > 0) {
      out.style = node.style;
    }
  }
  function autoLayout(node, out) {
    if (!("layoutMode" in node)) return;
    const mode = node.layoutMode;
    if (mode === "NONE") {
      out.layoutMode = "NONE";
      return;
    }
    out.layoutMode = mode;
    if ("itemSpacing" in node && !isMixed2(node.itemSpacing)) out.itemSpacing = node.itemSpacing;
    if ("counterAxisSpacing" in node && !isMixed2(node.counterAxisSpacing))
      out.counterAxisSpacing = node.counterAxisSpacing;
    if ("paddingTop" in node && !isMixed2(node.paddingTop)) out.paddingTop = node.paddingTop;
    if ("paddingRight" in node && !isMixed2(node.paddingRight)) out.paddingRight = node.paddingRight;
    if ("paddingBottom" in node && !isMixed2(node.paddingBottom)) out.paddingBottom = node.paddingBottom;
    if ("paddingLeft" in node && !isMixed2(node.paddingLeft)) out.paddingLeft = node.paddingLeft;
    if ("primaryAxisAlignItems" in node) out.primaryAxisAlignItems = node.primaryAxisAlignItems;
    if ("counterAxisAlignItems" in node) out.counterAxisAlignItems = node.counterAxisAlignItems;
    if ("primaryAxisSizingMode" in node) out.primaryAxisSizingMode = node.primaryAxisSizingMode;
    if ("counterAxisSizingMode" in node) out.counterAxisSizingMode = node.counterAxisSizingMode;
    if ("layoutWrap" in node) out.layoutWrap = node.layoutWrap;
    if ("clipsContent" in node) out.clipsContent = node.clipsContent;
  }
  function textContent(node, out) {
    if (node.type !== "TEXT") return;
    const text = node;
    out.characters = typeof text.characters === "string" ? text.characters : "";
    const style = node.style;
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
  function reflow(node) {
    const out = {
      id: node.id,
      name: node.name,
      type: node.type
    };
    if (node.parent && node.parent.type === "PAGE") {
      const index = node.parent.children.indexOf(node);
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
  function serializeRestNode(node) {
    const out = reflow(node);
    if ("children" in node) {
      out.children = node.children.map(serializeRestNode);
    }
    return out;
  }

  // src/plugin-version.ts
  var PLUGIN_VERSION = "1.0.0";

  // src/main/code.ts
  var cachedFallbackFileKey = null;
  var generateFallbackFileKey = () => {
    const random = Math.random().toString(36).slice(2, 10);
    return `unsaved-${Date.now().toString(36)}-${random}`;
  };
  var getFileKey = () => {
    try {
      if (typeof figma.fileKey === "string" && figma.fileKey) {
        return figma.fileKey;
      }
    } catch {
    }
    if (!cachedFallbackFileKey) {
      cachedFallbackFileKey = generateFallbackFileKey();
      console.warn(
        `[figma-mcp-bridge] figma.fileKey unavailable for "${figma.root.name}". Using session fallback key "${cachedFallbackFileKey}". If you encounter this in a built plugin, please report at https://github.com/gethopp/figma-mcp-bridge/issues with steps to reproduce.`
      );
    }
    return cachedFallbackFileKey;
  };
  var selectionTypes = () => {
    const types = /* @__PURE__ */ new Set();
    for (const node of figma.currentPage.selection) types.add(node.type);
    return [...types];
  };
  var selectionSummary = () => figma.currentPage.selection.slice(0, 20).map((node) => {
    const box = node.absoluteBoundingBox;
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      visible: "visible" in node ? node.visible : true,
      locked: "locked" in node ? node.locked : false,
      opacity: "opacity" in node ? node.opacity : 1,
      width: box ? box.width : node.width ?? 0,
      height: box ? box.height : node.height ?? 0
    };
  });
  var sendStatus = (changedNodeIds) => {
    figma.ui.postMessage({
      type: "plugin-status",
      payload: {
        connected: true,
        fileName: figma.root.name,
        fileKey: getFileKey(),
        pageCount: figma.root.children.length,
        currentPage: figma.currentPage.name,
        hasSelection: figma.currentPage.selection.length > 0,
        selectionCount: figma.currentPage.selection.length,
        selectionTypes: selectionTypes(),
        selectionNodes: selectionSummary(),
        lastUpdatedAt: Date.now(),
        ...changedNodeIds && changedNodeIds.length > 0 ? { nodeIds: changedNodeIds } : {}
      }
    });
  };
  var serializeVariableValue2 = (value) => {
    if (typeof value === "object" && value !== null) {
      if ("type" in value && value.type === "VARIABLE_ALIAS") {
        return { type: "VARIABLE_ALIAS", id: value.id };
      }
      if ("r" in value && "g" in value && "b" in value) {
        const color = value;
        return {
          type: "COLOR",
          r: color.r,
          g: color.g,
          b: color.b,
          a: "a" in color ? color.a : 1
        };
      }
    }
    return value;
  };
  var isSceneNode = (node) => node !== null && node.type !== "DOCUMENT" && node.type !== "PAGE";
  var getSceneNodeById = async (nodeId) => {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!isSceneNode(node)) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    return node;
  };
  var getTextTargetById = async (nodeId, toolName) => {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!isSceneNode(node)) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    if (node.type === "TEXT") {
      return { kind: "text", node, text: node };
    }
    if (node.type === "STICKY" || node.type === "SHAPE_WITH_TEXT") {
      return { kind: "sublayer", node, text: node.text };
    }
    throw new Error(
      `${toolName} supports TEXT, STICKY, and SHAPE_WITH_TEXT nodes (got ${node.type}: ${nodeId})`
    );
  };
  var supportsChildren = (node) => "appendChild" in node;
  var isMotionNode = (node) => "applyAnimationStyle" in node;
  var getParentNodeById = async (parentId) => {
    const parent = await figma.getNodeByIdAsync(parentId);
    if (!parent || parent.type === "DOCUMENT" || !supportsChildren(parent)) {
      throw new Error(`Parent does not support children: ${parentId}`);
    }
    if (parent.type === "PAGE") {
      await parent.loadAsync();
    }
    return parent;
  };
  var parseHexColor = (hex) => {
    const normalized = hex.trim().replace(/^#/, "");
    if (normalized.length !== 3 && normalized.length !== 6) {
      throw new Error(`Invalid hex color: ${hex}`);
    }
    const expanded = normalized.length === 3 ? normalized.split("").map((char) => `${char}${char}`).join("") : normalized;
    if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
      throw new Error(`Invalid hex color: ${hex}`);
    }
    return {
      r: parseInt(expanded.slice(0, 2), 16) / 255,
      g: parseInt(expanded.slice(2, 4), 16) / 255,
      b: parseInt(expanded.slice(4, 6), 16) / 255
    };
  };
  var setSolidFill = (node, fillHex, fillOpacity, target = "fill") => {
    const paint2 = {
      type: "SOLID",
      color: parseHexColor(fillHex),
      opacity: fillOpacity ?? 1
    };
    if (target === "stroke") {
      if (!("strokes" in node)) {
        throw new Error(`Node does not support strokes: ${node.id}`);
      }
      node.strokes = [paint2];
      return;
    }
    if (!("fills" in node)) {
      throw new Error(`Node does not support fills: ${node.id}`);
    }
    node.fills = [paint2];
  };
  var buildGradientPaint = (paintType, stops, transform, opacity) => {
    const colorStops = stops.map((stop) => {
      const rgb = parseHexColor(stop.hex);
      return {
        position: stop.position,
        color: { r: rgb.r, g: rgb.g, b: rgb.b, a: stop.opacity ?? 1 }
      };
    });
    const gradientTransform = transform ?? [
      [1, 0, 0],
      [0, 1, 0]
    ];
    const paint2 = {
      type: paintType,
      gradientStops: colorStops,
      gradientTransform,
      opacity: opacity ?? 1
    };
    return paint2;
  };
  var loadFontsForTextNode = async (node) => {
    const fonts = /* @__PURE__ */ new Map();
    if (node.characters.length > 0) {
      for (const font of node.getRangeAllFontNames(0, node.characters.length)) {
        fonts.set(`${font.family}::${font.style}`, font);
      }
    } else if (typeof node.fontName !== "symbol") {
      fonts.set(`${node.fontName.family}::${node.fontName.style}`, node.fontName);
    } else {
      throw new Error(
        `Cannot determine font for empty mixed-font text node: ${"id" in node ? node.id : "text sublayer"}`
      );
    }
    await Promise.all([...fonts.values()].map((font) => figma.loadFontAsync(font)));
  };
  var ensureFont = async (family, style) => {
    const font = { family, style };
    await figma.loadFontAsync(font);
    return font;
  };
  var applyTextFill = (node, fillHex, fillOpacity) => {
    node.fills = [
      {
        type: "SOLID",
        color: parseHexColor(fillHex),
        opacity: fillOpacity ?? 1
      }
    ];
  };
  var positionNode = (node, x, y) => {
    if ("x" in node && typeof x === "number") {
      node.x = x;
    }
    if ("y" in node && typeof y === "number") {
      node.y = y;
    }
  };
  var resizeNodeIfSupported = (node, width, height) => {
    if (typeof width !== "number" && typeof height !== "number") {
      return;
    }
    if (!("resize" in node) || typeof node.resize !== "function") {
      throw new Error(`Node does not support resizing: ${node.id}`);
    }
    const nextWidth = typeof width === "number" ? width : node.width;
    const nextHeight = typeof height === "number" ? height : node.height;
    node.resize(nextWidth, nextHeight);
  };
  var appendToParentIfProvided = async (node, parentId) => {
    if (typeof parentId !== "string") {
      return;
    }
    const parent = await getParentNodeById(parentId);
    parent.appendChild(node);
  };
  var decodeBase64ToBytes = (base64) => {
    try {
      return figma.base64Decode(base64);
    } catch {
      throw new Error("Invalid base64 image payload");
    }
  };
  var isFigJam = () => figma.editorType === "figjam";
  var requireFigJamApi = (toolName, apiName, api) => {
    if (!isFigJam()) {
      throw new Error(`${toolName} is only available in FigJam`);
    }
    if (typeof api !== "function") {
      throw new Error(
        `${toolName} unavailable: figma.${apiName} is missing. Run the plugin in FigJam with "figjam" in the manifest editorType.`
      );
    }
  };
  var EDIT_REQUEST_TYPES = /* @__PURE__ */ new Set([
    "set_node_visibility",
    "set_text_content",
    "set_text_properties",
    "set_node_properties",
    "set_solid_fill",
    "set_gradient_fill",
    "set_effects",
    "set_stroke_properties",
    "set_auto_layout",
    "create_page",
    "create_frame",
    "create_text",
    "create_shape",
    "create_image",
    "create_svg",
    "create_sticky",
    "create_connector",
    "create_section",
    "create_shape_with_text",
    "import_html_layers",
    "duplicate_nodes",
    "duplicate_with_offset",
    "fit_to_content",
    "distribute_horizontally",
    "distribute_vertically",
    "align_to_grid",
    "place_below",
    "place_right_of",
    "reparent_nodes",
    "group_nodes",
    "ungroup_node",
    "delete_nodes",
    "run_script",
    "apply_animation_style",
    "remove_animation_style",
    "apply_manual_keyframe_track",
    "remove_manual_keyframe_track",
    "set_timeline_duration"
  ]);
  var requireEditorMode = (toolName) => {
    if (figma.editorType === "dev") {
      throw new Error(
        `${toolName} requires the plugin to be opened in Figma's design editor (Dev Mode is read-only). Switch to the design editor and re-run.`
      );
    }
  };
  var requirePrototypes = (toolName) => {
    if (isFigJam()) {
      throw new Error(`${toolName} is not available in FigJam (FigJam files have no prototypes)`);
    }
  };
  async function getLayoutTree(rootId, maxNodes = 2e3) {
    const root = await figma.getNodeByIdAsync(rootId);
    if (!root || root.type === "DOCUMENT" || root.type === "PAGE")
      throw new Error("Scene root required");
    const nodes = [];
    let truncated = false;
    function visit(node, depth) {
      if (nodes.length >= maxNodes || depth > 100) {
        truncated = true;
        return;
      }
      nodes.push({
        id: node.id,
        parentId: node.parent?.id,
        name: node.name,
        type: node.type,
        visible: node.visible,
        localSize: { width: node.width, height: node.height },
        absoluteTransform: node.absoluteTransform,
        absoluteBoundingBox: node.absoluteBoundingBox,
        absoluteRenderBounds: "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null,
        clipsContent: "clipsContent" in node ? node.clipsContent : false
      });
      if ("children" in node) for (const child of node.children) visit(child, depth + 1);
    }
    visit(root, 0);
    return {
      schemaVersion: 1,
      snapshotId: (/* @__PURE__ */ new Date()).toISOString(),
      atomicWithScreenshot: false,
      fileKey: figma.fileKey ?? null,
      fileName: figma.root.name,
      pageId: figma.currentPage.id,
      rootId,
      truncated,
      nodes,
      capture: {
        coordinateSpace: "document-absolute",
        window: root.absoluteBoundingBox,
        exportSettings: {
          format: "PNG",
          contentsOnly: true,
          useAbsoluteBounds: true,
          constraint: { type: "SCALE", value: 1 }
        },
        dimensionsAreMeasuredFromImage: false,
        clipping: "Rectangles are layout AABBs; ancestor masks and painted visibility are not evaluated."
      }
    };
  }
  var handleRequest = async (request) => {
    try {
      if (EDIT_REQUEST_TYPES.has(request.type)) {
        requireEditorMode(request.type);
      }
      switch (request.type) {
        case "get_document":
          return {
            type: request.type,
            requestId: request.requestId,
            data: serializeNode(figma.currentPage)
          };
        case "get_selection":
          return {
            type: request.type,
            requestId: request.requestId,
            data: figma.currentPage.selection.map((node) => serializeNode(node))
          };
        case "get_layout_tree": {
          const rootId = request.nodeIds?.[0];
          if (!rootId) throw new Error("rootId is required");
          return {
            type: request.type,
            requestId: request.requestId,
            data: await getLayoutTree(rootId, Number(request.params?.maxNodes ?? 2e3))
          };
        }
        case "get_node": {
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) {
            throw new Error("nodeIds is required for get_node");
          }
          const node = await figma.getNodeByIdAsync(nodeId);
          if (!node || node.type === "DOCUMENT") {
            throw new Error(`Node not found: ${nodeId}`);
          }
          const data = serializeNode(node);
          if (!request.params?.includePrototype) {
            return { type: request.type, requestId: request.requestId, data };
          }
          requirePrototypes("get_node includePrototype");
          return {
            type: request.type,
            requestId: request.requestId,
            data: { ...data, prototype: await scanPrototype(node) }
          };
        }
        case "get_nodes": {
          const ids2 = request.nodeIds;
          if (!ids2 || ids2.length === 0) {
            throw new Error("nodeIds is required for get_nodes");
          }
          const nodes = [];
          for (const id of ids2) {
            const loaded = await figma.getNodeByIdAsync(id);
            if (!loaded || loaded.type === "DOCUMENT") {
              throw new Error(`Node not found: ${id}`);
            }
            if (loaded.type === "PAGE") await loaded.loadAsync();
            nodes.push(serializeRestNode(loaded));
          }
          return { type: request.type, requestId: request.requestId, data: { nodes } };
        }
        case "get_prototype_connections": {
          requirePrototypes(request.type);
          const nodeId = request.nodeIds?.[0];
          const root = nodeId ? await figma.getNodeByIdAsync(nodeId) : figma.currentPage;
          if (!root || root.type === "DOCUMENT") {
            throw new Error(`Node not found: ${nodeId}`);
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: await getPrototypeConnections(root, request.params)
          };
        }
        case "trace_prototype_flow": {
          requirePrototypes(request.type);
          const nodeId = request.nodeIds?.[0];
          if (!nodeId) {
            throw new Error("nodeId is required for trace_prototype_flow");
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: await tracePrototypeFlow(await getSceneNodeById(nodeId), request.params)
          };
        }
        case "get_styles": {
          if (isFigJam()) {
            let paintStyles2 = [];
            let textStyles2 = [];
            let effectStyles2 = [];
            try {
              paintStyles2 = await figma.getLocalPaintStylesAsync();
            } catch {
            }
            try {
              textStyles2 = await figma.getLocalTextStylesAsync();
            } catch {
            }
            try {
              effectStyles2 = await figma.getLocalEffectStylesAsync();
            } catch {
            }
            return {
              type: request.type,
              requestId: request.requestId,
              data: {
                paints: paintStyles2.map((style) => ({
                  id: style.id,
                  name: style.name,
                  paints: style.paints
                })),
                text: textStyles2.map((style) => ({
                  id: style.id,
                  name: style.name,
                  fontSize: style.fontSize,
                  fontName: style.fontName,
                  textDecoration: style.textDecoration,
                  lineHeight: style.lineHeight,
                  letterSpacing: style.letterSpacing
                })),
                effects: effectStyles2.map((style) => ({
                  id: style.id,
                  name: style.name,
                  effects: style.effects
                })),
                grids: []
              }
            };
          }
          const [paintStyles, textStyles, effectStyles, gridStyles] = await Promise.all([
            figma.getLocalPaintStylesAsync(),
            figma.getLocalTextStylesAsync(),
            figma.getLocalEffectStylesAsync(),
            figma.getLocalGridStylesAsync()
          ]);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              paints: paintStyles.map((style) => ({
                id: style.id,
                name: style.name,
                paints: style.paints
              })),
              text: textStyles.map((style) => ({
                id: style.id,
                name: style.name,
                fontSize: style.fontSize,
                fontName: style.fontName,
                textDecoration: style.textDecoration,
                lineHeight: style.lineHeight,
                letterSpacing: style.letterSpacing
              })),
              effects: effectStyles.map((style) => ({
                id: style.id,
                name: style.name,
                effects: style.effects
              })),
              grids: gridStyles.map((style) => ({
                id: style.id,
                name: style.name,
                layoutGrids: style.layoutGrids
              }))
            }
          };
        }
        case "get_metadata": {
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              editorType: figma.editorType,
              fileName: figma.root.name,
              currentPageId: figma.currentPage.id,
              currentPageName: figma.currentPage.name,
              pageCount: figma.root.children.length,
              pages: figma.root.children.map((page) => ({
                id: page.id,
                name: page.name
              }))
            }
          };
        }
        case "get_design_context": {
          const depth = typeof request.params?.depth === "number" ? request.params.depth : 2;
          const serializeWithDepth = async (node, currentDepth) => {
            const serialized = serializeNode(node);
            if (currentDepth >= depth && serialized.children) {
              return {
                ...serialized,
                children: void 0,
                childCount: node.children?.filter((c) => c.visible !== false).length ?? 0
              };
            }
            if (serialized.children) {
              const childNodes = await Promise.all(
                serialized.children.map((child) => figma.getNodeByIdAsync(child.id))
              );
              const serializedChildren = await Promise.all(
                childNodes.filter(
                  (n) => n !== null && n.type !== "DOCUMENT" && "visible" in n && n.visible !== false
                ).map((n) => serializeWithDepth(n, currentDepth + 1))
              );
              return {
                ...serialized,
                children: serializedChildren
              };
            }
            return serialized;
          };
          const selection = figma.currentPage.selection;
          const contextNodes = selection.length > 0 ? await Promise.all(selection.map((node) => serializeWithDepth(node, 0))) : [await serializeWithDepth(figma.currentPage, 0)];
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              fileName: figma.root.name,
              currentPage: {
                id: figma.currentPage.id,
                name: figma.currentPage.name
              },
              selectionCount: selection.length,
              context: contextNodes
            }
          };
        }
        case "get_variable_defs": {
          if (isFigJam()) {
            try {
              const collections2 = await figma.variables.getLocalVariableCollectionsAsync();
              const variableData2 = await Promise.all(
                collections2.map(async (collection) => {
                  const variables = await Promise.all(
                    collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id))
                  );
                  return {
                    id: collection.id,
                    name: collection.name,
                    modes: collection.modes.map((mode) => ({
                      modeId: mode.modeId,
                      name: mode.name
                    })),
                    variables: variables.filter((v) => v !== null).map((variable) => ({
                      id: variable.id,
                      name: variable.name,
                      resolvedType: variable.resolvedType,
                      valuesByMode: Object.fromEntries(
                        Object.entries(variable.valuesByMode).map(([modeId, value]) => [
                          modeId,
                          serializeVariableValue2(value)
                        ])
                      )
                    }))
                  };
                })
              );
              return {
                type: request.type,
                requestId: request.requestId,
                data: {
                  collections: variableData2
                }
              };
            } catch {
              return {
                type: request.type,
                requestId: request.requestId,
                data: {
                  collections: [],
                  note: "Variables are not available in FigJam"
                }
              };
            }
          }
          const collections = await figma.variables.getLocalVariableCollectionsAsync();
          const variableData = await Promise.all(
            collections.map(async (collection) => {
              const variables = await Promise.all(
                collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id))
              );
              return {
                id: collection.id,
                name: collection.name,
                modes: collection.modes.map((mode) => ({
                  modeId: mode.modeId,
                  name: mode.name
                })),
                variables: variables.filter((v) => v !== null).map((variable) => ({
                  id: variable.id,
                  name: variable.name,
                  resolvedType: variable.resolvedType,
                  valuesByMode: Object.fromEntries(
                    Object.entries(variable.valuesByMode).map(([modeId, value]) => [
                      modeId,
                      serializeVariableValue2(value)
                    ])
                  )
                }))
              };
            })
          );
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              collections: variableData
            }
          };
        }
        case "get_screenshot": {
          const format = request.params?.format === "SVG" || request.params?.format === "PDF" || request.params?.format === "JPG" || request.params?.format === "PNG" ? request.params.format : "PNG";
          const scale = typeof request.params?.scale === "number" ? request.params.scale : 2;
          const clip = request.params?.clip === true;
          let targetNodes;
          if (request.nodeIds && request.nodeIds.length > 0) {
            const nodes = await Promise.all(request.nodeIds.map((id) => figma.getNodeByIdAsync(id)));
            targetNodes = nodes.filter(
              (node) => node !== null && node.type !== "DOCUMENT" && node.type !== "PAGE"
            );
          } else {
            targetNodes = [...figma.currentPage.selection];
          }
          if (targetNodes.length === 0) {
            throw new Error("No nodes to export. Select nodes or provide nodeIds.");
          }
          const exports = await Promise.all(
            targetNodes.map(async (node) => {
              const commonSettings = clip ? { contentsOnly: true, useAbsoluteBounds: true } : {};
              const settings = format === "SVG" ? { format: "SVG", ...commonSettings } : format === "PDF" ? { format: "PDF", ...commonSettings } : format === "JPG" ? {
                format: "JPG",
                constraint: { type: "SCALE", value: scale },
                ...commonSettings
              } : {
                format: "PNG",
                constraint: { type: "SCALE", value: scale },
                ...commonSettings
              };
              const bytes = await node.exportAsync(settings);
              const base64 = figma.base64Encode(bytes);
              return {
                nodeId: node.id,
                nodeName: node.name,
                format,
                base64,
                width: node.width,
                height: node.height
              };
            })
          );
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              exports
            }
          };
        }
        case "set_node_visibility": {
          const rawItems = request.params?.items;
          if (!Array.isArray(rawItems) || rawItems.length === 0) {
            throw new Error("items is required for set_node_visibility");
          }
          const items = rawItems;
          const results = [];
          for (const { nodeId, visible } of items) {
            const node = await figma.getNodeByIdAsync(nodeId);
            if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
              results.push({ nodeId, error: `Node not found: ${nodeId}` });
              continue;
            }
            const sceneNode2 = node;
            const previousVisible = sceneNode2.visible;
            sceneNode2.visible = visible;
            results.push({ nodeId, previousVisible, visible });
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: { results }
          };
        }
        case "set_text_content": {
          const nodeId = request.nodeIds && request.nodeIds[0];
          const text = request.params?.text;
          if (!nodeId) {
            throw new Error("nodeIds is required for set_text_content");
          }
          if (typeof text !== "string") {
            throw new Error("text is required for set_text_content");
          }
          const target = await getTextTargetById(nodeId, "set_text_content");
          await loadFontsForTextNode(target.text);
          const previousCharacters = target.text.characters;
          target.text.characters = text;
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: target.node.id,
              nodeName: target.node.name,
              previousCharacters,
              characters: target.text.characters
            }
          };
        }
        case "set_text_properties": {
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) {
            throw new Error("nodeIds is required for set_text_properties");
          }
          const target = await getTextTargetById(nodeId, "set_text_properties");
          const text = target.text;
          const params = request.params ?? {};
          const applied = {};
          await loadFontsForTextNode(text);
          if (typeof params.fontFamily === "string" || typeof params.fontStyle === "string") {
            const currentFontName = typeof text.fontName === "symbol" ? null : text.fontName;
            const nextFamily = typeof params.fontFamily === "string" ? params.fontFamily : currentFontName?.family;
            const nextStyle = typeof params.fontStyle === "string" ? params.fontStyle : currentFontName?.style;
            if (!nextFamily || !nextStyle) {
              throw new Error(
                "fontFamily and fontStyle must resolve to a concrete font for set_text_properties"
              );
            }
            text.fontName = await ensureFont(nextFamily, nextStyle);
            applied.fontName = text.fontName;
          }
          if (typeof params.fontSize === "number") {
            text.fontSize = params.fontSize;
            applied.fontSize = text.fontSize;
          }
          if (params.textAlignHorizontal !== void 0 || params.textAlignVertical !== void 0 || params.textAutoResize !== void 0) {
            if (target.kind !== "text") {
              throw new Error(
                "textAlignHorizontal/textAlignVertical/textAutoResize are only supported on TEXT nodes \u2014 they do not exist on STICKY/SHAPE_WITH_TEXT text"
              );
            }
            const node2 = target.node;
            if (params.textAlignHorizontal === "LEFT" || params.textAlignHorizontal === "CENTER" || params.textAlignHorizontal === "RIGHT" || params.textAlignHorizontal === "JUSTIFIED") {
              node2.textAlignHorizontal = params.textAlignHorizontal;
              applied.textAlignHorizontal = node2.textAlignHorizontal;
            }
            if (params.textAlignVertical === "TOP" || params.textAlignVertical === "CENTER" || params.textAlignVertical === "BOTTOM") {
              node2.textAlignVertical = params.textAlignVertical;
              applied.textAlignVertical = node2.textAlignVertical;
            }
            if (params.textAutoResize === "NONE" || params.textAutoResize === "WIDTH_AND_HEIGHT" || params.textAutoResize === "HEIGHT" || params.textAutoResize === "TRUNCATE") {
              node2.textAutoResize = params.textAutoResize;
              applied.textAutoResize = node2.textAutoResize;
            }
          }
          if (typeof params.lineHeightPx === "number") {
            text.lineHeight = {
              unit: "PIXELS",
              value: params.lineHeightPx
            };
            applied.lineHeight = text.lineHeight;
          }
          if (typeof params.letterSpacingPx === "number") {
            text.letterSpacing = {
              unit: "PIXELS",
              value: params.letterSpacingPx
            };
            applied.letterSpacing = text.letterSpacing;
          }
          if (typeof params.fillHex === "string") {
            const fillOpacity = typeof params.fillOpacity === "number" ? params.fillOpacity : void 0;
            applyTextFill(text, params.fillHex, fillOpacity);
            applied.fillHex = params.fillHex;
            applied.fillOpacity = fillOpacity ?? 1;
          }
          const node = target.node;
          if (typeof params.x === "number" || typeof params.y === "number") {
            positionNode(node, params.x, params.y);
            applied.x = node.x;
            applied.y = node.y;
          }
          resizeNodeIfSupported(node, params.width, params.height);
          if (typeof params.width === "number" || typeof params.height === "number") {
            applied.width = node.width;
            applied.height = node.height;
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              nodeName: node.name,
              applied
            }
          };
        }
        case "set_node_properties": {
          const nodeIds = request.nodeIds;
          if (!nodeIds || nodeIds.length === 0) {
            throw new Error("nodeIds is required for set_node_properties");
          }
          const { nodeIds: _batchIds, fileKey: _fileKey, ...params } = request.params ?? {};
          const hasUpdates = Object.keys(params).length > 0;
          if (!hasUpdates) {
            throw new Error("At least one property is required for set_node_properties");
          }
          const nodes = await Promise.all(nodeIds.map((id) => getSceneNodeById(id)));
          const applyUpdates = (node) => {
            const applied = {};
            const id = node.id;
            if (typeof params.name === "string") {
              node.name = params.name;
              applied.name = node.name;
            }
            if (typeof params.visible === "boolean") {
              node.visible = params.visible;
              applied.visible = node.visible;
            }
            if (typeof params.x === "number" || typeof params.y === "number") {
              if (!("x" in node) || !("y" in node)) {
                throw new Error(`Node does not support x/y positioning: ${id}`);
              }
              positionNode(node, params.x, params.y);
              applied.x = node.x;
              applied.y = node.y;
            }
            if (typeof params.width === "number" || typeof params.height === "number") {
              resizeNodeIfSupported(node, params.width, params.height);
              applied.width = node.width;
              applied.height = node.height;
            }
            if (typeof params.rotation === "number") {
              if (!("rotation" in node)) {
                throw new Error(`Node does not support rotation: ${id}`);
              }
              node.rotation = params.rotation;
              applied.rotation = node.rotation;
            }
            if (typeof params.opacity === "number") {
              if (!("opacity" in node)) {
                throw new Error(`Node does not support opacity: ${id}`);
              }
              node.opacity = params.opacity;
              applied.opacity = node.opacity;
            }
            if (typeof params.cornerRadius === "number") {
              if (!("cornerRadius" in node)) {
                throw new Error(`Node does not support cornerRadius: ${id}`);
              }
              const cornerNode = node;
              cornerNode.cornerRadius = params.cornerRadius;
              applied.cornerRadius = cornerNode.cornerRadius;
            }
            return applied;
          };
          if (nodes.length === 1) {
            const node = nodes[0];
            const applied = applyUpdates(node);
            return {
              type: request.type,
              requestId: request.requestId,
              data: {
                nodeId: node.id,
                nodeName: node.name,
                applied
              }
            };
          }
          const results = nodes.map((node) => ({
            nodeId: node.id,
            nodeName: node.name,
            applied: applyUpdates(node)
          }));
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              updatedCount: results.length,
              results
            }
          };
        }
        case "set_solid_fill": {
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) {
            throw new Error("nodeIds is required for set_solid_fill");
          }
          const node = await getSceneNodeById(nodeId);
          const params = request.params ?? {};
          if (typeof params.hex !== "string") {
            throw new Error("hex is required");
          }
          const target = params.target === "stroke" ? "stroke" : "fill";
          const opacity = typeof params.opacity === "number" ? params.opacity : void 0;
          setSolidFill(node, params.hex, opacity, target);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              nodeName: node.name,
              applied: {
                target,
                hex: params.hex,
                opacity: opacity ?? 1
              }
            }
          };
        }
        case "set_gradient_fill": {
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) {
            throw new Error("nodeIds is required for set_gradient_fill");
          }
          const node = await getSceneNodeById(nodeId);
          const params = request.params ?? {};
          const target = params.target === "stroke" ? "stroke" : "fill";
          if (target === "fill" && !("fills" in node)) {
            throw new Error(`Node does not support fills: ${node.id}`);
          }
          if (target === "stroke" && !("strokes" in node)) {
            throw new Error(`Node does not support strokes: ${node.id}`);
          }
          const gradientType = typeof params.gradientType === "string" ? params.gradientType : "LINEAR";
          const paintType = `GRADIENT_${gradientType}`;
          if (paintType !== "GRADIENT_LINEAR" && paintType !== "GRADIENT_RADIAL" && paintType !== "GRADIENT_ANGULAR" && paintType !== "GRADIENT_DIAMOND") {
            throw new Error(`Unsupported gradient type: ${gradientType}`);
          }
          if (!Array.isArray(params.gradientStops) || params.gradientStops.length < 2) {
            throw new Error("gradientStops must have at least 2 entries");
          }
          const stops = params.gradientStops;
          const transform = Array.isArray(params.gradientTransform) && params.gradientTransform.length === 2 ? params.gradientTransform : void 0;
          const opacity = typeof params.opacity === "number" ? params.opacity : void 0;
          const paint2 = buildGradientPaint(paintType, stops, transform, opacity);
          if (target === "fill") {
            node.fills = [paint2];
          } else {
            node.strokes = [paint2];
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              nodeName: node.name,
              applied: {
                target,
                gradientType: paintType,
                stops: paint2.gradientStops.length
              }
            }
          };
        }
        case "set_effects": {
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) {
            throw new Error("nodeIds is required for set_effects");
          }
          const node = await getSceneNodeById(nodeId);
          if (!("effects" in node)) {
            throw new Error(`Node does not support effects: ${node.id}`);
          }
          const params = request.params ?? {};
          if (!Array.isArray(params.effects)) {
            throw new Error("effects must be an array (pass [] to clear)");
          }
          const built = params.effects.map((raw, i) => {
            const type = raw.type;
            if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
              if (typeof raw.color !== "string") {
                throw new Error(`effects[${i}].color must be a hex string`);
              }
              const offset = raw.offset;
              if (!offset || typeof offset.x !== "number" || typeof offset.y !== "number") {
                throw new Error(`effects[${i}].offset must be {x,y} numbers`);
              }
              if (typeof raw.radius !== "number") {
                throw new Error(`effects[${i}].radius must be a number`);
              }
              const rgb = parseHexColor(raw.color);
              const alpha = typeof raw.opacity === "number" ? raw.opacity : 1;
              return {
                type,
                color: { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha },
                offset: { x: offset.x, y: offset.y },
                radius: raw.radius,
                spread: typeof raw.spread === "number" ? raw.spread : 0,
                visible: raw.visible === void 0 ? true : Boolean(raw.visible),
                blendMode: typeof raw.blendMode === "string" ? raw.blendMode : "NORMAL"
              };
            }
            if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
              if (typeof raw.radius !== "number") {
                throw new Error(`effects[${i}].radius must be a number`);
              }
              return {
                type,
                radius: raw.radius,
                visible: raw.visible === void 0 ? true : Boolean(raw.visible)
              };
            }
            throw new Error(`Unsupported effect type at effects[${i}]: ${String(type)}`);
          });
          node.effects = built;
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              nodeName: node.name,
              applied: { count: built.length }
            }
          };
        }
        case "set_stroke_properties": {
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) {
            throw new Error("nodeIds is required for set_stroke_properties");
          }
          const node = await getSceneNodeById(nodeId);
          const params = request.params ?? {};
          const applied = {};
          if (typeof params.strokeWeight === "number") {
            if (!("strokeWeight" in node)) {
              throw new Error(`Node does not support strokeWeight: ${node.id}`);
            }
            node.strokeWeight = params.strokeWeight;
            applied.strokeWeight = params.strokeWeight;
          }
          if (params.strokeAlign === "INSIDE" || params.strokeAlign === "OUTSIDE" || params.strokeAlign === "CENTER") {
            if (!("strokeAlign" in node)) {
              throw new Error(`Node does not support strokeAlign: ${node.id}`);
            }
            node.strokeAlign = params.strokeAlign;
            applied.strokeAlign = params.strokeAlign;
          }
          if (Array.isArray(params.dashPattern)) {
            if (!("dashPattern" in node)) {
              throw new Error(`Node does not support dashPattern: ${node.id}`);
            }
            const pattern = params.dashPattern.map((n, i) => {
              if (typeof n !== "number" || n < 0) {
                throw new Error(`dashPattern[${i}] must be a non-negative number`);
              }
              return n;
            });
            node.dashPattern = pattern;
            applied.dashPattern = pattern;
          }
          if (typeof params.strokeCap === "string") {
            if (!("strokeCap" in node)) {
              throw new Error(`Node does not support strokeCap: ${node.id}`);
            }
            node.strokeCap = params.strokeCap;
            applied.strokeCap = params.strokeCap;
          }
          if (typeof params.strokeJoin === "string") {
            if (!("strokeJoin" in node)) {
              throw new Error(`Node does not support strokeJoin: ${node.id}`);
            }
            node.strokeJoin = params.strokeJoin;
            applied.strokeJoin = params.strokeJoin;
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              nodeName: node.name,
              applied
            }
          };
        }
        case "set_auto_layout": {
          if (isFigJam()) {
            throw new Error("set_auto_layout is not available in FigJam");
          }
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) {
            throw new Error("nodeIds is required for set_auto_layout");
          }
          const node = await getSceneNodeById(nodeId);
          if (node.type === "SECTION") {
            throw new Error(`Auto-layout is not supported on sections in Figma's API: ${node.id}`);
          }
          if (!("layoutMode" in node)) {
            throw new Error(`Node does not support auto-layout: ${node.id}`);
          }
          const frame = node;
          const params = request.params ?? {};
          const applied = {};
          if (params.layoutMode === "NONE" || params.layoutMode === "HORIZONTAL" || params.layoutMode === "VERTICAL") {
            frame.layoutMode = params.layoutMode;
            applied.layoutMode = params.layoutMode;
          }
          if (typeof params.itemSpacing === "number") {
            frame.itemSpacing = params.itemSpacing;
            applied.itemSpacing = params.itemSpacing;
          }
          if (typeof params.counterAxisSpacing === "number") {
            frame.counterAxisSpacing = params.counterAxisSpacing;
            applied.counterAxisSpacing = params.counterAxisSpacing;
          }
          if (typeof params.paddingTop === "number") {
            frame.paddingTop = params.paddingTop;
            applied.paddingTop = params.paddingTop;
          }
          if (typeof params.paddingRight === "number") {
            frame.paddingRight = params.paddingRight;
            applied.paddingRight = params.paddingRight;
          }
          if (typeof params.paddingBottom === "number") {
            frame.paddingBottom = params.paddingBottom;
            applied.paddingBottom = params.paddingBottom;
          }
          if (typeof params.paddingLeft === "number") {
            frame.paddingLeft = params.paddingLeft;
            applied.paddingLeft = params.paddingLeft;
          }
          if (params.primaryAxisAlignItems === "MIN" || params.primaryAxisAlignItems === "MAX" || params.primaryAxisAlignItems === "CENTER" || params.primaryAxisAlignItems === "SPACE_BETWEEN") {
            frame.primaryAxisAlignItems = params.primaryAxisAlignItems;
            applied.primaryAxisAlignItems = params.primaryAxisAlignItems;
          }
          if (params.counterAxisAlignItems === "MIN" || params.counterAxisAlignItems === "MAX" || params.counterAxisAlignItems === "CENTER" || params.counterAxisAlignItems === "BASELINE") {
            frame.counterAxisAlignItems = params.counterAxisAlignItems;
            applied.counterAxisAlignItems = params.counterAxisAlignItems;
          }
          if (params.primaryAxisSizingMode === "FIXED" || params.primaryAxisSizingMode === "AUTO") {
            frame.primaryAxisSizingMode = params.primaryAxisSizingMode;
            applied.primaryAxisSizingMode = params.primaryAxisSizingMode;
          }
          if (params.counterAxisSizingMode === "FIXED" || params.counterAxisSizingMode === "AUTO") {
            frame.counterAxisSizingMode = params.counterAxisSizingMode;
            applied.counterAxisSizingMode = params.counterAxisSizingMode;
          }
          if (params.layoutWrap === "NO_WRAP" || params.layoutWrap === "WRAP") {
            frame.layoutWrap = params.layoutWrap;
            applied.layoutWrap = params.layoutWrap;
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              nodeName: node.name,
              applied
            }
          };
        }
        case "create_page": {
          const params = request.params ?? {};
          const page = figma.createPage();
          if (typeof params.name === "string") {
            page.name = params.name;
          }
          if (params.setAsCurrent === true) {
            await figma.setCurrentPageAsync(page);
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              pageId: page.id,
              pageName: page.name,
              index: figma.root.children.indexOf(page),
              isCurrentPage: figma.currentPage.id === page.id
            }
          };
        }
        case "create_frame": {
          const params = request.params ?? {};
          const frame = figma.createFrame();
          if (typeof params.name === "string") {
            frame.name = params.name;
          }
          const width = typeof params.width === "number" ? params.width : 100;
          const height = typeof params.height === "number" ? params.height : 100;
          frame.resize(width, height);
          if (typeof params.fillHex === "string") {
            const fillOpacity = typeof params.fillOpacity === "number" ? params.fillOpacity : void 0;
            setSolidFill(frame, params.fillHex, fillOpacity);
          }
          await appendToParentIfProvided(frame, params.parentId);
          positionNode(frame, params.x, params.y);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: frame.id,
              nodeName: frame.name,
              parentId: frame.parent?.id,
              x: frame.x,
              y: frame.y,
              width: frame.width,
              height: frame.height
            }
          };
        }
        case "create_section": {
          const params = request.params ?? {};
          const section = figma.createSection();
          if (typeof params.name === "string") {
            section.name = params.name;
          }
          const width = typeof params.width === "number" ? params.width : 100;
          const height = typeof params.height === "number" ? params.height : 100;
          section.resize(Math.max(width, 0.01), Math.max(height, 0.01));
          if (typeof params.fillHex === "string") {
            const fillOpacity = typeof params.fillOpacity === "number" ? params.fillOpacity : void 0;
            setSolidFill(section, params.fillHex, fillOpacity);
          }
          if (typeof params.sectionContentsHidden === "boolean") {
            section.sectionContentsHidden = params.sectionContentsHidden;
          }
          try {
            await appendToParentIfProvided(section, params.parentId);
          } catch (e) {
            section.remove();
            throw new Error(
              `Failed to append section to parent: ${e instanceof Error ? e.message : String(e)}`
            );
          }
          positionNode(section, params.x, params.y);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: section.id,
              nodeName: section.name,
              parentId: section.parent?.id,
              x: section.x,
              y: section.y,
              width: section.width,
              height: section.height
            }
          };
        }
        case "create_text": {
          const params = request.params ?? {};
          const text = figma.createText();
          const fontFamily = typeof params.fontFamily === "string" ? params.fontFamily : "Inter";
          const fontStyle = typeof params.fontStyle === "string" ? params.fontStyle : "Regular";
          text.fontName = await ensureFont(fontFamily, fontStyle);
          if (typeof params.name === "string") {
            text.name = params.name;
          }
          if (typeof params.characters === "string") {
            text.characters = params.characters;
          }
          if (typeof params.fontSize === "number") {
            text.fontSize = params.fontSize;
          }
          if (typeof params.fillHex === "string") {
            const fillOpacity = typeof params.fillOpacity === "number" ? params.fillOpacity : void 0;
            applyTextFill(text, params.fillHex, fillOpacity);
          }
          if (params.textAlignHorizontal === "LEFT" || params.textAlignHorizontal === "CENTER" || params.textAlignHorizontal === "RIGHT" || params.textAlignHorizontal === "JUSTIFIED") {
            text.textAlignHorizontal = params.textAlignHorizontal;
          }
          if (params.textAutoResize === "NONE" || params.textAutoResize === "WIDTH_AND_HEIGHT" || params.textAutoResize === "HEIGHT" || params.textAutoResize === "TRUNCATE") {
            text.textAutoResize = params.textAutoResize;
          }
          resizeNodeIfSupported(text, params.width, params.height);
          await appendToParentIfProvided(text, params.parentId);
          positionNode(text, params.x, params.y);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: text.id,
              nodeName: text.name,
              parentId: text.parent?.id,
              characters: text.characters,
              x: text.x,
              y: text.y,
              width: text.width,
              height: text.height
            }
          };
        }
        case "create_shape": {
          const params = request.params ?? {};
          const shapeType = params.shapeType;
          let node;
          if (shapeType === "ELLIPSE") {
            node = figma.createEllipse();
          } else if (shapeType === "LINE") {
            node = figma.createLine();
          } else {
            node = figma.createRectangle();
          }
          if (typeof params.name === "string") {
            node.name = params.name;
          }
          resizeNodeIfSupported(node, params.width, params.height);
          if (typeof params.rotation === "number" && "rotation" in node) {
            node.rotation = params.rotation;
          }
          if (shapeType === "LINE" && typeof params.fillHex === "string") {
            throw new Error("LINE shapes do not support fillHex \u2014 use strokeHex instead");
          }
          if (typeof params.fillHex === "string") {
            const fillOpacity = typeof params.fillOpacity === "number" ? params.fillOpacity : void 0;
            setSolidFill(node, params.fillHex, fillOpacity);
          }
          if (shapeType === "LINE" && typeof params.strokeHex !== "string") {
            throw new Error(
              "LINE shapes require strokeHex (lines have no fill, so without a stroke they are invisible)"
            );
          }
          if (typeof params.strokeHex === "string") {
            const shapeId = node.id;
            if (!("strokes" in node)) {
              throw new Error(`Node does not support strokes: ${shapeId}`);
            }
            const strokeOpacity = typeof params.strokeOpacity === "number" ? params.strokeOpacity : void 0;
            setSolidFill(node, params.strokeHex, strokeOpacity, "stroke");
          }
          if ("strokeWeight" in node && typeof params.strokeWeight === "number") {
            node.strokeWeight = params.strokeWeight;
          }
          if (typeof params.cornerRadius === "number" && "cornerRadius" in node) {
            node.cornerRadius = params.cornerRadius;
          }
          await appendToParentIfProvided(node, params.parentId);
          positionNode(node, params.x, params.y);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              nodeName: node.name,
              shapeType,
              parentId: node.parent?.id,
              x: "x" in node ? node.x : void 0,
              y: "y" in node ? node.y : void 0,
              width: "width" in node ? node.width : void 0,
              height: "height" in node ? node.height : void 0
            }
          };
        }
        case "create_image": {
          const params = request.params ?? {};
          if (typeof params.imageBase64 !== "string" || params.imageBase64.length === 0) {
            throw new Error("imageBase64 is required for create_image");
          }
          const image = figma.createImage(decodeBase64ToBytes(params.imageBase64));
          const imageSize = await image.getSizeAsync();
          const node = figma.createRectangle();
          if (typeof params.name === "string") {
            node.name = params.name;
          }
          const aspectRatio = imageSize.width / imageSize.height;
          const width = typeof params.width === "number" ? params.width : typeof params.height === "number" ? params.height * aspectRatio : imageSize.width;
          const height = typeof params.height === "number" ? params.height : typeof params.width === "number" ? params.width / aspectRatio : imageSize.height;
          node.resize(width, height);
          node.fills = [
            {
              type: "IMAGE",
              imageHash: image.hash,
              scaleMode: params.scaleMode === "FIT" ? "FIT" : "FILL"
            }
          ];
          if (typeof params.cornerRadius === "number") {
            node.cornerRadius = params.cornerRadius;
          }
          await appendToParentIfProvided(node, params.parentId);
          positionNode(node, params.x, params.y);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              nodeName: node.name,
              parentId: node.parent?.id,
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              imageHash: image.hash
            }
          };
        }
        case "create_svg": {
          const params = request.params ?? {};
          if (typeof params.svgText !== "string" || params.svgText.trim().length === 0) {
            throw new Error("svgText is required for create_svg");
          }
          const parent = typeof params.parentId === "string" ? await getParentNodeById(params.parentId) : void 0;
          const node = figma.createNodeFromSvg(params.svgText);
          try {
            if (typeof params.name === "string") {
              node.name = params.name;
            }
            resizeNodeIfSupported(node, params.width, params.height);
            parent?.appendChild(node);
            positionNode(node, params.x, params.y);
          } catch (error) {
            node.remove();
            throw error;
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              nodeName: node.name,
              nodeType: node.type,
              parentId: node.parent?.id,
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              childCount: node.children.length
            }
          };
        }
        case "create_sticky": {
          requireFigJamApi("create_sticky", "createSticky", figma.createSticky);
          const sticky = figma.createSticky();
          const params = request.params ?? {};
          if (typeof params.name === "string") {
            sticky.name = params.name;
          }
          if (typeof params.characters === "string") {
            try {
              const currentFont = sticky.text.fontName;
              if (typeof currentFont !== "symbol") {
                await figma.loadFontAsync(currentFont);
              }
              sticky.text.characters = params.characters;
            } catch (e) {
              sticky.remove();
              throw new Error(
                `Failed to set sticky text: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          }
          if (typeof params.isWideWidth === "boolean") {
            sticky.isWideWidth = params.isWideWidth;
          }
          try {
            await appendToParentIfProvided(sticky, params.parentId);
          } catch (e) {
            sticky.remove();
            throw new Error(
              `Failed to append sticky to parent: ${e instanceof Error ? e.message : String(e)}`
            );
          }
          positionNode(sticky, params.x, params.y);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: sticky.id,
              nodeName: sticky.name,
              parentId: sticky.parent?.id,
              x: sticky.x,
              y: sticky.y,
              width: sticky.width,
              height: sticky.height
            }
          };
        }
        case "create_shape_with_text": {
          requireFigJamApi(
            "create_shape_with_text",
            "createShapeWithText",
            figma.createShapeWithText
          );
          const params = request.params ?? {};
          const shape = figma.createShapeWithText();
          if (typeof params.name === "string") {
            shape.name = params.name;
          }
          if (typeof params.shapeType === "string") {
            shape.shapeType = params.shapeType;
          }
          resizeNodeIfSupported(shape, params.width, params.height);
          if (typeof params.rotation === "number") {
            shape.rotation = params.rotation;
          }
          if (typeof params.fillHex === "string") {
            const fillOpacity = typeof params.fillOpacity === "number" ? params.fillOpacity : void 0;
            setSolidFill(shape, params.fillHex, fillOpacity);
          }
          if (typeof params.strokeHex === "string") {
            const strokeOpacity = typeof params.strokeOpacity === "number" ? params.strokeOpacity : void 0;
            setSolidFill(shape, params.strokeHex, strokeOpacity, "stroke");
          }
          if (typeof params.strokeWeight === "number") {
            shape.strokeWeight = params.strokeWeight;
          }
          if (typeof params.textFillHex === "string") {
            const textFillOpacity = typeof params.textFillOpacity === "number" ? params.textFillOpacity : void 0;
            applyTextFill(shape.text, params.textFillHex, textFillOpacity);
          }
          if (typeof params.characters === "string") {
            try {
              const currentFont = shape.text.fontName;
              if (typeof currentFont !== "symbol") {
                await figma.loadFontAsync(currentFont);
              }
              if (typeof params.fontFamily === "string" || typeof params.fontStyle === "string") {
                shape.text.fontName = await ensureFont(
                  typeof params.fontFamily === "string" ? params.fontFamily : "Inter",
                  typeof params.fontStyle === "string" ? params.fontStyle : "Regular"
                );
              }
              shape.text.characters = params.characters;
              if (typeof params.fontSize === "number") {
                shape.text.fontSize = params.fontSize;
              }
            } catch (e) {
              shape.remove();
              throw new Error(
                `Failed to set shape text: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          }
          try {
            await appendToParentIfProvided(shape, params.parentId);
          } catch (e) {
            shape.remove();
            throw new Error(
              `Failed to append shape to parent: ${e instanceof Error ? e.message : String(e)}`
            );
          }
          positionNode(shape, params.x, params.y);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: shape.id,
              nodeName: shape.name,
              parentId: shape.parent?.id,
              shapeType: shape.shapeType,
              characters: shape.text.characters,
              x: shape.x,
              y: shape.y,
              width: shape.width,
              height: shape.height
            }
          };
        }
        case "create_connector": {
          requireFigJamApi("create_connector", "createConnector", figma.createConnector);
          const connector = figma.createConnector();
          const params = request.params ?? {};
          if (typeof params.name === "string") {
            connector.name = params.name;
          }
          try {
            const anchorMagnet = (anchor) => {
              if (anchor === "top") return "TOP";
              if (anchor === "bottom") return "BOTTOM";
              if (anchor === "left") return "LEFT";
              if (anchor === "right") return "RIGHT";
              return "AUTO";
            };
            if (typeof params.startNodeId === "string") {
              connector.connectorStart = {
                endpointNodeId: params.startNodeId,
                magnet: anchorMagnet(params.startAnchor)
              };
            } else if (params.startAnchor !== void 0) {
              throw new Error("startAnchor requires startNodeId");
            } else if (typeof params.startX === "number" && typeof params.startY === "number") {
              connector.connectorStart = {
                position: { x: params.startX, y: params.startY }
              };
            }
            if (typeof params.endNodeId === "string") {
              connector.connectorEnd = {
                endpointNodeId: params.endNodeId,
                magnet: anchorMagnet(params.endAnchor)
              };
            } else if (params.endAnchor !== void 0) {
              throw new Error("endAnchor requires endNodeId");
            } else if (typeof params.endX === "number" && typeof params.endY === "number") {
              connector.connectorEnd = {
                position: { x: params.endX, y: params.endY }
              };
            }
            if (typeof params.strokeWeight === "number") {
              connector.strokeWeight = params.strokeWeight;
            }
            if (typeof params.strokeHex === "string") {
              setSolidFill(connector, params.strokeHex, void 0, "stroke");
            }
            await appendToParentIfProvided(connector, params.parentId);
          } catch (e) {
            connector.remove();
            throw new Error(
              `Failed to create connector: ${e instanceof Error ? e.message : String(e)}`
            );
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: connector.id,
              nodeName: connector.name,
              parentId: connector.parent?.id
            }
          };
        }
        case "import_html_layers": {
          const params = request.params ?? {};
          const root = params.layers;
          if (!root || typeof root !== "object" || typeof root.type !== "string") {
            throw new Error(
              "layers (an html-figma LayerNode tree) is required for import_html_layers"
            );
          }
          const wrapper = figma.createFrame();
          wrapper.name = typeof params.name === "string" && params.name.length > 0 ? params.name : "imported layers";
          const rootWidth = typeof root.width === "number" ? root.width : 100;
          const rootHeight = typeof root.height === "number" ? root.height : 100;
          wrapper.resize(Math.max(rootWidth, 1), Math.max(rootHeight, 1));
          wrapper.fills = [];
          wrapper.clipsContent = true;
          await appendToParentIfProvided(wrapper, params.parentId);
          positionNode(wrapper, params.x, params.y);
          const countLayers = (layer) => {
            if (!layer || typeof layer !== "object") return 0;
            const children = layer.children;
            let total = 1;
            if (Array.isArray(children)) {
              for (const child of children) total += countLayers(child);
            }
            return total;
          };
          const expectedLayerCount = countLayers(root);
          let layerCount = 0;
          await addLayersToFrame([root], wrapper, () => {
            layerCount += 1;
          });
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: wrapper.id,
              nodeName: wrapper.name,
              parentId: wrapper.parent?.id,
              x: wrapper.x,
              y: wrapper.y,
              width: wrapper.width,
              height: wrapper.height,
              layerCount,
              expectedLayerCount,
              ...layerCount < expectedLayerCount ? {
                warning: `Partial import: ${expectedLayerCount - layerCount} of ${expectedLayerCount} layers failed to render (see the plugin console for per-layer errors). Delete node ${wrapper.id} and retry if completeness matters.`
              } : {}
            }
          };
        }
        case "duplicate_nodes": {
          if (!request.nodeIds || request.nodeIds.length === 0) {
            throw new Error("nodeIds is required for duplicate_nodes");
          }
          const duplicates = [];
          for (const nodeId of request.nodeIds) {
            const node = await getSceneNodeById(nodeId);
            if (!("clone" in node) || typeof node.clone !== "function") {
              throw new Error(`Node does not support duplication: ${node.id}`);
            }
            const clone = node.clone();
            duplicates.push({
              sourceNodeId: node.id,
              nodeId: clone.id,
              nodeName: clone.name,
              parentId: clone.parent?.id
            });
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              duplicatedCount: duplicates.length,
              duplicates
            }
          };
        }
        case "duplicate_with_offset": {
          const nodeIds = request.nodeIds;
          if (!nodeIds || nodeIds.length === 0) {
            throw new Error("nodeIds is required for duplicate_with_offset");
          }
          const offsetX = request.params?.offsetX;
          const offsetY = request.params?.offsetY;
          if (typeof offsetX !== "number" || typeof offsetY !== "number") {
            throw new Error("offsetX and offsetY are required for duplicate_with_offset");
          }
          const duplicates = [];
          for (const nodeId of nodeIds) {
            const node = await getSceneNodeById(nodeId);
            if (!("clone" in node) || typeof node.clone !== "function") {
              throw new Error(`Node does not support duplication: ${node.id}`);
            }
            const clone = node.clone();
            if ("x" in clone && "y" in clone) {
              clone.x = clone.x + offsetX;
              clone.y = clone.y + offsetY;
            }
            duplicates.push({
              sourceNodeId: node.id,
              nodeId: clone.id,
              nodeName: clone.name,
              parentId: clone.parent?.id,
              x: "x" in clone ? clone.x : void 0,
              y: "y" in clone ? clone.y : void 0
            });
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              duplicatedCount: duplicates.length,
              duplicates
            }
          };
        }
        case "fit_to_content": {
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) {
            throw new Error("nodeIds is required for fit_to_content");
          }
          const node = await getSceneNodeById(nodeId);
          if (node.type !== "SECTION") {
            throw new Error(
              `fit_to_content only supports SECTION nodes (got ${node.type}: ${nodeId})`
            );
          }
          const paddingParam = request.params?.padding;
          const padding = typeof paddingParam === "number" ? paddingParam : 0;
          if (!(padding >= 0)) {
            throw new Error("padding must be >= 0 for fit_to_content");
          }
          const children = node.children;
          if (children.length > 0) {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const child of children) {
              minX = Math.min(minX, child.x);
              minY = Math.min(minY, child.y);
              maxX = Math.max(maxX, child.x + child.width);
              maxY = Math.max(maxY, child.y + child.height);
            }
            const shiftX = padding - minX;
            const shiftY = padding - minY;
            if (shiftX !== 0 || shiftY !== 0) {
              for (const child of children) {
                child.x = child.x + shiftX;
                child.y = child.y + shiftY;
              }
            }
            const width = maxX - minX + padding * 2;
            const height = maxY - minY + padding * 2;
            node.resizeWithoutConstraints(Math.max(width, 0.01), Math.max(height, 0.01));
          } else {
            const size = Math.max(padding * 2, 0.01);
            node.resizeWithoutConstraints(size, size);
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              nodeName: node.name,
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              childCount: children.length
            }
          };
        }
        case "distribute_horizontally":
        case "distribute_vertically": {
          const horizontal = request.type === "distribute_horizontally";
          const nodeIds = request.nodeIds;
          if (!nodeIds || nodeIds.length < 3) {
            throw new Error(`${request.type} requires at least 3 nodeIds`);
          }
          const nodes = await Promise.all(nodeIds.map((id) => getSceneNodeById(id)));
          const pos = (n) => horizontal ? n.x : n.y;
          const size = (n) => horizontal ? n.width : n.height;
          const setPos = (n, value) => {
            if (horizontal) n.x = value;
            else n.y = value;
          };
          const sorted = [...nodes].sort((a, b) => pos(a) - pos(b));
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          const span = pos(last) + size(last) - pos(first);
          const totalSize = sorted.reduce((sum, n) => sum + size(n), 0);
          const gap = (span - totalSize) / (sorted.length - 1);
          let cursor = pos(first) + size(first);
          const results = [];
          for (let i = 1; i < sorted.length; i++) {
            const node = sorted[i];
            const next = cursor + gap;
            setPos(node, next);
            results.push({ nodeId: node.id, [horizontal ? "x" : "y"]: next });
            cursor = next + size(node);
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              axis: horizontal ? "horizontal" : "vertical",
              gap,
              movedCount: results.length,
              results
            }
          };
        }
        case "align_to_grid": {
          const nodeIds = request.nodeIds;
          if (!nodeIds || nodeIds.length === 0) {
            throw new Error("nodeIds is required for align_to_grid");
          }
          const gridSize = request.params?.gridSize;
          if (typeof gridSize !== "number" || !(gridSize > 0)) {
            throw new Error("gridSize must be a positive number for align_to_grid");
          }
          const nodes = await Promise.all(nodeIds.map((id) => getSceneNodeById(id)));
          const results = nodes.map((node) => {
            node.x = Math.round(node.x / gridSize) * gridSize;
            node.y = Math.round(node.y / gridSize) * gridSize;
            return { nodeId: node.id, x: node.x, y: node.y };
          });
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              gridSize,
              updatedCount: results.length,
              results
            }
          };
        }
        case "place_below":
        case "place_right_of": {
          const below = request.type === "place_below";
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) {
            throw new Error(`nodeIds is required for ${request.type}`);
          }
          const params = request.params ?? {};
          const relativeToId = params.relativeToId;
          if (typeof relativeToId !== "string") {
            throw new Error(`relativeToId is required for ${request.type}`);
          }
          const gap = typeof params.gap === "number" ? params.gap : 0;
          const align = params.align === "center" ? "center" : "start";
          const target = await getSceneNodeById(nodeId);
          const relativeTo = await getSceneNodeById(relativeToId);
          if (below) {
            target.y = relativeTo.y + relativeTo.height + gap;
            target.x = align === "center" ? relativeTo.x + (relativeTo.width - target.width) / 2 : relativeTo.x;
          } else {
            target.x = relativeTo.x + relativeTo.width + gap;
            target.y = align === "center" ? relativeTo.y + (relativeTo.height - target.height) / 2 : relativeTo.y;
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: target.id,
              nodeName: target.name,
              x: target.x,
              y: target.y
            }
          };
        }
        case "reparent_nodes": {
          if (!request.nodeIds || request.nodeIds.length === 0) {
            throw new Error("nodeIds is required for reparent_nodes");
          }
          const parentId = request.params?.parentId;
          if (typeof parentId !== "string") {
            throw new Error("parentId is required for reparent_nodes");
          }
          const parent = await getParentNodeById(parentId);
          const moved = [];
          for (const nodeId of request.nodeIds) {
            const node = await getSceneNodeById(nodeId);
            parent.appendChild(node);
            moved.push({
              nodeId: node.id,
              nodeName: node.name,
              parentId: node.parent?.id
            });
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              movedCount: moved.length,
              moved
            }
          };
        }
        case "group_nodes": {
          if (!request.nodeIds || request.nodeIds.length === 0) {
            throw new Error("nodeIds is required for group_nodes");
          }
          const nodes = await Promise.all(request.nodeIds.map((nodeId) => getSceneNodeById(nodeId)));
          const explicitParentId = request.params?.parentId;
          let parent;
          if (typeof explicitParentId === "string") {
            parent = await getParentNodeById(explicitParentId);
          } else {
            const parents = new Set(nodes.map((n) => n.parent?.id));
            if (parents.size !== 1 || parents.has(void 0)) {
              throw new Error(
                "group_nodes requires all nodes to share a parent, or pass parentId explicitly"
              );
            }
            const sharedParent = nodes[0].parent;
            if (!sharedParent || !supportsChildren(sharedParent)) {
              throw new Error("Shared parent does not support children");
            }
            parent = sharedParent;
          }
          const group = figma.group(nodes, parent);
          const name = request.params?.name;
          if (typeof name === "string") {
            group.name = name;
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: group.id,
              nodeName: group.name,
              parentId: group.parent?.id,
              childIds: group.children.map((c) => c.id)
            }
          };
        }
        case "ungroup_node": {
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) {
            throw new Error("nodeIds is required for ungroup_node");
          }
          const node = await getSceneNodeById(nodeId);
          if (node.type !== "GROUP" && node.type !== "FRAME") {
            throw new Error(`ungroup_node only works on GROUP or FRAME nodes, got ${node.type}`);
          }
          const parentId = node.parent?.id;
          const orphans = figma.ungroup(node);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              parentId,
              orphanIds: orphans.map((o) => o.id)
            }
          };
        }
        case "set_selection": {
          const ids2 = request.nodeIds ?? [];
          const nodes = [];
          for (const id of ids2) {
            nodes.push(await getSceneNodeById(id));
          }
          figma.currentPage.selection = nodes;
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              selectedCount: nodes.length,
              selectedIds: nodes.map((n) => n.id)
            }
          };
        }
        case "scroll_and_zoom_into_view": {
          if (!request.nodeIds || request.nodeIds.length === 0) {
            throw new Error("nodeIds is required for scroll_and_zoom_into_view");
          }
          const nodes = await Promise.all(request.nodeIds.map((nodeId) => getSceneNodeById(nodeId)));
          figma.viewport.scrollAndZoomIntoView(nodes);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              framedCount: nodes.length,
              framedIds: nodes.map((n) => n.id)
            }
          };
        }
        case "delete_nodes": {
          if (request.params?.confirm !== true) {
            throw new Error("delete_nodes requires confirm: true");
          }
          if (!request.nodeIds || request.nodeIds.length === 0) {
            throw new Error("nodeIds is required for delete_nodes");
          }
          const nodes = await Promise.all(request.nodeIds.map((nodeId) => getSceneNodeById(nodeId)));
          const deletions = nodes.map((node) => ({
            nodeId: node.id,
            nodeName: node.name,
            parentId: node.parent?.id
          }));
          for (const node of nodes) {
            node.remove();
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              deletedCount: deletions.length,
              deletions
            }
          };
        }
        case "run_script": {
          const code = request.params?.code;
          if (typeof code !== "string" || code.trim() === "") {
            throw new Error("code is required for run_script");
          }
          if (/\.remove\s*(?:\?\.)?\s*\(/.test(code) && request.params?.allowRemove !== true) {
            throw new Error("run_script: code calls .remove(); pass allowRemove: true to confirm");
          }
          const AsyncFunction = Object.getPrototypeOf(async function() {
          }).constructor;
          const result = await new AsyncFunction("figma", code)(figma);
          let serialized;
          try {
            serialized = JSON.stringify(result, (_key, value) => {
              if (typeof value === "symbol") {
                throw new TypeError("symbol");
              }
              return value;
            });
          } catch {
            throw new Error("run_script: return value must be JSON-serializable");
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: { result: serialized === void 0 ? null : JSON.parse(serialized) }
          };
        }
        case "get_motion_styles": {
          if (isFigJam()) {
            throw new Error("Motion/animation is not available in FigJam");
          }
          const motion = figma.motion;
          if (!motion || typeof motion.figmaAnimationStyles !== "function") {
            throw new Error(
              "figma.motion.figmaAnimationStyles is not available in this Figma version"
            );
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              styles: motion.figmaAnimationStyles()
            }
          };
        }
        case "get_node_motion": {
          if (isFigJam()) {
            throw new Error("Motion/animation is not available in FigJam");
          }
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) throw new Error("nodeIds is required for get_node_motion");
          const node = await getSceneNodeById(nodeId);
          if (!isMotionNode(node)) {
            throw new Error(`Node does not support animations: ${nodeId}`);
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              animationStyles: node.animationStyles,
              animations: node.animations,
              manualKeyframeTracks: node.manualKeyframeTracks,
              timelines: node.timelines
            }
          };
        }
        case "apply_animation_style": {
          if (isFigJam()) {
            throw new Error("Motion/animation is not available in FigJam");
          }
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) throw new Error("nodeIds is required for apply_animation_style");
          const styleId = request.params?.styleId;
          if (typeof styleId !== "string")
            throw new Error("styleId is required for apply_animation_style");
          const node = await getSceneNodeById(nodeId);
          if (!isMotionNode(node)) {
            throw new Error(`Node does not support applyAnimationStyle: ${nodeId}`);
          }
          const animationStyleData = request.params?.animationStyleData;
          node.applyAnimationStyle(styleId, animationStyleData);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              animationStyles: node.animationStyles
            }
          };
        }
        case "remove_animation_style": {
          if (isFigJam()) {
            throw new Error("Motion/animation is not available in FigJam");
          }
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) throw new Error("nodeIds is required for remove_animation_style");
          const node = await getSceneNodeById(nodeId);
          if (!isMotionNode(node)) {
            throw new Error(`Node does not support removeAnimationStyle: ${nodeId}`);
          }
          const animationStyleId = request.params?.animationStyleId;
          if (typeof animationStyleId === "string") {
            node.removeAnimationStyle(animationStyleId);
          } else {
            const appliedStyles = node.animationStyles || [];
            for (const style of appliedStyles) {
              node.removeAnimationStyle(style.id);
            }
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              animationStyles: node.animationStyles
            }
          };
        }
        case "apply_manual_keyframe_track": {
          if (isFigJam()) {
            throw new Error("Motion/animation is not available in FigJam");
          }
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) throw new Error("nodeIds is required for apply_manual_keyframe_track");
          const field = request.params?.field;
          const track = request.params?.track;
          if (!field || !track)
            throw new Error("field and track are required for apply_manual_keyframe_track");
          const node = await getSceneNodeById(nodeId);
          if (!isMotionNode(node)) {
            throw new Error(`Node does not support applyManualKeyframeTrack: ${nodeId}`);
          }
          node.applyManualKeyframeTrack(field, track);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              manualKeyframeTracks: node.manualKeyframeTracks
            }
          };
        }
        case "remove_manual_keyframe_track": {
          if (isFigJam()) {
            throw new Error("Motion/animation is not available in FigJam");
          }
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) throw new Error("nodeIds is required for remove_manual_keyframe_track");
          const field = request.params?.field;
          if (!field) throw new Error("field is required for remove_manual_keyframe_track");
          const node = await getSceneNodeById(nodeId);
          if (!isMotionNode(node)) {
            throw new Error(`Node does not support removeManualKeyframeTrack: ${nodeId}`);
          }
          node.removeManualKeyframeTrack(field);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              manualKeyframeTracks: node.manualKeyframeTracks
            }
          };
        }
        case "set_timeline_duration": {
          if (isFigJam()) {
            throw new Error("Motion/animation is not available in FigJam");
          }
          const nodeId = request.nodeIds && request.nodeIds[0];
          if (!nodeId) throw new Error("nodeIds is required for set_timeline_duration");
          const timelineId = request.params?.timelineId;
          const duration = request.params?.duration;
          if (typeof timelineId !== "string" || typeof duration !== "number") {
            throw new Error("timelineId and duration are required for set_timeline_duration");
          }
          const node = await getSceneNodeById(nodeId);
          if (!isMotionNode(node)) {
            throw new Error(`Node does not support setTimelineDuration: ${nodeId}`);
          }
          node.setTimelineDuration(timelineId, duration);
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              nodeId: node.id,
              timelines: node.timelines
            }
          };
        }
        default: {
          if (isForgeRequestType(request.type)) {
            if (isForgeEditType(request.type)) requireEditorMode(request.type);
            return {
              type: request.type,
              requestId: request.requestId,
              data: await handleForgeRequest(request.type, request.nodeIds, request.params)
            };
          }
          throw new Error(`Unknown request type: ${request.type}`);
        }
      }
    } catch (error) {
      return {
        type: request.type,
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  };
  var UI_WIDTH = 320;
  var UI_EXPANDED_HEIGHT = 180;
  var UI_COLLAPSED_HEIGHT = 36;
  var UI_COLLAPSED_KEY = "ui-collapsed";
  var uiCollapsed = false;
  var applyUiSize = () => {
    figma.ui.resize(UI_WIDTH, uiCollapsed ? UI_COLLAPSED_HEIGHT : UI_EXPANDED_HEIGHT);
  };
  var postUiCollapseState = () => {
    figma.ui.postMessage({ type: "ui-collapse-state", payload: { collapsed: uiCollapsed } });
  };
  figma.showUI('<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>JAgentDesk Figma Link</title>\n    <style>:root {\n  --bg-primary: #0f172b;\n  --text-label: #cad5e2;\n  --text-value: #f1f5f9;\n  --dot-connected: #17b26a;\n  --dot-warn: #f59e0b;\n  --dot-disconnected: #f04438;\n  --text-white: #ffffff;\n}\n\n* {\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n}\n\nbody {\n  margin: 0;\n  font-family: Inter, system-ui, -apple-system, sans-serif;\n  background: var(--bg-primary);\n  color: var(--text-value);\n  font-size: 12px;\n}\n\n#root {\n  padding: 10px 12px;\n}\n\n.row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.title {\n  font-weight: 600;\n  color: var(--text-label);\n  flex: 1;\n}\n\n.dot {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  display: inline-block;\n}\n\n.dot--on {\n  background: var(--dot-connected);\n}\n\n.dot--warn {\n  background: var(--dot-warn);\n}\n\n.dot--off {\n  background: var(--dot-disconnected);\n}\n\n.status {\n  margin-top: 8px;\n  color: var(--text-label);\n}\n\n.status--ok {\n  color: var(--dot-connected);\n}\n\n.status--warn {\n  color: var(--dot-warn);\n}\n\n.status--error {\n  color: var(--dot-disconnected);\n}\n\n.code {\n  margin-top: 6px;\n  font-size: 26px;\n  letter-spacing: 6px;\n  font-variant-numeric: tabular-nums;\n  color: var(--text-white);\n}\n\n.re-pair {\n  border: 1px solid #ffffff22;\n  background: transparent;\n  color: var(--text-label);\n  border-radius: 6px;\n  padding: 3px 8px;\n  font-size: 11px;\n  cursor: pointer;\n}\n\n.re-pair:hover {\n  background: #ffffff14;\n}\n</style>\n  </head>\n  <body>\n    <div id="root">\n      <header class="row">\n        <span id="dot" class="dot dot--off"></span>\n        <span class="title">JAgentDesk Figma Link</span>\n        <button id="re-pair" class="re-pair" type="button">Pair again</button>\n      </header>\n      <p id="status" class="status"></p>\n      <p id="code" class="code"></p>\n    </div>\n    <script>"use strict";\n(() => {\n  // src/plugin-version.ts\n  var PLUGIN_VERSION = "1.0.0";\n  var BRIDGE_PROTOCOL_VERSION = 1;\n\n  // src/ui/main.ts\n  var DAEMON_URL = "ws://127.0.0.1:1995/ws";\n  var RECONNECT_MIN_MS = 500;\n  var RECONNECT_MAX_MS = 5e3;\n  var root = document.getElementById("root");\n  var config = null;\n  var state = { kind: "waiting" };\n  var socket = null;\n  var reconnectTimer = null;\n  var reconnectDelay = RECONNECT_MIN_MS;\n  var stopped = false;\n  var inFlight = /* @__PURE__ */ new Map();\n  var setStatus = (text, tone) => {\n    const status = document.getElementById("status");\n    status.textContent = text;\n    status.className = `status${tone ? ` status--${tone}` : ""}`;\n  };\n  var render = () => {\n    const connected = document.getElementById("dot");\n    const codeBox = document.getElementById("code");\n    switch (state.kind) {\n      case "waiting":\n        connected.className = "dot dot--off";\n        setStatus("Open JAgentDesk to connect.", "");\n        codeBox.textContent = "";\n        break;\n      case "connecting":\n        connected.className = "dot dot--off";\n        setStatus("Connecting to JAgentDesk\\u2026", "");\n        break;\n      case "unpaired":\n        connected.className = "dot dot--warn";\n        setStatus("Enter this code in JAgentDesk to pair:", "warn");\n        codeBox.textContent = state.code;\n        break;\n      case "paired":\n        connected.className = "dot dot--on";\n        setStatus(config ? `Connected \\xB7 ${config.fileName}` : "Connected", "ok");\n        codeBox.textContent = "";\n        break;\n      case "blocked":\n        connected.className = "dot dot--warn";\n        setStatus(`Update JAgentDesk \\u2014 ${state.reason} (needs v${state.requiredVersion})`, "warn");\n        codeBox.textContent = "";\n        break;\n      case "rejected":\n        connected.className = "dot dot--off";\n        setStatus(`Rejected by JAgentDesk: ${state.reason}`, "error");\n        codeBox.textContent = "";\n        break;\n      case "offline":\n        connected.className = "dot dot--off";\n        setStatus("JAgentDesk is not running on this machine.", "");\n        break;\n    }\n  };\n  var send = (frame) => {\n    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));\n  };\n  var hello = () => {\n    if (!config) return;\n    send({\n      type: "hello",\n      name: "JAgentDesk Figma Link",\n      version: PLUGIN_VERSION,\n      protocol: BRIDGE_PROTOCOL_VERSION,\n      fileKey: config.fileKey,\n      fileName: config.fileName,\n      manager: config.manager,\n      instanceId: config.instanceId,\n      ...config.pairingId ? { pairingId: config.pairingId } : {},\n      ...config.pairingKey ? { pairingKey: config.pairingKey } : {}\n    });\n  };\n  var connect = () => {\n    if (!config || stopped) return;\n    state = { kind: "connecting" };\n    render();\n    const url = `${DAEMON_URL}?version=${encodeURIComponent(PLUGIN_VERSION)}&protocol=${BRIDGE_PROTOCOL_VERSION}&fileKey=${encodeURIComponent(config.fileKey)}&fileName=${encodeURIComponent(config.fileName)}`;\n    const ws = new WebSocket(url);\n    socket = ws;\n    ws.onopen = () => {\n      reconnectDelay = RECONNECT_MIN_MS;\n      hello();\n    };\n    ws.onmessage = (event) => {\n      let frame;\n      try {\n        frame = JSON.parse(String(event.data));\n      } catch {\n        return;\n      }\n      switch (frame.type) {\n        case "hello_ack":\n          state = { kind: "paired" };\n          render();\n          return;\n        case "pairing_required":\n          state = {\n            kind: "unpaired",\n            code: String(frame.code ?? ""),\n            expiresAt_ms: Number(frame.expiresAt_ms ?? 0)\n          };\n          render();\n          return;\n        case "pairing_granted": {\n          state = { kind: "paired" };\n          const pairingId = String(frame.pairingId ?? config?.pairingId ?? "");\n          const pairingKey = String(frame.pairingKey ?? "");\n          if (config) {\n            config = { ...config, pairingId, pairingKey };\n          }\n          parent.postMessage({ pluginMessage: { type: "ui-store-pairing", pairingId, pairingKey } }, "*");\n          render();\n          return;\n        }\n        case "pairing_rejected":\n          return;\n        case "link_blocked":\n          state = {\n            kind: "blocked",\n            reason: String(frame.reason ?? "version mismatch"),\n            requiredVersion: String(frame.requiredVersion ?? "?")\n          };\n          render();\n          return;\n        case "link_rejected":\n          stopped = true;\n          state = { kind: "rejected", reason: String(frame.reason ?? "rejected") };\n          render();\n          return;\n        case "ping":\n          send({ type: "pong", sentAt: frame.sentAt });\n          return;\n        case "request": {\n          const requestId = String(frame.requestId ?? "");\n          const toolName = String(frame.toolName ?? "");\n          inFlight.set(requestId, toolName);\n          parent.postMessage(\n            {\n              pluginMessage: {\n                type: "server-request",\n                payload: {\n                  type: toolName,\n                  requestId,\n                  nodeIds: frame.nodeIds,\n                  params: frame.params\n                }\n              }\n            },\n            "*"\n          );\n          return;\n        }\n        default:\n          return;\n      }\n    };\n    ws.onclose = () => {\n      socket = null;\n      if (stopped) return;\n      for (const [requestId] of inFlight) {\n        send({ type: "response", requestId, ok: false, message: "link closed" });\n      }\n      inFlight.clear();\n      state = { kind: "offline" };\n      render();\n      reconnectTimer = setTimeout(connect, reconnectDelay);\n      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);\n    };\n    ws.onerror = () => {\n    };\n  };\n  var onSandboxMessage = (message) => {\n    if (message.type === "plugin-config") {\n      config = message.payload;\n      if (!socket && !stopped) connect();\n      return;\n    }\n    if (message.type === "plugin-status") {\n      const payload = message.payload;\n      if (config) {\n        config = { ...config, fileName: String(payload.fileName ?? config.fileName), fileKey: String(payload.fileKey ?? config.fileKey) };\n      }\n      if (socket && socket.readyState === WebSocket.OPEN) {\n        send({ type: "plugin_status", ...payload });\n      }\n      return;\n    }\n    if (message.requestId && inFlight.has(String(message.requestId))) {\n      const requestId = String(message.requestId);\n      inFlight.delete(requestId);\n      send({\n        type: "response",\n        requestId,\n        ok: !message.error,\n        message: typeof message.error === "string" ? message.error : "ok",\n        data: message.data\n      });\n    }\n  };\n  window.onmessage = (event) => {\n    const pluginMessage = event.data?.pluginMessage;\n    if (pluginMessage) onSandboxMessage(pluginMessage);\n  };\n  var pairButton = document.getElementById("re-pair");\n  pairButton.addEventListener("click", () => {\n    stopped = false;\n    reconnectDelay = RECONNECT_MIN_MS;\n    parent.postMessage({ pluginMessage: { type: "ui-clear-pairing" } }, "*");\n    config = config ? { ...config, pairingId: void 0, pairingKey: void 0 } : config;\n    if (socket) socket.close();\n    else connect();\n  });\n  parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");\n  render();\n})();\n<\/script>\n  </body>\n</html>\n', { width: UI_WIDTH, height: UI_EXPANDED_HEIGHT, visible: false });
  var PAIRING_ID_KEY = "jadlink.pairingId";
  var PAIRING_KEY_KEY = "jadlink.pairingKey";
  var INSTANCE_ID_KEY = "jadlink.instanceId";
  var pairingId;
  var pairingKey;
  var instanceId = "";
  var ensureInstanceId = async () => {
    try {
      const stored = await figma.clientStorage.getAsync(INSTANCE_ID_KEY);
      if (typeof stored === "string" && stored) {
        instanceId = stored;
        return;
      }
    } catch {
    }
    instanceId = `plugin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await figma.clientStorage.setAsync(INSTANCE_ID_KEY, instanceId).catch(() => void 0);
  };
  var loadPairing = Promise.all([
    figma.clientStorage.getAsync(PAIRING_ID_KEY).catch(() => void 0),
    figma.clientStorage.getAsync(PAIRING_KEY_KEY).catch(() => void 0)
  ]).then(([id, key]) => {
    pairingId = typeof id === "string" && id ? id : void 0;
    pairingKey = typeof key === "string" && key ? key : void 0;
  });
  var postPluginConfig = () => {
    figma.ui.postMessage({
      type: "plugin-config",
      payload: {
        pluginVersion: PLUGIN_VERSION,
        instanceId,
        pairingId,
        pairingKey,
        fileName: figma.root.name,
        fileKey: getFileKey(),
        manager: figma.currentUser?.name ?? figma.currentUser?.id ?? "Figma user"
      }
    });
  };
  figma.clientStorage.getAsync(UI_COLLAPSED_KEY).then((stored) => {
    uiCollapsed = stored === true;
  }).catch(() => {
    uiCollapsed = false;
  }).then(() => {
    applyUiSize();
    postUiCollapseState();
    figma.ui.show();
  });
  void ensureInstanceId();
  sendStatus();
  figma.on("selectionchange", () => {
    sendStatus();
  });
  figma.on("currentpagechange", () => {
    sendStatus();
  });
  figma.on("documentchange", (event) => {
    sendStatus(event.nodeIds ?? []);
  });
  figma.ui.onmessage = async (message) => {
    if (message.type === "ui-ready") {
      sendStatus();
      await loadPairing;
      postPluginConfig();
      return;
    }
    if (message.type === "ui-store-pairing") {
      pairingId = typeof message.pairingId === "string" ? message.pairingId : pairingId;
      pairingKey = typeof message.pairingKey === "string" ? message.pairingKey : pairingKey;
      await Promise.all([
        figma.clientStorage.setAsync(PAIRING_ID_KEY, pairingId ?? null),
        figma.clientStorage.setAsync(PAIRING_KEY_KEY, pairingKey ?? null)
      ]);
      return;
    }
    if (message.type === "ui-clear-pairing") {
      pairingId = void 0;
      pairingKey = void 0;
      await Promise.all([
        figma.clientStorage.setAsync(PAIRING_ID_KEY, null),
        figma.clientStorage.setAsync(PAIRING_KEY_KEY, null)
      ]);
      return;
    }
    if (message.type === "request-ui-state") {
      postUiCollapseState();
      return;
    }
    if (message.type === "set-ui-collapsed") {
      uiCollapsed = message.collapsed === true;
      applyUiSize();
      figma.clientStorage.setAsync(UI_COLLAPSED_KEY, uiCollapsed).catch(() => {
      });
      return;
    }
    if (message.type === "server-request") {
      const response = await handleRequest(message.payload);
      try {
        figma.ui.postMessage(response);
      } catch (err) {
        figma.ui.postMessage({
          type: response.type,
          requestId: response.requestId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  };
})();
