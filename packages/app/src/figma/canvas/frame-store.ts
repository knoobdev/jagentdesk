import type { FigmaComponentMeta, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { chunkIds, LruCache, MAX_IDS_PER_REQUEST } from "./batching";

// Lazy viewport loading (spec 32.5.1, ADR-0039): what enters the viewport is decided by
// `planRootLoad` (viewport.ts) — overview zoom draws metadata boxes and fetches nothing; only
// roots whose projected detail justifies it load their FULL subtree through `figma.file.nodes`
// in batches of ≤ 50 ids. SECTIONs are never a subtree load; their direct children arrive as a
// shallow `depth: 1` payload into a separate LRU that shares this store's capacity, version
// scope, and epoch/revision generation rules. Memory is BOUNDED, not flat: two count-capped
// caches (subtrees and shallow Section metadata) per store, times MAX_STORE_REGISTRY_SIZE live
// stores. The fetcher is injected so the tests run without a client, and the canvas can swap
// in the Figma Link path.

export interface NodeBatch {
  nodes: Record<string, FigmaNode | null>;
  /** Component metadata referenced by the batch (REST `components`); empty for Link paths. */
  components: Record<string, FigmaComponentMeta>;
}

/** ADR-0039 shallow read (spec 32.9): `depth: 1` returns a SECTION's direct children only. */
export interface FetchOptions {
  depth?: 1;
}

export type FetchNodeSubtrees = (
  ids: readonly string[],
  options?: FetchOptions,
) => Promise<NodeBatch>;

function findParentInSubtree(node: FigmaNode, childId: string): FigmaNode | null {
  const children = Array.isArray(node.children) ? (node.children as FigmaNode[]) : [];
  for (const child of children) {
    if (!child || typeof child !== "object") continue;
    if (child.id === childId) return node;
    const deeper = findParentInSubtree(child, childId);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * One drain queue: pending/inflight ledgers, the cache arrivals land in, and the settle pair
 * `load()`/`loadSections()` hand to waiters. Subtrees and shallow SECTION metadata run through
 * separate instances (separate bounds, separate fetch option) but share the store's `epoch` and
 * `revision`, so one invalidate()/generation rule covers both (spec 32.5.1 / ADR-0039).
 */
interface LoadQueue {
  readonly pending: Set<string>;
  readonly inflight: Set<string>;
  scheduled: boolean;
  settlePromise: Promise<void> | null;
  settleResolve: (() => void) | null;
  readonly cache: LruCache<FigmaNode | null>;
  readonly fetchOptions: FetchOptions | undefined;
  /** Only full subtrees carry component metadata; shallow reads must not evict it. */
  readonly keepsComponents: boolean;
}

function makeQueue(
  cache: LruCache<FigmaNode | null>,
  fetchOptions: FetchOptions | undefined,
  keepsComponents: boolean,
): LoadQueue {
  return {
    pending: new Set<string>(),
    inflight: new Set<string>(),
    scheduled: false,
    settlePromise: null,
    settleResolve: null,
    cache,
    fetchOptions,
    keepsComponents,
  };
}

export class FrameStore {
  private readonly cache: LruCache<FigmaNode | null>;
  // Shallow SECTION payloads (depth-1 children), bounded on its own so a Section-heavy file
  // cannot grow it through the full-subtree cache it must not share (criterion 17: a depth-1
  // fragment is never the full tree).
  private readonly sections: LruCache<FigmaNode | null>;
  private readonly subtreeQueue: LoadQueue;
  private readonly sectionQueue: LoadQueue;
  // Component metadata is as unbounded as the subtrees that reference it, so it rides the same
  // LRU budget: a thousand-component file must not keep every meta seen since first paint.
  private readonly components: LruCache<FigmaComponentMeta>;
  private readonly listeners = new Set<() => void>();
  // Bumped by invalidate(): batches that were already awaiting the fetcher when the cache was
  // dropped belong to the old generation and must not repopulate the fresh cache, or the next
  // load() sees them as cached and the re-fetch the doc promises never happens.
  private epoch = 0;
  // Monotonic content counter: subscribers must see a replacement at LRU capacity (loadedCount
  // stays equal while a subtree is swapped out and another in), so React snapshots key on this.
  private revision = 0;

  constructor(
    private fetchNodes: FetchNodeSubtrees,
    readonly capacity: number = 300,
    readonly batchMax: number = MAX_IDS_PER_REQUEST,
  ) {
    this.cache = new LruCache<FigmaNode | null>(capacity);
    this.sections = new LruCache<FigmaNode | null>(capacity);
    this.components = new LruCache<FigmaComponentMeta>(capacity);
    this.subtreeQueue = makeQueue(this.cache, undefined, true);
    this.sectionQueue = makeQueue(this.sections, { depth: 1 }, false);
  }

  /** Schedule the ids that are not loaded or fetching yet; resolves when every batch lands. */
  load(ids: readonly string[]): Promise<void> {
    return this.enqueue(this.subtreeQueue, ids);
  }

  /**
   * Schedule the shallow (depth-1) children of SECTIONs entering the viewport (ADR-0039). A
   * separate bounded cache from the full subtrees: `load()` must never resolve a SECTION id from
   * a depth-1 fragment, or the canvas would paint truncated trees as if they were complete.
   */
  loadSections(ids: readonly string[]): Promise<void> {
    return this.enqueue(this.sectionQueue, ids);
  }

  private enqueue(queue: LoadQueue, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (queue.cache.has(id) || queue.inflight.has(id) || queue.pending.has(id)) continue;
      queue.pending.add(id);
    }
    // Schedule only work that exists: while a fetch is in flight the canvas paint loop keeps
    // calling load() for the same ids, and an empty flush rescheduling itself as a microtask
    // never lets the main thread yield (the page freezes).
    if (!queue.scheduled && queue.pending.size > 0) {
      queue.scheduled = true;
      queueMicrotask(() => void this.drain(queue));
    }
    if (queue.pending.size === 0 && queue.inflight.size === 0) return Promise.resolve();
    if (!queue.settlePromise) {
      queue.settlePromise = new Promise<void>((resolve) => {
        queue.settleResolve = resolve;
      });
    }
    return queue.settlePromise;
  }

  /** Point the store at a new fetch path (host reconnect): the registry keeps the cache,
   * the caller keeps a live client. Last bind wins — the newest closure is the correct one. */
  setFetcher(fetchNodes: FetchNodeSubtrees): void {
    this.fetchNodes = fetchNodes;
  }

  /** The loaded subtree: null = confirmed missing, undefined = not loaded (yet). */
  get(id: string): FigmaNode | null | undefined {
    return this.cache.get(id);
  }

  /** The loaded depth-1 SECTION payload: null = confirmed missing, undefined = not fetched. */
  sectionNode(id: string): FigmaNode | null | undefined {
    return this.sections.get(id);
  }

  /** Component metadata seen while loading subtrees; undefined until its batch arrives. */
  componentMeta(id: string): FigmaComponentMeta | undefined {
    return this.components.get(id);
  }

  /**
   * The node's direct parent inside a cached subtree — the inspect panel shows position
   * relative to it. null when the node is itself a cached top-level subtree root (its parent
   * is the page, so position stays page-absolute); undefined when no loaded subtree contains
   * the node.
   */
  parentOf(nodeId: string): FigmaNode | null | undefined {
    for (const root of this.cachedRoots()) {
      if (root.id === nodeId) return null;
      const parent = findParentInSubtree(root, nodeId);
      if (parent) return parent;
    }
    return undefined;
  }

  private cachedRoots(): FigmaNode[] {
    const roots: FigmaNode[] = [];
    for (const queue of [this.subtreeQueue, this.sectionQueue]) {
      for (const id of queue.cache.keys()) {
        const node = queue.cache.get(id);
        if (node) roots.push(node);
      }
    }
    return roots;
  }

  isPending(id: string): boolean {
    return this.subtreeQueue.pending.has(id) || this.subtreeQueue.inflight.has(id);
  }

  /** True while a SECTION's depth-1 children are queued or fetching (same ledger rule). */
  isSectionPending(id: string): boolean {
    return this.sectionQueue.pending.has(id) || this.sectionQueue.inflight.has(id);
  }

  loadedCount(): number {
    return this.cache.size;
  }

  /** The ids whose subtree is cached (loaded or confirmed missing), oldest first. */
  loadedIds(): string[] {
    return this.cache.keys();
  }

  /** The ids whose depth-1 SECTION children are cached, oldest first. */
  sectionLoadedIds(): string[] {
    return this.sections.keys();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drop everything (version change, figma.file.changed): the next load re-fetches. */
  invalidate(): void {
    this.epoch += 1;
    this.cache.clear();
    this.sections.clear();
    this.components.clear();
    this.settleQueue(this.subtreeQueue);
    this.settleQueue(this.sectionQueue);
    this.revision += 1;
    this.notify();
  }

  private settleQueue(queue: LoadQueue): void {
    queue.pending.clear();
    queue.inflight.clear();
    // The queue is now empty and every in-flight response is dead data: settle waiters that no
    // further fetch can finish, or an awaited load() would hang until a next request runs.
    const resolve = queue.settleResolve;
    queue.settlePromise = null;
    queue.settleResolve = null;
    resolve?.();
  }

  /** Monotonic content version: changes whenever the cache gains, swaps, or drops entries. */
  revisionSnapshot(): number {
    return this.revision;
  }

  private async drain(queue: LoadQueue): Promise<void> {
    queue.scheduled = false;
    const epoch = this.epoch;
    const ids = [...queue.pending];
    queue.pending.clear();
    for (const id of ids) queue.inflight.add(id);
    try {
      for (const batch of chunkIds(ids, this.batchMax)) {
        let result: NodeBatch;
        try {
          result = queue.fetchOptions
            ? await this.fetchNodes(batch, queue.fetchOptions)
            : await this.fetchNodes(batch);
        } catch {
          // Failed ids fall out of `inflight` and stay out of `cache`, so a later viewport
          // pass retries them; the canvas shows a frame outline meanwhile.
          if (this.epoch !== epoch) {
            // A rejection that surfaces after invalidate() belongs to the dead generation:
            // `inflight` may already carry the same ids re-queued by a newer drain, and deleting
            // them here would misreport `isPending` and settle the wrong flush's waiter.
            break;
          }
          for (const id of batch) queue.inflight.delete(id);
          continue;
        }
        if (this.epoch !== epoch) {
          // invalidate() fired while this batch was in flight: the response is pre-invalidation
          // data. Discard it and stop — invalidate() already dropped these ids from
          // `inflight`/`pending`, and the remaining chunks of this dead generation are stale
          // too, so the next load() re-queues whatever the viewport still needs.
          break;
        }
        if (queue.keepsComponents) {
          for (const [id, meta] of Object.entries(result.components ?? {}))
            this.components.set(id, meta);
        }
        for (const id of batch) {
          queue.cache.set(id, result.nodes[id] ?? null);
          queue.inflight.delete(id);
        }
        this.revision += 1;
        this.notify();
      }
    } finally {
      if (queue.pending.size === 0) {
        if (queue.inflight.size === 0) {
          const resolve = queue.settleResolve;
          queue.settlePromise = null;
          queue.settleResolve = null;
          resolve?.();
        }
        // An in-flight batch belongs to the suspended `await` above: it resumes this same drain
        // and re-runs this check, so an empty queue never reschedules itself.
      } else if (!queue.scheduled) {
        queue.scheduled = true;
        queueMicrotask(() => void this.drain(queue));
      }
    }
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
}

const stores = new Map<string, FrameStore>();

/** Registry ceiling: superseded reload/version scopes must not pile up full LRU caches forever. */
export const MAX_STORE_REGISTRY_SIZE = 12;

function touchStore(key: string, store: FrameStore): FrameStore {
  stores.delete(key);
  stores.set(key, store);
  while (stores.size > MAX_STORE_REGISTRY_SIZE) {
    const oldest = stores.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = stores.get(oldest);
    stores.delete(oldest);
    // Free the subtree memory now: a store still mounted somewhere may repopulate, but an
    // evicted store must never serve its old cache after it left the registry (and a late
    // in-flight response must not repopulate it — same generation rule as a drop).
    evicted?.invalidate();
  }
  return store;
}

/** One shared store per (scope, file, version): remounts keep loaded subtrees, versions don't mix. */
export function getFrameStore(
  scope: string,
  fileKey: string,
  version: string | undefined,
  fetchNodes: FetchNodeSubtrees,
): FrameStore {
  const key = `${scope}\u0000${fileKey}\u0000${version ?? "live"}`;
  const store = stores.get(key);
  if (store) {
    // Reuse the cache, rebind the fetch path: after a host reconnect the newest closure holds
    // the live client, while reusing the store keeps panning back free of charge.
    store.setFetcher(fetchNodes);
    return touchStore(key, store);
  }
  const created = new FrameStore(fetchNodes);
  stores.set(key, created);
  return touchStore(key, created);
}

/** Number of stores the registry currently retains (tests / diagnostics). */
export function frameStoreRegistrySize(): number {
  return stores.size;
}

/** Forget every cached subtree for a file; `scope` narrows to one session, "*" drops all of them. */
export function dropFrameStores(scope: string, fileKey: string): void {
  for (const key of Array.from(stores.keys())) {
    const [keyScope, keyFile] = key.split("\u0000");
    if (keyFile !== fileKey) continue;
    if (scope !== "*" && keyScope !== scope) continue;
    const store = stores.get(key);
    stores.delete(key);
    // Invalidate before unlinking: a batch still awaiting the fetcher belongs to a dropped
    // generation and must not repopulate the obsolete store when it finally lands.
    store?.invalidate();
  }
}
