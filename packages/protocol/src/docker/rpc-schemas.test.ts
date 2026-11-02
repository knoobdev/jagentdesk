import { describe, expect, it } from "vitest";
import { DockerListRequestSchema, DockerRequestSchemas } from "./rpc-schemas.js";

describe("docker request schemas", () => {
  it("accept an optional serverId on every request, absent meaning local Docker", () => {
    const local = DockerListRequestSchema.parse({ type: "docker/list", requestId: "req_1" });
    const remote = DockerListRequestSchema.parse({
      type: "docker/list",
      requestId: "req_2",
      serverId: "srv_a1b2c3",
    });

    expect(local).toEqual({ type: "docker/list", requestId: "req_1" });
    expect(remote.serverId).toBe("srv_a1b2c3");
    expect(DockerRequestSchemas.every((schema) => "serverId" in schema.shape)).toBe(true);
  });
});
