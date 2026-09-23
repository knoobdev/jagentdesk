import type { ChildProcess } from "node:child_process";
import { spawnProcess } from "../../utils/spawn.js";
import { parseStatsLine, type DockerService, type DockerSnapshot } from "./docker-service.js";
import type { DockerStats } from "@jagentdesk/protocol/docker/rpc-schemas";

// Strips the cursor/clear escapes `docker stats` uses to redraw its live table.
// Built from the ESC code point so the source carries no literal control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

interface EventsSub {
  child: ChildProcess;
  debounce: ReturnType<typeof setTimeout> | null;
}

// Owns the long-lived `docker` child processes behind the cockpit's realtime streams. One instance
// per session; every subscription is a spawned process that pushes to the client until it is
// unsubscribed or the session closes. No polling — `docker events` drives the snapshot refresh.
export class DockerStreams {
  private readonly events = new Map<string, EventsSub>();
  private readonly logs = new Map<string, ChildProcess>();
  private readonly stats = new Map<string, ChildProcess>();

  constructor(private readonly service: DockerService) {}

  async subscribeSnapshot(
    subscriptionId: string,
    emit: (snapshot: DockerSnapshot) => void,
  ): Promise<void> {
    // Push the current state immediately so the UI is never empty while `docker events` warms up.
    emit(await this.service.list());
    const child = spawnProcess("docker", ["events", "--format", "{{json .}}"]);
    const sub: EventsSub = { child, debounce: null };
    this.events.set(subscriptionId, sub);
    const trigger = () => {
      if (sub.debounce) return;
      // Coalesce bursts (a compose up fires many events) into one re-list.
      sub.debounce = setTimeout(() => {
        sub.debounce = null;
        void this.service
          .list()
          .then(emit)
          .catch(() => {});
      }, 250);
    };
    child.stdout?.on("data", trigger);
    child.on("error", () => {});
    child.on("exit", () => {});
  }

  unsubscribeSnapshot(subscriptionId: string): void {
    const sub = this.events.get(subscriptionId);
    if (!sub) return;
    if (sub.debounce) clearTimeout(sub.debounce);
    sub.child.kill();
    this.events.delete(subscriptionId);
  }

  subscribeLogs(
    subscriptionId: string,
    container: string,
    tail: number,
    emit: (chunk: string) => void,
  ): void {
    this.unsubscribeLogs(subscriptionId);
    const child = spawnProcess("docker", ["logs", "-f", "--tail", String(tail), container]);
    this.logs.set(subscriptionId, child);
    const onData = (d: Buffer) => emit(d.toString("utf8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData); // many images log to stderr
    child.on("error", () => {});
  }

  unsubscribeLogs(subscriptionId: string): void {
    const child = this.logs.get(subscriptionId);
    if (!child) return;
    child.kill();
    this.logs.delete(subscriptionId);
  }

  subscribeStats(
    subscriptionId: string,
    container: string,
    emit: (stats: DockerStats) => void,
  ): void {
    this.unsubscribeStats(subscriptionId);
    const child = spawnProcess("docker", ["stats", "--format", "{{json .}}", container]);
    this.stats.set(subscriptionId, child);
    let buffer = "";
    child.stdout?.on("data", (d: Buffer) => {
      buffer += d.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const clean = line.replace(ANSI, "").trim();
        if (!clean) continue;
        const parsed = parseStatsLine(clean);
        if (parsed) emit(parsed);
      }
    });
    child.on("error", () => {});
  }

  unsubscribeStats(subscriptionId: string): void {
    const child = this.stats.get(subscriptionId);
    if (!child) return;
    child.kill();
    this.stats.delete(subscriptionId);
  }

  disposeAll(): void {
    for (const id of Array.from(this.events.keys())) this.unsubscribeSnapshot(id);
    for (const id of Array.from(this.logs.keys())) this.unsubscribeLogs(id);
    for (const id of Array.from(this.stats.keys())) this.unsubscribeStats(id);
  }
}
