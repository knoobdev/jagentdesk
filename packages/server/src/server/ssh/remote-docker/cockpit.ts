import type { ChildProcess } from "node:child_process";
import type {
  DockerAction,
  DockerContainer,
  DockerCpDirection,
  DockerFsEntry,
  DockerFsOp,
  DockerImage,
  DockerImageAction,
  DockerStats,
  DockerVolume,
  DockerVolumeAction,
} from "@jagentdesk/protocol/docker/rpc-schemas";
import { execCommand, spawnProcess } from "../../../utils/spawn.js";
import { DockerService, parseStatsLine, type DockerSnapshot } from "../../docker/docker-service.js";
import { DockerStreams } from "../../docker/docker-streams.js";

// The Docker cockpit (docker/docker-service.ts + docker-streams.ts) drives the host `docker` CLI.
// These subclasses keep its exact commands and output shapes but point every invocation at a
// server's forwarded socket with `--host`, so session code that holds a `DockerService` /
// `DockerStreams` can serve a remote server without knowing it (spec 25.10).

const FS_READ_CAP = 512 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

/** `docker` argv for a forwarded host, e.g. the cockpit's interactive exec terminal. */
export function remoteDockerArgs(dockerHost: string, args: string[]): string[] {
  return ["--host", dockerHost, ...args];
}

function stderrMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { stderr?: unknown; message?: unknown };
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    if (stderr) return stderr;
    if (typeof e.message === "string") return e.message;
  }
  return String(error);
}

function jsonLines(out: string): Array<Record<string, string>> {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, string>];
      } catch {
        return [];
      }
    });
}

// `docker ps --format '{{json .}}'` renders Labels as a flat "k=v,k2=v2" string.
function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

export function parseContainerLines(out: string): DockerContainer[] {
  return jsonLines(out).map((j) => {
    const labels = parseLabels(j.Labels ?? "");
    return {
      id: j.ID ?? "",
      name: j.Names ?? "",
      image: j.Image ?? "",
      status: j.Status ?? "",
      state: j.State ?? "",
      ports: j.Ports ?? "",
      createdAt: j.CreatedAt ?? "",
      project: labels["com.docker.compose.project"] ?? "",
      service: labels["com.docker.compose.service"] ?? "",
    };
  });
}

export function parseImageLines(out: string): DockerImage[] {
  return jsonLines(out).map((j) => ({
    id: j.ID ?? "",
    repository: j.Repository ?? "",
    tag: j.Tag ?? "",
    size: j.Size ?? "",
    createdSince: j.CreatedSince ?? "",
  }));
}

export function parseVolumeLines(out: string): DockerVolume[] {
  return jsonLines(out).map((j) => ({
    name: j.Name ?? "",
    driver: j.Driver ?? "",
    scope: j.Scope ?? "",
  }));
}

export class RemoteDockerService extends DockerService {
  readonly dockerHost: string;

  constructor(dockerHost: string) {
    super();
    this.dockerHost = dockerHost;
  }

  private docker(args: string[], timeout: number) {
    return execCommand("docker", remoteDockerArgs(this.dockerHost, args), {
      timeout,
      maxBuffer: MAX_BUFFER,
    });
  }

  private async dockerOrMessage(args: string[], timeout: number) {
    try {
      return await this.docker(args, timeout);
    } catch (error) {
      throw new Error(stderrMessage(error), { cause: error });
    }
  }

  override async list(): Promise<DockerSnapshot> {
    try {
      const [ps, images, volumes] = await Promise.all([
        this.docker(["ps", "--all", "--format", "{{json .}}"], 30_000),
        this.docker(["images", "--format", "{{json .}}"], 30_000),
        this.docker(["volume", "ls", "--format", "{{json .}}"], 30_000),
      ]);
      return {
        available: true,
        containers: parseContainerLines(ps.stdout),
        images: parseImageLines(images.stdout),
        volumes: parseVolumeLines(volumes.stdout),
      };
    } catch {
      // Same contract as the host cockpit: an unreachable engine is "unavailable", not an error.
      return { available: false, containers: [], images: [], volumes: [] };
    }
  }

  override async logs(container: string, tail = 200): Promise<string> {
    const result = await this.docker(["logs", "--tail", String(tail), container], 30_000);
    return [result.stdout, result.stderr].filter(Boolean).join("").trimEnd() || "(no logs)";
  }

