// Bounded quality checks and explicit, revision-checked build receipts.
// No product nodes are created, repaired or deleted by these tools.
type Params = Record<string, unknown>;
const CHECKPOINT_PREFIX = "forge.checkpoint.";
const keyOf = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    throw new Error("checkpoint key must be 1–80 letters, numbers, _ or -");
  return CHECKPOINT_PREFIX + value;
};
const finiteLimit = (v: unknown, fallback: number, max: number) => {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max)
    throw new Error(`limit must be an integer between 1 and ${max}`);
  return v;
};
const resolveNode = async (id: unknown) => {
  if (typeof id !== "string") throw new Error("node ID must be a string");
  const n = await figma.getNodeByIdAsync(id);
  if (!n) throw new Error(`Node not found: ${id}`);
  return n;
};

export async function qualityPreflight(p: Params) {
  const requested = (p.fonts ?? []) as FontName[];
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
    let error: string | undefined;
    if (installed)
      try {
        await figma.loadFontAsync(face);
        loadable = true;
      } catch (e) {
        error = String(e);
      }
    fonts.push({ ...face, installed, loadable, ...(error ? { error } : {}) });
  }
  const roots = [];
  const ids = p.roots ?? [];
  if (!Array.isArray(ids) || ids.length > 50) throw new Error("At most 50 node IDs");
  for (const id of ids) {
    const n = await resolveNode(id);
    roots.push({ id: n.id, name: n.name, type: n.type });
  }
  return {
    file: { name: figma.root.name, pageId: figma.currentPage.id, pageName: figma.currentPage.name },
    roots,
    fonts,
    ready: fonts.every((f) => f.loadable),
    note: "Font availability/loading does not prove glyph rendering. Audit actual text nodes after building; never silently substitute a different font.",
  };
}

