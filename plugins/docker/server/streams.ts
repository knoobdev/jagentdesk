import type { ChildProcess } from "node:child_process";
import {
  DockerStreams as SharedDockerStreams,
  spawnProcess,
  type DockerSnapshot,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
interface EventsSub {
  child: ChildProcess;
  debounce: ReturnType<typeof setTimeout> | null;
}
/** Local Docker events watcher. The host owns its toggle and session lifetime. */
export class DockerStreams extends SharedDockerStreams {
  private generation = 0;
  private readonly events = new Map<string, EventsSub>();
  // A subscribe waits for the first `docker ps` before it starts `docker events`. An unsubscribe that
  // lands in that wait must stop the watcher from starting; otherwise it is never killed.
  private readonly pending = new Map<string, symbol>();
  override async subscribeSnapshot(
    subscriptionId: string,
    emit: (snapshot: DockerSnapshot) => void,
  ): Promise<void> {
    this.unsubscribeSnapshot(subscriptionId);
    const token = Symbol(subscriptionId);
    this.pending.set(subscriptionId, token);
    const generation = this.generation;
    let snapshot: DockerSnapshot;
    try {
      snapshot = await this.service.list();
    } catch (error) {
      if (this.pending.get(subscriptionId) === token) this.pending.delete(subscriptionId);
      throw error;
    }
    const stillWanted = this.pending.get(subscriptionId) === token;
    if (stillWanted) this.pending.delete(subscriptionId);
    if (!stillWanted || generation !== this.generation) return;
    emit(snapshot);
    const child = spawnProcess("docker", ["events", "--format", "{{json .}}"]);
    const sub: EventsSub = { child, debounce: null };
    this.events.set(subscriptionId, sub);
    child.on("exit", () => {
      if (this.events.get(subscriptionId) !== sub) return;
      if (sub.debounce) clearTimeout(sub.debounce);
      this.events.delete(subscriptionId);
    });
    child.stdout?.on("data", () => {
      if (sub.debounce) return;
      sub.debounce = setTimeout(() => {
        sub.debounce = null;
        void this.service
          .list()
          .then((value) => {
            if (generation === this.generation && this.events.get(subscriptionId) === sub)
              emit(value);
            return undefined;
          })
          .catch(() => {});
      }, 250);
    });
    child.on("error", () => {});
  }
  override unsubscribeSnapshot(subscriptionId: string): void {
    this.pending.delete(subscriptionId);
    const sub = this.events.get(subscriptionId);
    if (!sub) return;
    if (sub.debounce) clearTimeout(sub.debounce);
    sub.child.kill();
    this.events.delete(subscriptionId);
  }
  override disposeAll(): void {
    this.generation++;
    this.pending.clear();
    for (const id of Array.from(this.events.keys())) this.unsubscribeSnapshot(id);
    super.disposeAll();
  }
}
