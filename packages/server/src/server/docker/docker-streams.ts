import type { ChildProcess } from "node:child_process";
import { spawnProcess } from "../../utils/spawn.js";
import { parseStatsLine, type DockerService, type DockerSnapshot } from "./docker-service.js";
import type { DockerStats } from "@jagentdesk/protocol/docker/rpc-schemas";

// Strips the cursor/clear escapes `docker stats` uses to redraw its live table.
// Built from the ESC code point so the source carries no literal control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

// Shared stream plumbing for local and SSH Docker backends. Feature snapshot watchers live in their plugin.
export class DockerStreams {
  private readonly logs = new Map<string, ChildProcess>();
  private readonly stats = new Map<string, ChildProcess>();
  protected readonly service: DockerService;
  constructor(service: DockerService) {
    this.service = service;
  }
  async subscribeSnapshot(
    _subscriptionId: string,
    _emit: (snapshot: DockerSnapshot) => void,
  ): Promise<void> {
    throw new Error("Docker snapshot source has not been registered");
  }
  unsubscribeSnapshot(_subscriptionId: string): void {}
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
    for (const id of Array.from(this.logs.keys())) this.unsubscribeLogs(id);
    for (const id of Array.from(this.stats.keys())) this.unsubscribeStats(id);
  }
}