export async function qualityAudit(p: Params) {
  const maxNodes = finiteLimit(p.maxNodes, 2000, 20000);
  const deadline = Date.now() + finiteLimit(p.maxDurationMs, 5000, 30000);
  const timeout = new Error("Audit time budget reached");
  let timedOut = false;
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeout), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const maxIssues = finiteLimit(p.maxIssues, 100, 1000);
  const root = p.rootId ? await resolveNode(p.rootId) : figma.currentPage;
  if (root.type === "DOCUMENT")
    throw new Error("Audit a page or scene subtree, not the whole document");
  const radii = p.allowedRadii as number[] | undefined;
  const fontSizes = p.allowedFontSizes as number[] | undefined;
  for (const scale of [radii, fontSizes])
    if (
      scale !== undefined &&
      (!Array.isArray(scale) ||
        scale.length > 100 ||
        scale.some((v) => typeof v !== "number" || !Number.isFinite(v)))
    )
      throw new Error("Token scales must be finite numeric arrays of at most 100 values");
  const issues: Array<{ nodeId: string; name: string; code: string; detail: string }> = [];
  let issueCount = 0;
  let visited = 0;
  const counts: Record<string, number> = {};
  const add = (n: BaseNode, code: string, detail: string) => {
    issueCount++;
    counts[code] = (counts[code] ?? 0) + 1;
    if (issues.length < maxIssues) issues.push({ nodeId: n.id, name: n.name, code, detail });
  };
  const stack: BaseNode[] = [root];
  try {
    while (stack.length && visited < maxNodes) {
      if (Date.now() >= deadline) throw timeout;
      const n = stack.pop()!;
      visited++;
      if ("visible" in n && !n.visible) continue;
      if ("children" in n) stack.push(...n.children);
      if (n.type === "TEXT") {
        if (n.hasMissingFont)
          add(n, "missing_font", "Resolve/install the exact font face; do not silently replace it");
        if (n.characters.trim() && (n.width <= 0 || n.height <= 0))
          add(n, "zero_size_text", `${n.width} × ${n.height}`);
        if (n.characters.trim() && n.textStyleId === "")
          add(n, "unstyled_text", "No text style bound (may be intentional)");
        if (fontSizes && typeof n.fontSize === "number" && !fontSizes.includes(n.fontSize))
          add(n, "off_scale_font_size", String(n.fontSize));
      }
      if (
        radii &&
        "cornerRadius" in n &&
        typeof n.cornerRadius === "number" &&
        !radii.includes(n.cornerRadius)
      )
        add(n, "off_scale_radius", String(n.cornerRadius));
      if (n.type === "INSTANCE") {
        try {
          if (!(await bounded(n.getMainComponentAsync())))
            add(n, "missing_main", "Instance main component cannot be resolved");
        } catch (e) {
          if (e === timeout) throw e;
          add(n, "main_lookup_failed", String(e));
        }
      }
      if ("reactions" in n) {
        for (const r of n.reactions) {
          for (const a of r.actions ?? []) {
            if (
              a.type === "NODE" &&
              a.destinationId &&
              !(await bounded(figma.getNodeByIdAsync(a.destinationId)))
            )
              add(n, "dead_reaction", a.destinationId);
          }
        }
      }
      if (
        "x" in n &&
        "width" in n &&
        n.parent &&
        "clipsContent" in n.parent &&
        n.parent.clipsContent &&
        "width" in n.parent
      ) {
        // Conservative local bounds: rotations/transforms need visual review.
        if (
          (!("rotation" in n) || n.rotation === 0) &&
          (n.x < -0.5 ||
            n.y < -0.5 ||
            n.x + n.width > n.parent.width + 0.5 ||
            n.y + n.height > n.parent.height + 0.5)
        )
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
    note: "Structural findings, not visual approval. Hidden branches skipped. Mixed text runs, glyph overflow inside text boxes, arbitrary transforms and URL reaction destinations require separate review. Export a fresh screenshot after mutations.",
  };
}

export async function checkpointGet(p: Params) {
  const raw = figma.root.getPluginData(keyOf(p.key));
  if (!raw) return { key: p.key, revision: 0, receipt: null };
  const receipt = JSON.parse(raw);
  const nodes = [];
  for (const id of receipt.nodeIds) {
    const n = await figma.getNodeByIdAsync(id);
    nodes.push({ id, exists: Boolean(n), ...(n ? { name: n.name, type: n.type } : {}) });
  }
  return { key: p.key, revision: receipt.revision, receipt, nodes };
}

// Per-key serialization is necessary because async node validation yields to other requests.
const checkpointQueues = new Map<string, Promise<unknown>>();
export async function checkpointCommit(p: Params) {
  const key = keyOf(p.key);
  const previous = checkpointQueues.get(key) ?? Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      if (typeof p.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.operationId))
        throw new Error("operationId is required (1–100 letters, numbers, _ or -)");
      if (
        typeof p.expectedRevision !== "number" ||
        !Number.isInteger(p.expectedRevision) ||
        p.expectedRevision < 0
      )
        throw new Error("expectedRevision must be a non-negative integer");
      if (
        !Array.isArray(p.roots) ||
        p.roots.length > 500 ||
        p.roots.some((id) => typeof id !== "string")
      )
        throw new Error("roots must be an array of at most 500 IDs");
      if (p.note !== undefined && (typeof p.note !== "string" || p.note.length > 4000))
        throw new Error("note must be at most 4000 characters");
      const body = { nodeIds: [...new Set(p.roots)].sort(), note: p.note ?? "" };
      const raw = figma.root.getPluginData(key);
      const current = raw ? JSON.parse(raw) : null;
      if (current?.operationId === p.operationId) {
        if (
          JSON.stringify(body) !== JSON.stringify({ nodeIds: current.nodeIds, note: current.note })
        )
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
        savedAt: new Date().toISOString(),
      };
      if (JSON.stringify(receipt).length > 50_000) throw new Error("Checkpoint too large");
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