  override async inspect(container: string): Promise<string> {
    const raw = (await this.docker(["inspect", container], 30_000)).stdout;
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw.trim() || "(no data)";
    }
  }

  override async action(container: string, action: DockerAction): Promise<void> {
    const args = action === "remove" ? ["rm", "-f", container] : [action, container];
    await this.docker(args, 60_000);
  }

  override async exec(container: string, command: string): Promise<string> {
    const result = await this.docker(["exec", container, "sh", "-lc", command], 60_000);
    return [result.stdout, result.stderr].filter(Boolean).join("").trimEnd() || "(no output)";
  }

  override async imageAction(image: string, action: DockerImageAction): Promise<void> {
    if (action === "pull") await this.docker(["pull", image], 600_000);
    else if (action === "run") await this.docker(["run", "-d", image], 120_000);
    else await this.docker(["rmi", image], 60_000);
  }

  override async fsList(container: string, path: string): Promise<DockerFsEntry[]> {
    const result = await this.dockerOrMessage(
      ["exec", container, "ls", "-1Ap", "--", path],
      30_000,
    );
    return result.stdout
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.length > 0)
      .map((line) => {
        const isDir = line.endsWith("/");
        return { name: isDir ? line.slice(0, -1) : line, isDir };
      })
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  }

  override async fsRead(
    container: string,
    path: string,
  ): Promise<{ content: string; truncated: boolean }> {
    const script = `head -c ${FS_READ_CAP + 1} -- "$0"`;
    const result = await this.dockerOrMessage(
      ["exec", container, "sh", "-c", script, path],
      30_000,
    );
    const content = result.stdout;
    return { content: content.slice(0, FS_READ_CAP), truncated: content.length > FS_READ_CAP };
  }

  override async fsWrite(container: string, path: string, content: string): Promise<void> {
    const args = remoteDockerArgs(this.dockerHost, [
      "exec",
      "-i",
      container,
      "sh",
      "-c",
      'cat > "$0"',
      path,
    ]);
    await new Promise<void>((resolve, reject) => {
      const child = spawnProcess("docker", args);
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `write failed (exit ${code})`));
      });
      child.stdin?.end(content);
    });
  }

  override async fsOp(
    container: string,
    op: DockerFsOp,
    path: string,
    newPath: string,
  ): Promise<void> {
    let args: string[];
    if (op === "delete") args = ["exec", container, "rm", "-rf", "--", path];
    else if (op === "rename") args = ["exec", container, "mv", "--", path, newPath];
    else args = ["exec", container, "mkdir", "-p", "--", path];
    await this.dockerOrMessage(args, 30_000);
  }

  // `hostPath` is on the daemon machine: `docker cp` streams between it and the remote engine.
  override async cp(
    container: string,
    direction: DockerCpDirection,
    containerPath: string,
    hostPath: string,
  ): Promise<void> {
    const spec = `${container}:${containerPath}`;
    const args = direction === "to_host" ? ["cp", spec, hostPath] : ["cp", hostPath, spec];
    await this.docker(args, 120_000);
  }

  override async volumeAction(name: string, action: DockerVolumeAction): Promise<void> {
    if (action === "prune") await this.docker(["volume", "prune", "-f"], 60_000);
    else await this.docker(["volume", "rm", name], 60_000);
  }
}

interface EventsSubscription {
  child: ChildProcess;
  debounce: ReturnType<typeof setTimeout> | null;
}

/** Realtime cockpit streams (`docker events/logs -f/stats`) against a forwarded socket. */
export class RemoteDockerStreams extends DockerStreams {
  private readonly remoteEvents = new Map<string, EventsSubscription>();
  private readonly remoteLogs = new Map<string, ChildProcess>();
  private readonly remoteStats = new Map<string, ChildProcess>();

  private readonly remote: RemoteDockerService;

  constructor(remote: RemoteDockerService) {
    super(remote);
    this.remote = remote;
  }

  private spawnDocker(args: string[]): ChildProcess {
    return spawnProcess("docker", remoteDockerArgs(this.remote.dockerHost, args));
  }

  override async subscribeSnapshot(
    subscriptionId: string,
    emit: (snapshot: DockerSnapshot) => void,
  ): Promise<void> {
    emit(await this.remote.list());
    const child = this.spawnDocker(["events", "--format", "{{json .}}"]);
    const subscription: EventsSubscription = { child, debounce: null };
    this.remoteEvents.set(subscriptionId, subscription);
    child.stdout?.on("data", () => {
      if (subscription.debounce) return;
      subscription.debounce = setTimeout(() => {
        subscription.debounce = null;
        void this.remote
          .list()
          .then(emit)
          .catch(() => {});
      }, 250);
    });
    child.on("error", () => {});
  }

  override unsubscribeSnapshot(subscriptionId: string): void {
    const subscription = this.remoteEvents.get(subscriptionId);
    if (!subscription) return;
    if (subscription.debounce) clearTimeout(subscription.debounce);
    subscription.child.kill();
    this.remoteEvents.delete(subscriptionId);
  }

  override subscribeLogs(
    subscriptionId: string,
    container: string,
    tail: number,
    emit: (chunk: string) => void,
  ): void {
    this.unsubscribeLogs(subscriptionId);
    const child = this.spawnDocker(["logs", "-f", "--tail", String(tail), container]);
    this.remoteLogs.set(subscriptionId, child);
    const forward = (chunk: Buffer) => emit(chunk.toString("utf8"));
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.on("error", () => {});
  }

  override unsubscribeLogs(subscriptionId: string): void {
    const child = this.remoteLogs.get(subscriptionId);
    if (!child) return;
    child.kill();
    this.remoteLogs.delete(subscriptionId);
  }

  override subscribeStats(
    subscriptionId: string,
    container: string,
    emit: (stats: DockerStats) => void,
  ): void {
    this.unsubscribeStats(subscriptionId);
    const child = this.spawnDocker(["stats", "--format", "{{json .}}", container]);
    this.remoteStats.set(subscriptionId, child);
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseStatsLine(line.replace(ANSI, "").trim());
        if (parsed) emit(parsed);
      }
    });
    child.on("error", () => {});
  }

  override unsubscribeStats(subscriptionId: string): void {
    const child = this.remoteStats.get(subscriptionId);
    if (!child) return;
    child.kill();
    this.remoteStats.delete(subscriptionId);
  }

  override disposeAll(): void {
    for (const id of Array.from(this.remoteEvents.keys())) this.unsubscribeSnapshot(id);
    for (const id of Array.from(this.remoteLogs.keys())) this.unsubscribeLogs(id);
    for (const id of Array.from(this.remoteStats.keys())) this.unsubscribeStats(id);
  }
}
