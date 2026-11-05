// Lazy-loading primitives for the canvas: id batching under the wire limit (spec 32.5.1,
// `figma.file.nodes` takes ≤ 50 ids) and an LRU for loaded frame subtrees.

export const MAX_IDS_PER_REQUEST = 50;

/** Split ids into request-sized batches, preserving order. */
export function chunkIds(ids: readonly string[], max: number = MAX_IDS_PER_REQUEST): string[][] {
  if (max < 1) throw new Error(`batch size must be ≥ 1, got ${max}`);
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += max) {
    batches.push(ids.slice(i, i + max));
  }
  return batches;
}

/** Insertion/lookup order cache; the oldest entry is evicted past `capacity`. */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error(`capacity must be ≥ 1, got ${capacity}`);
  }

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Cached keys, oldest first. */
  keys(): string[] {
    return [...this.map.keys()];
  }

  get size(): number {
    return this.map.size;
  }
}
