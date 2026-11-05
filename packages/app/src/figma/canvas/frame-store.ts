import type { FigmaComponentMeta, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { chunkIds, LruCache, MAX_IDS_PER_REQUEST } from "./batching";

// Lazy viewport loading (spec 32.5.1): frames entering the viewport are requested through
// `figma.file.nodes` in batches of ≤ 50 ids, and loaded subtrees live in an LRU so panning back
// costs nothing and memory stays flat on thousand-frame files. The fetcher is injected so the
// tests run without a client, and the canvas can swap in the Figma Link path.

export interface NodeBatch {
  nodes: Record<string, FigmaNode | null>;
  /** Component metadata referenced by the batch (REST `components`); empty for Link paths. */
  components: Record<string, FigmaComponentMeta>;
}

export type FetchNodeSubtrees = (ids: readonly string[]) => Promise<NodeBatch>;

export class FrameStore {
  private readonly cache: LruCache<FigmaNode | null>;
  private readonly components = new Map<string, FigmaComponentMeta>();
  private readonly pending = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private flushScheduled = false;
  private settlePromise: Promise<void> | null = null;
  private settleResolve: (() => void) | null = null;

  constructor(
    private readonly fetchNodes: FetchNodeSubtrees,
    readonly capacity: number = 300,
    readonly batchMax: number = MAX_IDS_PER_REQUEST,
  ) {
    this.cache = new LruCache<FigmaNode | null>(capacity);
  }

  /** Schedule the ids that are not loaded or fetching yet; resolves when every batch lands. */
  load(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (this.cache.has(id) || this.inflight.has(id) || this.pending.has(id)) continue;
      this.pending.add(id);
    }
    if (!this.flushScheduled && (this.pending.size > 0 || this.inflight.size > 0)) {
      this.flushScheduled = true;
      queueMicrotask(() => void this.flush());
    }
    if (this.pending.size === 0 && this.inflight.size === 0) return Promise.resolve();
    if (!this.settlePromise) {
      this.settlePromise = new Promise<void>((resolve) => {
        this.settleResolve = resolve;
      });
    }
    return this.settlePromise;
  }

  /** The loaded subtree: null = confirmed missing, undefined = not loaded (yet). */
  get(id: string): FigmaNode | null | undefined {
    return this.cache.get(id);
  }

  /** Component metadata seen while loading subtrees; undefined until its batch arrives. */
  componentMeta(id: string): FigmaComponentMeta | undefined {
    return this.components.get(id);
  }

  isPending(id: string): boolean {
    return this.pending.has(id) || this.inflight.has(id);
  }

  loadedCount(): number {
    return this.cache.size;
  }

  /** The ids whose subtree is cached (loaded or confirmed missing), oldest first. */
  loadedIds(): string[] {
    return this.cache.keys();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drop everything (version change, figma.file.changed): the next load re-fetches. */
  invalidate(): void {
    this.cache.clear();
    this.components.clear();
    this.pending.clear();
    this.inflight.clear();
    this.notify();
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const ids = [...this.pending];
    this.pending.clear();
    for (const id of ids) this.inflight.add(id);
    try {
      for (const batch of chunkIds(ids, this.batchMax)) {
        let result: NodeBatch;
        try {
          result = await this.fetchNodes(batch);
        } catch {
          // Failed ids fall out of `inflight` and stay out of `cache`, so a later viewport
          // pass retries them; the canvas shows a frame outline meanwhile.
          for (const id of batch) this.inflight.delete(id);
          continue;
        }
        for (const [id, meta] of Object.entries(result.components ?? {}))
          this.components.set(id, meta);
        for (const id of batch) {
          this.cache.set(id, result.nodes[id] ?? null);
          this.inflight.delete(id);
        }
        this.notify();
      }
    } finally {
      if (this.pending.size === 0 && this.inflight.size === 0) {
        const resolve = this.settleResolve;
        this.settlePromise = null;
        this.settleResolve = null;
        resolve?.();
      } else {
        this.flushScheduled = true;
        queueMicrotask(() => void this.flush());
      }
    }
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
}

const stores = new Map<string, FrameStore>();

/** One shared store per (scope, file, version): remounts keep loaded subtrees, versions don't mix. */
export function getFrameStore(
  scope: string,
  fileKey: string,
  version: string | undefined,
  fetchNodes: FetchNodeSubtrees,
): FrameStore {
  const key = `${scope}\u0000${fileKey}\u0000${version ?? "live"}`;
  let store = stores.get(key);
  if (!store) {
    store = new FrameStore(fetchNodes);
    stores.set(key, store);
  }
  return store;
}

/** Forget every cached subtree for a file; `scope` narrows to one session, "*" drops all of them. */
export function dropFrameStores(scope: string, fileKey: string): void {
  for (const key of Array.from(stores.keys())) {
    const [keyScope, keyFile] = key.split("\u0000");
    if (keyFile !== fileKey) continue;
    if (scope !== "*" && keyScope !== scope) continue;
    stores.delete(key);
  }
}
