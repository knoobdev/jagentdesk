import { execCommand } from "../../utils/spawn.js";
import type {
  DockerAction,
  DockerContainer,
  DockerImage,
} from "@jagentdesk/protocol/docker/rpc-schemas";

// Thin wrapper over the host `docker` CLI that backs the Docker cockpit — so the human can watch
// the containers the team (and they) create. Read via `docker ps/images --format '{{json .}}'`.
export class DockerService {
  async list(): Promise<{
    available: boolean;
    containers: DockerContainer[];
    images: DockerImage[];
  }> {
    try {
      const [ps, imgs] = await Promise.all([
        this.run(["ps", "--all", "--format", "{{json .}}"]),
        this.run(["images", "--format", "{{json .}}"]),
      ]);
      return { available: true, containers: parseContainers(ps), images: parseImages(imgs) };
    } catch {
      // Docker not installed / daemon not running: report unavailable rather than erroring.
      return { available: false, containers: [], images: [] };
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

  async action(container: string, action: DockerAction): Promise<void> {
    const args = action === "remove" ? ["rm", "-f", container] : [action, container];
    await execCommand("docker", args, { timeout: 60_000 });
  }

  private async run(args: string[]): Promise<string> {
    const result = await execCommand("docker", args, {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout ?? "";
  }
}

function parseContainers(out: string): DockerContainer[] {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const j = JSON.parse(line) as Record<string, string>;
        return [
          {
            id: j.ID ?? "",
            name: j.Names ?? "",
            image: j.Image ?? "",
            status: j.Status ?? "",
            state: j.State ?? "",
            ports: j.Ports ?? "",
            createdAt: j.CreatedAt ?? "",
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
