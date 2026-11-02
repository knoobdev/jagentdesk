import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DockerService } from "../../docker/docker-service.js";
import { DockerStreams } from "../../docker/docker-streams.js";
import { RemoteDockerHosts } from "./hosts.js";
import { routeDockerMessage } from "./route.js";

function localBackend() {
  const service = new DockerService();
  return { service, streams: new DockerStreams(service) };
}

function unreachableHosts(): RemoteDockerHosts {
  return new RemoteDockerHosts({
    async acquire(serverId) {
      throw new Error(`cannot reach ${serverId}`);
    },
    runDirectory: path.join(tmpdir(), "jad-route-unused"),
  });
}

describe("routeDockerMessage", () => {
  it("keeps a request without serverId on the local Docker, untouched", async () => {
    const local = localBackend();

    const routed = await routeDockerMessage({}, local, unreachableHosts());
    routed.release();

    expect(routed.serverId).toBeNull();
    expect(routed.service).toBe(local.service);
    expect(routed.streams).toBe(local.streams);
  });

  it("fails with connect_failed when the server cannot be reached", async () => {
    await expect(
      routeDockerMessage({ serverId: "srv_down" }, localBackend(), unreachableHosts()),
    ).rejects.toMatchObject({ code: "connect_failed", message: "cannot reach srv_down" });
  });
});
