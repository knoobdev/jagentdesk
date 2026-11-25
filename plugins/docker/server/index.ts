import type { BuiltinServerHost } from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { DockerSession } from "./session.js";
import { registerDockerTools } from "./agent-tools.js";
export function register(host: BuiltinServerHost) {
  host.rpc(
    "docker/",
    [
      "docker/list",
      "docker/logs",
      "docker/inspect",
      "docker/action",
      "docker/exec",
      "docker/image/action",
      "docker/volume/action",
      "docker/fs/list",
      "docker/cp",
      "docker/fs/read",
      "docker/fs/write",
      "docker/fs/op",
      "docker/subscribe",
      "docker/unsubscribe",
      "docker/logs/subscribe",
      "docker/logs/unsubscribe",
      "docker/stats/subscribe",
      "docker/stats/unsubscribe",
    ],
    (services) => new DockerSession(services),
  );
  host.agentTools((registerTool) => registerDockerTools({ registerTool }));
}
