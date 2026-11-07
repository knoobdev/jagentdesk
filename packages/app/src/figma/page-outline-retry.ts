// Wait on the runtime owner, rather than retaining a client whose socket has been replaced.
// This port carries no credentials and is scoped to exactly one already-paired host.
export interface FigmaHostRetryPort {
  getSnapshot: (serverId: string) => { client: { isConnected: boolean } | null } | null;
  subscribe: (serverId: string, listener: () => void) => () => void;
  resetLocalRetries: (serverId: string) => void;
  runProbeCycleNow: (serverId: string) => Promise<void>;
}
export async function waitForFigmaHost(
  runtime: FigmaHostRetryPort,
  serverId: string,
  signal: AbortSignal,
  timeout_ms = 15_000,
): Promise<void> {
  if (signal.aborted) throw new Error("Page retry cancelled.");
  if (runtime.getSnapshot(serverId)?.client?.isConnected) return;
  await new Promise<void>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(new Error("Page retry cancelled."));
    const check = () => {
      if (runtime.getSnapshot(serverId)?.client?.isConnected) finish();
    };
    unsubscribe = runtime.subscribe(serverId, check);
    if (settled) {
      unsubscribe();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(
      () => finish(new Error("The host is still offline. Reconnect the host and retry.")),
      timeout_ms,
    );
    runtime.resetLocalRetries(serverId);
    void runtime.runProbeCycleNow(serverId).then(check, check);
    check();
  });
}
