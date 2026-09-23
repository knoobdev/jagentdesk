import { execCommand } from "../../utils/spawn.js";
import type {
  DockerAction,
  DockerContainer,
  DockerImage,
  DockerImageAction,
  DockerStats,
  DockerVolume,
  DockerVolumeAction,
} from "@jagentdesk/protocol/docker/rpc-schemas";

export interface DockerSnapshot {
  available: boolean;
  containers: DockerContainer[];
  images: DockerImage[];
  volumes: DockerVolume[];
}

// Thin wrapper over the host `docker` CLI that backs the Docker cockpit — so the human can watch
// the containers the team (and they) create. Read via `docker ps/images --format '{{json .}}'`.
export class DockerService {
  async list(): Promise<DockerSnapshot> {
    try {
      const [ps, imgs, vols] = await Promise.all([
        this.run(["ps", "--all", "--format", "{{json .}}"]),
        this.run(["images", "--format", "{{json .}}"]),
        this.run(["volume", "ls", "--format", "{{json .}}"]),
      ]);
      return {
        available: true,
        containers: parseContainers(ps),
        images: parseImages(imgs),
        volumes: parseVolumes(vols),
      };
    } catch {
      // Docker not installed / daemon not running: report unavailable rather than erroring.
      return { available: false, containers: [], images: [], volumes: [] };
    }
  }

  async logs(container: string, tail = 200): Promise<string> {
    const result = await execCommand("docker", ["logs", "--tail", String(tail), container], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    // Docker writes container output across both streams; the reader wants them interleaved.
    return [result.stdout, result.stderr].filter(Boolean).join("").trimEnd() || "(no logs)";
  }

  async inspect(container: string): Promise<string> {
    const result = await execCommand("docker", ["inspect", container], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const raw = result.stdout ?? "";
    try {
      // `docker inspect` returns a JSON array with one entry; pretty-print it.
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw.trim() || "(no data)";
    }
  }

  async action(container: string, action: DockerAction): Promise<void> {
    // start/stop/restart/pause/unpause are `docker <action> <c>`; remove force-kills.
    const args = action === "remove" ? ["rm", "-f", container] : [action, container];
    await execCommand("docker", args, { timeout: 60_000 });
  }

  async exec(container: string, command: string): Promise<string> {
    // One-shot command inside the container via a login shell (best-effort: sh -lc).
    const result = await execCommand("docker", ["exec", container, "sh", "-lc", command], {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return [result.stdout, result.stderr].filter(Boolean).join("").trimEnd() || "(no output)";
  }

  async imageAction(image: string, action: DockerImageAction): Promise<void> {
    if (action === "pull") {
      await execCommand("docker", ["pull", image], { timeout: 600_000 });
    } else if (action === "run") {
      await execCommand("docker", ["run", "-d", image], { timeout: 120_000 });
    } else {
      await execCommand("docker", ["rmi", image], { timeout: 60_000 });
    }
  }

  async volumeAction(name: string, action: DockerVolumeAction): Promise<void> {
    if (action === "prune") {
      await execCommand("docker", ["volume", "prune", "-f"], { timeout: 60_000 });
    } else {
      await execCommand("docker", ["volume", "rm", name], { timeout: 60_000 });
    }
  }

  private async run(args: string[]): Promise<string> {
    const result = await execCommand("docker", args, {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout ?? "";
  }
}

export function parseStatsLine(line: string): DockerStats | null {
  try {
    const j = JSON.parse(line) as Record<string, string>;
    return {
      cpuPerc: j.CPUPerc ?? "",
      memUsage: j.MemUsage ?? "",
      memPerc: j.MemPerc ?? "",
      netIO: j.NetIO ?? "",
      blockIO: j.BlockIO ?? "",
      pids: j.PIDs ?? "",
    };
  } catch {
    return null;
  }
}

function parseVolumes(out: string): DockerVolume[] {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const j = JSON.parse(line) as Record<string, string>;
        return [{ name: j.Name ?? "", driver: j.Driver ?? "", scope: j.Scope ?? "" }];
      } catch {
        return [];
      }
    });
}

// `docker ps --format '{{json .}}'` renders Labels as a flat "k=v,k2=v2" string.
function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function parseContainers(out: string): DockerContainer[] {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const j = JSON.parse(line) as Record<string, string>;
        const labels = parseLabels(j.Labels ?? "");
        return [
          {
            id: j.ID ?? "",
            name: j.Names ?? "",
            image: j.Image ?? "",
            status: j.Status ?? "",
            state: j.State ?? "",
            ports: j.Ports ?? "",
            createdAt: j.CreatedAt ?? "",
            project: labels["com.docker.compose.project"] ?? "",
            service: labels["com.docker.compose.service"] ?? "",
          },
        ];
      } catch {
        return [];
      }
    });
}

function parseImages(out: string): DockerImage[] {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const j = JSON.parse(line) as Record<string, string>;
        return [
          {
            id: j.ID ?? "",
            repository: j.Repository ?? "",
            tag: j.Tag ?? "",
            size: j.Size ?? "",
            createdSince: j.CreatedSince ?? "",
          },
        ];
      } catch {
        return [];
      }
    });
}
