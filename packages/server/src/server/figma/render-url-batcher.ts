// Preview exports share the expensive Figma snapshot preparation. Cache hits never enter
// this queue. Group ownership (connection/file/version/format/scale/bounds) belongs to caller.
const WAIT_MS = 250;
const MAX_WAIT_MS = 1000;
const MAX_IDS = 100;
const MAX_EXPORTS = 2;
type Urls = Record<string, string | null>;
interface PendingUrl {
  promise: Promise<string | null>;
  resolve: (url: string | null) => void;
  reject: (error: unknown) => void;
}

export function createRenderUrlBatcher(ports: {
  exportIds: (ids: string[]) => Promise<Urls>;
  onIdle: () => void;
}): (ids: readonly string[]) => Promise<Urls> {
  const pending = new Map<string, PendingUrl>();
  const inflight = new Map<string, PendingUrl>();
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstQueuedAt: number | null = null;
  const schedule = () => {
    if (active >= MAX_EXPORTS || !pending.size) return;
    firstQueuedAt ??= Date.now();
    if (timer) clearTimeout(timer);
    const delay = Math.min(WAIT_MS, Math.max(0, MAX_WAIT_MS - (Date.now() - firstQueuedAt)));
    timer = setTimeout(() => {
      timer = null;
      firstQueuedAt = null;
      dispatch();
    }, delay);
  };
  const dispatch = () => {
    const batch = [...pending].slice(0, MAX_IDS);
    for (const [id, entry] of batch) {
      pending.delete(id);
      inflight.set(id, entry);
    }
    active++;
    void Promise.resolve()
      .then(() => ports.exportIds(batch.map(([id]) => id)))
      .then(
        (urls) => {
          for (const [id, entry] of batch) entry.resolve(urls[id] ?? null);
          return undefined;
        },
        (error) => {
          for (const [, entry] of batch) entry.reject(error);
          return undefined;
        },
      )
      .finally(() => {
        for (const [id, entry] of batch) if (inflight.get(id) === entry) inflight.delete(id);
        active--;
        schedule();
        if (!active && !pending.size && !timer) ports.onIdle();
      });
    schedule();
  };
  return async (ids) => {
    let added = false;
    const results = ids.map(async (id) => {
      let entry = inflight.get(id) ?? pending.get(id);
      if (!entry) {
        let resolve!: PendingUrl["resolve"];
        let reject!: PendingUrl["reject"];
        const promise = new Promise<string | null>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        entry = { promise, resolve, reject };
        pending.set(id, entry);
        added = true;
      }
      return [id, await entry.promise] as const;
    });
    if (added) schedule();
    return Object.fromEntries(await Promise.all(results));
  };
}
