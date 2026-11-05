import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";

// Byte-backed assets for the renderer (spec 32.5.1): image fills, fallback rasters / frame
// thumbnails, and fonts. Nothing here fetches — the caller injects loaders that wrap the
// figma.file.imageFills / figma.file.render / figma.fonts.get RPCs, so the caches stay pure and
// the wire carries no Figma or S3 URLs. Decoded entries are DOM images on web/Electron; on
// mobile the byte source feeds RN <Image> data URIs instead (canvas-view's native branch).

export const MAX_REFS_PER_REQUEST = 20;

export type LoadBytes = (ids: readonly string[]) => Promise<Record<string, FigmaBytes | null>>;

/** The decoded-image surface the caches need (an HTMLImageElement on web, faked in tests). */
export interface DecodedImageLike {
  addEventListener: (type: "load" | "error", listener: () => void) => void;
  [key: string]: unknown;
}

export type MakeImage = (dataUrl: string) => DecodedImageLike | null;

export function bytesToDataUrl(bytes: FigmaBytes): string {
  return `data:${bytes.mimeType};base64,${bytes.dataBase64}`;
}

/** A ref/nodeId → decoded image cache with request coalescing at the wire's 20-id limit. */
export class ByteImageCache {
  private readonly images = new Map<string, DecodedImageLike>();
  private readonly loading = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly queued = new Set<string>();
  private flushScheduled = false;

  constructor(
    private readonly loadBytes: LoadBytes,
    private readonly makeImage: MakeImage | null,
    private readonly onReady: () => void = () => undefined,
  ) {}

  /** The decoded image for a ref, or null while it loads (loading starts on first miss). */
  get(ref: string): DecodedImageLike | null {
    if (!ref) return null;
    const hit = this.images.get(ref);
    if (hit) return hit;
    if (!this.loading.has(ref) && !this.failed.has(ref)) this.request(ref);
    return null;
  }

  /** Begin fetching refs; safe to call every frame. Batches never exceed 20 per request. */
  request(...refs: string[]): void {
    let scheduled = false;
    for (const ref of refs) {
      if (!ref || this.images.has(ref) || this.loading.has(ref) || this.queued.has(ref)) continue;
      this.queued.add(ref);
      scheduled = true;
    }
    if (scheduled && !this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => void this.flush());
    }
  }

  has(ref: string): boolean {
    return this.images.has(ref);
  }

  clear(): void {
    this.images.clear();
    this.loading.clear();
    this.failed.clear();
    this.queued.clear();
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const refs = [...this.queued];
    this.queued.clear();
    for (let i = 0; i < refs.length; i += MAX_REFS_PER_REQUEST) {
      const batch = refs.slice(i, i + MAX_REFS_PER_REQUEST);
      for (const ref of batch) this.loading.add(ref);
      let result: Record<string, FigmaBytes | null>;
      try {
        result = await this.loadBytes(batch);
      } catch {
        for (const ref of batch) this.loading.delete(ref);
        continue;
      }
      for (const ref of batch) {
        const bytes = result[ref];
        this.loading.delete(ref);
        if (!bytes || !this.makeImage) {
          this.failed.add(ref);
          continue;
        }
        const image = this.makeImage(bytesToDataUrl(bytes));
        if (!image) {
          this.failed.add(ref);
          continue;
        }
        image.addEventListener("load", () => this.onReady());
        image.addEventListener("error", () => {
          this.failed.add(ref);
          this.images.delete(ref);
          this.onReady();
        });
        this.images.set(ref, image);
      }
      this.onReady();
    }
    if (this.queued.size > 0) {
      this.flushScheduled = true;
      queueMicrotask(() => void this.flush());
    }
  }
}

/**
 * `figma.fonts.get` bytes → a loaded font the canvas context can use (spec 32.5.1). Registration
 * is injected (`register`) so web adds a FontFace, mobile hands bytes to Skia, and tests fake it.
 */
export class FontCache {
  private readonly available = new Map<string, boolean>();
  private readonly loading = new Set<string>();

  constructor(
    private readonly loadFont: (family: string, style: string) => Promise<FigmaBytes | null>,
    private readonly register: (family: string, style: string, dataUrl: string) => Promise<boolean>,
    private readonly onReady: () => void = () => undefined,
  ) {}

  fontAvailable(family: string, style: string): boolean {
    const key = `${family}\u0000${style}`;
    if (this.available.get(key) === true) return true;
    if (!this.loading.has(key)) {
      this.loading.add(key);
      void this.load(key, family, style);
    }
    return this.available.get(key) === true;
  }

  private async load(key: string, family: string, style: string): Promise<void> {
    try {
      const bytes = await this.loadFont(family, style);
      this.available.set(
        key,
        bytes ? await this.register(family, style, bytesToDataUrl(bytes)) : false,
      );
    } catch {
      this.available.set(key, false);
    } finally {
      this.loading.delete(key);
      this.onReady();
    }
  }

  clear(): void {
    this.available.clear();
    this.loading.clear();
  }
}
