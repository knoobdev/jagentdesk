import { DockerStreams as LocalDockerStreams } from "./streams.js";
import {
  type DockerService,
  type DockerStreams,
  RemoteDockerError,
  type RemoteDockerHosts,
  type RoutedDocker,
  type BuiltinSessionServices,
  type BuiltinSessionContribution,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import type { SessionInboundMessage } from "@jagentdesk/protocol/messages";

export class DockerSession implements BuiltinSessionContribution {
  private readonly dockerService;
  private readonly dockerStreams;
  // Retain this identity: the remote backend cache uses a WeakMap keyed by the local backend.
  private readonly local;
  private readonly remoteDockerSubscriptions = new Map<string, RoutedDocker>();
  private generation = 0;
  constructor(private readonly host: BuiltinSessionServices) {
    this.dockerService = host.docker.createService();
    this.dockerStreams = new LocalDockerStreams(this.dockerService);
    this.local = { service: this.dockerService, streams: this.dockerStreams };
  }
  private emit: BuiltinSessionServices["push"] = (message) => this.host.push(message);
  handle(message: SessionInboundMessage) {
    return this.dispatchDockerMessage(message);
  }
  stop() {
    this.generation++;
    this.dockerStreams.disposeAll();
    this.host.docker.disposeRemote(this.local);
    for (const routed of this.remoteDockerSubscriptions.values()) routed.release();
    this.remoteDockerSubscriptions.clear();
  }
  // docker/* with `serverId` drive the same cockpit against that SSH server's forwarded socket
  // (spec 25.10, ssh/remote-docker/route.ts). One-shot requests give the socket back when done;
  // a subscription holds it until its unsubscribe, which is routed by subscription id.
  private dispatchDockerMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!msg.type.startsWith("docker/")) return undefined;
    const local = this.local;
    const subscriptionId = "subscriptionId" in msg ? msg.subscriptionId : undefined;
    if (subscriptionId && msg.type.endsWith("/unsubscribe")) {
      const held = this.remoteDockerSubscriptions.get(subscriptionId);
      if (held) {
        this.remoteDockerSubscriptions.delete(subscriptionId);
        const done = this.dispatchDockerMessageWith(msg, held.service, held.streams);
        held.release();
        return done;
      }
    }
    const serverId = "serverId" in msg ? msg.serverId : undefined;
    const hosts = this.host.remoteDocker();
    if (!serverId || !hosts)
      return this.dispatchDockerMessageWith(msg, local.service, local.streams);
    return this.dispatchRemoteDockerMessage(msg, serverId, local, hosts, subscriptionId);
  }

  private async dispatchRemoteDockerMessage(
    msg: SessionInboundMessage,
    serverId: string,
    local: { service: DockerService; streams: DockerStreams },
    hosts: RemoteDockerHosts,
    subscriptionId: string | undefined,
  ): Promise<void> {
    const generation = this.generation;
    let routed: RoutedDocker;
    try {
      routed = await this.host.docker.route({ serverId }, local, hosts);
    } catch (error) {
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: "requestId" in msg && msg.requestId ? msg.requestId : "",
          requestType: msg.type,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof RemoteDockerError ? error.code : "ssh_docker_unavailable",
        },
      });
      return;
    }
    if (generation !== this.generation) {
      routed.release();
      return;
    }
    if (subscriptionId && msg.type.endsWith("/subscribe")) {
      this.remoteDockerSubscriptions.set(subscriptionId, routed);
      await this.dispatchDockerMessageWith(msg, routed.service, routed.streams);
      return;
    }
    try {
      await this.dispatchDockerMessageWith(msg, routed.service, routed.streams);
    } finally {
      routed.release();
    }
  }

  private dispatchDockerMessageWith(
    msg: SessionInboundMessage,
    dockerService: DockerService,
    dockerStreams: DockerStreams,
  ): Promise<void> | undefined {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    if (msg.type === "docker/list") {
      const { requestId } = msg;
      return dockerService
        .list()
        .then((result) => {
          this.emit({
            type: "docker/list/response",
            payload: { requestId, error: null, ...result },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/list/response",
            payload: {
              requestId,
              error: fail(error),
              available: false,
              containers: [],
              images: [],
            },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/logs") {
      const { requestId } = msg;
      return dockerService
        .logs(msg.container, msg.tail)
        .then((logs) => {
          this.emit({ type: "docker/logs/response", payload: { requestId, error: null, logs } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/logs/response",
            payload: { requestId, error: fail(error), logs: "" },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/inspect") {
      const { requestId } = msg;
      return dockerService
        .inspect(msg.container)
        .then((inspect) => {
          this.emit({
            type: "docker/inspect/response",
            payload: { requestId, error: null, inspect },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/inspect/response",
            payload: { requestId, error: fail(error), inspect: "" },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/action") {
      const { requestId } = msg;
      return dockerService
        .action(msg.container, msg.action)
        .then(() => {
          this.emit({ type: "docker/action/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/action/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/exec") {
      const { requestId } = msg;
      return dockerService
        .exec(msg.container, msg.command)
        .then((output) => {
          this.emit({ type: "docker/exec/response", payload: { requestId, error: null, output } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/exec/response",
            payload: { requestId, error: fail(error), output: "" },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/image/action") {
      const { requestId } = msg;
      return dockerService
        .imageAction(msg.image, msg.action)
        .then(() => {
          this.emit({ type: "docker/image/action/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/image/action/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/volume/action") {
      const { requestId } = msg;
      return dockerService
        .volumeAction(msg.name, msg.action)
        .then(() => {
          this.emit({ type: "docker/volume/action/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/volume/action/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/fs/list") {
      const { requestId } = msg;
      return dockerService
        .fsList(msg.container, msg.path)
        .then((entries) => {
          this.emit({
            type: "docker/fs/list/response",
            payload: { requestId, error: null, path: msg.path, entries },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/fs/list/response",
            payload: { requestId, error: fail(error), path: msg.path, entries: [] },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/cp") {
      const { requestId } = msg;
      return dockerService
        .cp(msg.container, msg.direction, msg.containerPath, msg.hostPath)
        .then(() => {
          this.emit({ type: "docker/cp/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/cp/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/fs/read") {
      const { requestId } = msg;
      return dockerService
        .fsRead(msg.container, msg.path)
        .then(({ content, truncated }) => {
          this.emit({
            type: "docker/fs/read/response",
            payload: { requestId, error: null, content, truncated },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/fs/read/response",
            payload: { requestId, error: fail(error), content: "", truncated: false },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/fs/write") {
      const { requestId } = msg;
      return dockerService
        .fsWrite(msg.container, msg.path, msg.content)
        .then(() => {
          this.emit({ type: "docker/fs/write/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/fs/write/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/fs/op") {
      const { requestId } = msg;
      return dockerService
        .fsOp(msg.container, msg.op, msg.path, msg.newPath)
        .then(() => {
          this.emit({ type: "docker/fs/op/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/fs/op/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/subscribe") {
      const { requestId, subscriptionId } = msg;
      this.emit({
        type: "docker/subscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      void dockerStreams.subscribeSnapshot(subscriptionId, (snapshot) => {
        this.emit({ type: "docker/snapshot", payload: { subscriptionId, ...snapshot } });
      });
      return undefined;
    }
    if (msg.type === "docker/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      dockerStreams.unsubscribeSnapshot(subscriptionId);
      this.emit({
        type: "docker/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    if (msg.type === "docker/logs/subscribe") {
      const { requestId, subscriptionId } = msg;
      this.emit({
        type: "docker/logs/subscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      dockerStreams.subscribeLogs(subscriptionId, msg.container, msg.tail ?? 500, (chunk) => {
        this.emit({ type: "docker/log-chunk", payload: { subscriptionId, chunk } });
      });
      return undefined;
    }
    if (msg.type === "docker/logs/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      dockerStreams.unsubscribeLogs(subscriptionId);
      this.emit({
        type: "docker/logs/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    if (msg.type === "docker/stats/subscribe") {
      const { requestId, subscriptionId } = msg;
      this.emit({
        type: "docker/stats/subscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      dockerStreams.subscribeStats(subscriptionId, msg.container, (stats) => {
        this.emit({ type: "docker/stats-data", payload: { subscriptionId, stats } });
      });
      return undefined;
    }
    if (msg.type === "docker/stats/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      dockerStreams.unsubscribeStats(subscriptionId);
      this.emit({
        type: "docker/stats/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    return undefined;
  }
}
