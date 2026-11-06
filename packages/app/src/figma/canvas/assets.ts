import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";

// Byte-backed assets for the renderer (spec 32.5.1): image fills, fallback rasters / frame
// thumbnails, and fonts. Nothing here fetches — the caller injects loaders that wrap the
// figma.file.imageFills / figma.file.render / figma.fonts.get RPCs, so the caches stay pure and
// the wire carries no Figma or S3 URLs. Decoded entries are DOM images on web/Electron; on
// mobile the byte source feeds RN <Image> data URIs instead (canvas-view's native branch).
// Retention is bounded by the paint: beginDraw()/endDraw() observe the keys a synchronous draw
// actually used and reconcile everything else away, so panning cannot accumulate the world.

export const MAX_REFS_PER_REQUEST = 20;

export type LoadBytes = (ids: readonly string[]) => Promise<Record<string, FigmaBytes | null>>;

/** The decoded-image surface the caches need (an HTMLImageElement on web, faked in tests). */
export interface DecodedImageLike {
  addEventListener: (type: "load" | "error", listener: () => void) => void;
  [key: string]: unknown;
}

export type MakeImage = (dataUrl: string) => DecodedImageLike | null;

/** Per-ref attempt state. The object itself is the attempt identity — see ByteImageCache. */
interface RefRecord {
  phase: "queued" | "loading" | "ready" | "failed";
  image: DecodedImageLike | null;
}

export function bytesToDataUrl(bytes: FigmaBytes): string {
  return `data:${bytes.mimeType};base64,${bytes.dataBase64}`;
}

/** A ref/nodeId → decoded image cache with request coalescing at the wire's 20-id limit. */
export class ByteImageCache {
  /**
   * One record per ref attempts ever made this scope. The RECORD OBJECT is the attempt identity:
   * an async settle only commits while `records.get(ref)` is still the very record it started
   * with, so a success/failure/decode from a retired (unobserved at endDraw) or recreated key can
   * neither repopulate nor notify.
   */
  private readonly records = new Map<string, RefRecord>();
  // Keys seen through get()/request() since the open beginDraw(). Every endDraw reconciles
  // against it — no exempt rules: an unobserved decoded image, pending attempt or failed ref is
  // retired, which is what bounds retention to the current view (spec 32.5.1).
  private draw: Set<string> | null = null;
  private flushScheduled = false;
  // Bumped by clear(). A settle from a batch issued before the clear belongs to a dead
  // scope (reconnect, unmount, version switch): it must not repopulate the maps or notify
  // the now-current generation, or every paint after a failure re-enters the fetch loop.
  private generation = 0;

  constructor(
    private readonly loadBytes: LoadBytes,
    private readonly makeImage: MakeImage | null,
    private readonly onReady: () => void = () => undefined,
  ) {}

  /**
   * Open a synchronous paint for reconciliation. Idempotent while open (a second begin keeps the
   * observation set). Standalone callers that never begin/end behave like before: entries simply
   * accumulate until clear().
   */
  beginDraw(): void {
    if (!this.draw) this.draw = new Set();
  }

  /**
   * Close the paint and reconcile: every key the draw did NOT observe is retired — decoded
   * images, pending attempts and failed refs alike. An empty draw clears everything. Returns the
   * retired refs (diagnostics/tests); without an open draw it is a no-op.
   */
  endDraw(): Set<string> {
    const observed = this.draw;
    this.draw = null;
    const retired = new Set<string>();
    if (!observed) return retired;
    for (const key of this.records.keys()) {
      if (observed.has(key)) continue;
      this.records.delete(key);
      retired.add(key);
    }
    return retired;
  }

  /** The decoded image for a ref, or null while it loads (loading starts on first miss). */
  get(ref: string): DecodedImageLike | null {
    if (!ref) return null;
    this.observe(ref);
    const record = this.records.get(ref);
    if (record) return record.phase === "ready" ? record.image : null;
    this.enqueue(ref);
    this.scheduleFlush();
    return null;
  }

  /** Begin fetching refs; safe to call every frame. Batches never exceed 20 per request. */
  request(...refs: string[]): void {
    for (const ref of refs) {
      if (!ref) continue;
      // Observed even when already known: a visible failed ref must survive reconciliation, or
      // every paint after the failure would refetch (the paint/network feedback loop).
      this.observe(ref);
      if (!this.records.has(ref)) this.enqueue(ref);
    }
    this.scheduleFlush();
  }

  /** Diagnostic: is a decoded image cached? Probing must not count as observing. */
  has(ref: string): boolean {
    return this.records.get(ref)?.phase === "ready";
  }

  clear(): void {
    this.generation += 1;
    this.records.clear();
    this.draw = null;
  }

  private observe(ref: string): void {
    this.draw?.add(ref);
  }

  private enqueue(ref: string): void {
    this.records.set(ref, { phase: "queued", image: null });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    let hasQueued = false;
    for (const record of this.records.values()) {
      if (record.phase === "queued") {
        hasQueued = true;
        break;
      }
    }
    if (!hasQueued) return;
    this.flushScheduled = true;
    queueMicrotask(() => void this.flush());
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const generation = this.generation;
    // All post-await writes check this: a clear() mid-flight retires the whole batch.
    const current = () => generation === this.generation;
    for (;;) {
      const batch: [string, RefRecord][] = [];
      for (const [ref, record] of this.records) {
        if (record.phase !== "queued") continue;
        batch.push([ref, record]);
        if (batch.length === MAX_REFS_PER_REQUEST) break;
      }
      if (batch.length === 0) return;
      for (const [, record] of batch) record.phase = "loading";
      let result: Record<string, FigmaBytes | null>;
      try {
        result = await this.loadBytes(batch.map(([ref]) => ref));
      } catch {
        if (!current()) return;
        // Transport failure is a cached failure like any other: retried on clear, not per paint.
        for (const [ref, record] of batch) {
          if (this.records.get(ref) === record) record.phase = "failed";
        }
        continue;
      }
      if (!current()) return;
      let committed = false;
      for (const [ref, record] of batch) {
        // A reconcile (or clear) retired this attempt, or a later ask recreated it: the record
        // identity is the only check that tells those apart, and it settles only the live attempt.
        if (this.records.get(ref) !== record) continue;
        committed = true;
        const bytes = result[ref];
        if (!bytes || !this.makeImage) {
          record.phase = "failed";
          continue;
        }
        const image = this.makeImage(bytesToDataUrl(bytes));
        if (!image) {
          record.phase = "failed";
          continue;
        }
        image.addEventListener("load", () => {
          if (current() && this.records.get(ref) === record) this.onReady();
        });
        image.addEventListener("error", () => {
          // A decode error is terminal for this attempt: get() and request() honor failed, so
          // the renderer's per-paint onMissing cannot resurrect it while it stays observed.
          if (!current() || this.records.get(ref) !== record) return;
          record.phase = "failed";
          record.image = null;
          this.onReady();
        });
        record.phase = "ready";
        record.image = image;
      }
      // Only a batch that actually committed something may repaint; a fully retired batch must
      // not notify the current draw.
      if (committed) this.onReady();
    }
  }
}

/**
 * `figma.fonts.get` bytes → a loaded font the canvas context can use (spec 32.5.1). Registration
 * is injected (`register`) so web adds a FontFace, mobile hands bytes to Skia, and tests fake it.
 * A family/style is attempted at most once while it stays observed by the open draw (or while no
 * draw lifecycle is used at all): the draw calls `fontAvailable` every paint, and a failed/null
 * attempt that refetched each frame would re-enter the load→notify→paint loop forever. endDraw
 * retires fonts the paint did not use — including successful faces, which the owner then removes
 * from `document.fonts` — so offscreen text does not pin its font. clear() (reconnect, unmount,
 * scope swap) retires everything.
 */
export class FontCache {
  /** One record per family/style attempt; the object identity guards every async settle. */
  private readonly records = new Map<string, FontRecord>();
  private draw: Set<string> | null = null;
  // Bumped by clear(). A settle captured before the clear is stale: it must not repopulate the
  // maps or notify the now-current generation, or a cleared/reconnected cache resurrects ghosts.
  private generation = 0;

  constructor(
    private readonly loadFont: (family: string, style: string) => Promise<FigmaBytes | null>,
    private readonly register: (
      family: string,
      style: string,
      dataUrl: string,
      /** Live only while this attempt's scope AND record are current; the registrar must
       * commit no DOM side effect once the owner cleared or reconciled the key away. */
      isCurrent: () => boolean,
    ) => Promise<boolean>,
    private readonly onReady: () => void = () => undefined,
  ) {}

  /** Open a paint: every fontAvailable() until the matching endDraw marks the key used. */
  beginDraw(): void {
    if (!this.draw) this.draw = new Set();
  }

  /**
   * Close the paint and retire every family/style the draw did not ask for — loaded faces and
   * pending attempts alike (an empty draw clears everything). Returns the retired keys so the
   * owner can release their FontFaces from document.fonts.
   */
  endDraw(): Set<string> {
    const observed = this.draw;
    this.draw = null;
    const retired = new Set<string>();
    if (!observed) return retired;
    for (const key of this.records.keys()) {
      if (observed.has(key)) continue;
      this.records.delete(key);
      retired.add(key);
    }
    return retired;
  }

  fontAvailable(family: string, style: string): boolean {
    const key = `${family}\u0000${style}`;
    // Asking IS observing: a visible font's terminal result (true OR false) and its in-flight
    // attempt both survive every reconciliation while the paint keeps using them.
    this.draw?.add(key);
    const record = this.records.get(key);
    if (record) return record.phase === "settled" && record.ok;
    const started: FontRecord = { phase: "loading", ok: false };
    this.records.set(key, started);
    void this.load(key, started, family, style, this.generation);
    return false;
  }

  private async load(
    key: string,
    record: FontRecord,
    family: string,
    style: string,
    generation: number,
  ): Promise<void> {
    let ok = false;
    // Current only while the scope is alive AND this exact record is the cache's entry: an
    // endDraw reconcile (or clear) that retired the key makes every later check fail, so the
    // stale attempt can neither register a face, repopulate, nor notify the current draw.
    const current = () => generation === this.generation && this.records.get(key) === record;
    try {
      const bytes = await this.loadFont(family, style);
      // A retire mid-fetch drops this attempt before it can touch the DOM registrar (adding a
      // FontFace nobody owns any more).
      if (!current()) return;
      // The registrar owns the rest of the async window (face.load() etc): it must re-check
      // `current` itself, or a scope swap during that await leaks a face into FontFaceSet.
      ok = bytes ? await this.register(family, style, bytesToDataUrl(bytes), current) : false;
    } catch {
      ok = false;
    }
    // A settle from a dead scope or a retired record is dropped: no repopulate, no notify.
    if (!current()) return;
    record.phase = "settled";
    record.ok = ok;
    this.onReady();
  }

  clear(): void {
    this.generation += 1;
    this.records.clear();
    this.draw = null;
  }
}

interface FontRecord {
  phase: "loading" | "settled";
  ok: boolean;
}
