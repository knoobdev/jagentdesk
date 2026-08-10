import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server as HTTPServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type pino from "pino";
import { WebSocketServer } from "ws";

import type { ExternalSocketMetadata, WebSocketLike } from "./websocket-server.js";

/**
 * Direct tailnet address clients dial for the /ws endpoint.
 */
export interface DirectTailnetAddress {
  host: string;
  port: number;
  useTls?: boolean;
}

/**
 * Abstraction over the daemon's tailnet (tsnet) listener.
 *
 * The real listener spawns the Go/tsnet bridge binary
 * (`packages/server/go/tsnet-bridge`) as a child process. The bridge joins the
 * tailnet and listens on `port`; clients dial `ws://<dnsName>:<port>/ws`. It
 * forwards raw TCP to a loopback ingress the Node daemon owns, which performs
 * the HTTP upgrade and WebSocket framing and hands each accepted socket to
 * `attachSocket`. Sockets reach the daemon through `attachExternalSocket` with
 * `transport: "tailnet"`, so the pairing challenge/signed-hello gate applies.
 *
 * An external `tailscale serve`/static-host mode is opt-in only. The normal
 * JAgentDesk path publishes an address only after the embedded tsnet bridge
 * reports `TSNET_READY`; it never silently advertises a configured hostname.
 */
export interface TsnetListener {
  readonly kind: "tsnet";
  /**
   * Direct host:port paired clients on the tailnet dial for /ws. Null when the
   * daemon is not reachable on a tailnet (no tailnet host configured, no bridge
   * ready, or the daemon has no TCP listen port).
   */
  getDirectAddress(): DirectTailnetAddress | null;
  /** Bind the tailnet listener and begin accepting application sockets. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface TsnetListenerOptions {
  logger: pino.Logger;
  /** Daemon listen port, reused as the tailnet serve port. 0 when the daemon
   * listens on a non-TCP target (unix socket / named pipe). */
  port: number;
  /** Static direct tailnet host (e.g. `myhost.tailnet.ts.net`) used in serve
   * mode. It is ignored unless `allowExternalServe` is explicitly true. */
  tailnetHost?: string | null;
  /** Explicit compatibility escape hatch for an externally managed serve. */
  allowExternalServe?: boolean;
  /** Whether tailnet dials should use wss (TLS). Defaults to false. */
  useTls?: boolean;
  /** Hands an accepted tailnet socket to the daemon WS server. */
  attachSocket(ws: WebSocketLike, metadata?: ExternalSocketMetadata): Promise<void>;
  /** Path to the tsnet bridge binary. Resolved from
   * `JAGENTDESK_TSNET_BRIDGE_BIN`, the package's built dist, or the source-tree
   * prebuilt binary when omitted. */
  bridgeBinary?: string;
  /** tsnet state directory (Tailscale login/session). Defaults to
   * `$JAGENTDESK_HOME/tailscale` when omitted. */
  stateDir?: string;
  /** JAGENTDESK_TAILSCALE_AUTH_KEY for first-time tailnet joins. */
  authKey?: string;
  /** Desired tailnet hostname. Defaults to the machine hostname in the bridge. */
  hostname?: string;
  /** Local status file consumed by the desktop health monitor. */
  statusFile?: string;
  /** Public Ed25519 key used by the desktop renderer for signed tailnet hello. */
  daemonPublicKeyB64?: string;
  /** Injectable process spawner (defaults to `node:child_process.spawn`). */
  spawnBridge?: (binary: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
}

export type TsnetListenerFactory = (options: TsnetListenerOptions) => TsnetListener;

const SERVER_PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function defaultBridgeCandidates(): string[] {
  return [
    process.env.JAGENTDESK_TSNET_BRIDGE_BIN ?? "",
    // In the built server, SERVER_PACKAGE_ROOT is packages/server/dist/server.
    // In source/test runs it is packages/server. Both layouts keep the bridge
    // under a sibling `go/tsnet-bridge` directory.
    // In the published package SERVER_PACKAGE_ROOT resolves to `dist`, while
    // the executable produced by build:tsnet-bridge lives under `dist/server`.
    // Prefer that freshly built binary over the source-tree fallback so a
    // desktop dev run cannot silently execute a stale bridge.
    path.join(SERVER_PACKAGE_ROOT, "server/go/tsnet-bridge/tailnet-bridge"),
    path.join(SERVER_PACKAGE_ROOT, "go/tsnet-bridge/tailnet-bridge"),
    path.join(SERVER_PACKAGE_ROOT, "../go/tsnet-bridge/tailnet-bridge"),
  ].filter((candidate) => candidate.length > 0 && existsSync(candidate));
}

function resolveBridgeBinary(explicit: string | undefined): string | null {
  if (explicit) {
    // An explicit path is honored as-is: spawn failures surface through the
    // child process error event rather than being silently downgraded to
    // serve mode. A missing auto-detected candidate falls through instead.
    return explicit;
  }
  const [found] = defaultBridgeCandidates();
  return found ?? null;
}

function defaultStateDir(jagentdeskHome: string | undefined): string {
  if (process.env.TS_STATE_DIR) {
    return process.env.TS_STATE_DIR;
  }
  return jagentdeskHome ? path.join(jagentdeskHome, "tailscale") : "";
}

/**
 * Default tsnet adapter.
 *
 * Spawns the Go/tsnet bridge and binds a loopback `/ws` ingress that hands
 * sockets to `options.attachSocket`. The direct address is only advertised
 * after the bridge prints `TSNET_READY <dnsName>` on stdout.
 */
export function createTsnetListener(options: TsnetListenerOptions): TsnetListener {
  const logger = options.logger.child({ module: "tsnet-listener" });
  let started = false;
  let stopped = false;
  let child: ChildProcess | null = null;
  let ingressServer: HTTPServer | null = null;
  let ingressWss: WebSocketServer | null = null;
  let readyHost: string | null = null;
  let loginUrl: string | null = null;
  let localProxyPort: number | null = null;

  function resolveConfiguredLocalProxyPort(): number {
    const raw = process.env.JAGENTDESK_TAILSCALE_PROXY_PORT?.trim() ?? "";
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 0;
  }

  const staticHost = (options.tailnetHost ?? "").trim();
  const allowExternalServe = options.allowExternalServe === true;
  const binary = resolveBridgeBinary(options.bridgeBinary);
  const stateDir = options.stateDir ?? defaultStateDir(undefined);

  function writeStatus(connected: boolean, host: string | null = null): void {
    if (!options.statusFile) return;
    try {
      mkdirSync(path.dirname(options.statusFile), { recursive: true });
      writeFileSync(
        options.statusFile,
        JSON.stringify({
          connected,
          host,
          loginUrl,
          port: connected ? options.port : null,
          tailnetProxyAddress: localProxyPort !== null ? `127.0.0.1:${localProxyPort}` : null,
          daemonPublicKeyB64: options.daemonPublicKeyB64 ?? null,
          updatedAt: Date.now(),
        }),
        "utf8",
      );
    } catch {
      // Health reporting is best effort and must never prevent the daemon from serving.
    }
  }

  function extractTailscaleLoginUrl(line: string): string | null {
    const marker = "https://login.tailscale.com/";
    const start = line.indexOf(marker);
    if (start < 0) return null;
    const candidate = line.slice(start).split(/\s+/)[0] ?? "";
    return candidate.replace(/[),.;]+$/, "") || null;
  }

  function recordLoginUrl(url: string): void {
    loginUrl = url;
    writeStatus(false);
    // The URL contains a one-time login token. Persist it for the renderer but
    // never put the token in daemon logs.
    logger.info(
      { port: options.port, loginUrlAvailable: true },
      "tsnet bridge awaiting interactive login",
    );
  }

  function attachBridgeOutputHandlers(bridgeProcess: ChildProcess): void {
    bridgeProcess.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("TSNET_READY ")) {
          const host = trimmed.slice("TSNET_READY ".length).trim();
          readyHost = host || null;
          // A login URL is one-time state. Once the bridge is ready, remove it
          // so a later restart can never reopen an obsolete browser URL.
          loginUrl = null;
          writeStatus(Boolean(readyHost), readyHost);
          continue;
        }
        if (trimmed.startsWith("TSNET_ERROR ")) {
          const message = trimmed.slice("TSNET_ERROR ".length).trim();
          logger.error({ message }, "tsnet bridge startup failed");
          readyHost = null;
          loginUrl = null;
          localProxyPort = null;
          writeStatus(false);
          continue;
        }
        const stdoutLoginUrl = extractTailscaleLoginUrl(trimmed);
        if (stdoutLoginUrl) {
          recordLoginUrl(stdoutLoginUrl);
          continue;
        }
        logger.info({ line: trimmed }, "tsnet bridge output");
      }
    });
    bridgeProcess.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const stderrLoginUrl = extractTailscaleLoginUrl(trimmed);
        if (stderrLoginUrl) {
          recordLoginUrl(stderrLoginUrl);
        } else {
          logger.debug({ stderr: trimmed }, "tsnet bridge stderr");
        }
      }
    });
    bridgeProcess.on("exit", (code, signal) => {
      logger.warn({ code, signal }, "tsnet bridge exited");
      readyHost = null;
      loginUrl = null;
      localProxyPort = null;
      writeStatus(false);
      child = null;
    });
    bridgeProcess.on("error", (error) => {
      logger.error({ err: error }, "tsnet bridge spawn failed");
      readyHost = null;
      loginUrl = null;
      localProxyPort = null;
      child = null;
      writeStatus(false);
    });
  }

  function shouldStartBridge(): boolean {
    if (options.port <= 0) {
      logger.info("tsnet listener unavailable: daemon has no TCP listen port");
      return false;
    }
    if (options.bridgeBinary && !options.spawnBridge && !existsSync(options.bridgeBinary)) {
      throw new Error("Configured Tailscale bridge does not exist: " + options.bridgeBinary);
    }
    if (!binary) {
      if (!allowExternalServe) {
        throw new Error(
          "Embedded Tailscale bridge is unavailable; build tailnet-bridge or explicitly enable external serve mode",
        );
      }
      // Explicit compatibility mode: an external tailscale process forwards
      // the daemon port. This is never enabled by the packaged app.
      logger.info(
        {
          host: staticHost || null,
          hint: "set JAGENTDESK_TSNET_BRIDGE_BIN or build go/tsnet-bridge to enable the embedded tailnet listener",
        },
        "tsnet listener: no bridge binary; relying on external tailscale serve",
      );
      return false;
    }

    // Only spawn the bridge when the daemon actually wants to join a tailnet:
    // an explicit bridge binary override, a TS auth key, or an existing tsnet
    // state directory. Otherwise the embedded listener would try to join with
    // no credentials and block startup.
    const stateDirExists = stateDir.length > 0 && existsSync(stateDir);
    const tailnetEnabled =
      options.authKey !== undefined ||
      stateDirExists ||
      options.bridgeBinary !== undefined ||
      process.env.JAGENTDESK_TAILSCALE_INTERACTIVE === "1";
    if (!tailnetEnabled) {
      logger.info(
        {
          host: staticHost || null,
          hint: "set JAGENTDESK_TAILSCALE_AUTH_KEY or a tailnet state directory to enable the embedded tailnet listener",
        },
        "tsnet listener: tailnet not enabled; skipping bridge",
      );
      return false;
    }
    return true;
  }

  function currentAddress(): DirectTailnetAddress | null {
    const host = readyHost ?? (allowExternalServe ? staticHost : "");
    if (!host || options.port <= 0) {
      return null;
    }
    return { host, port: options.port, ...(options.useTls ? { useTls: true } : {}) };
  }

  return {
    kind: "tsnet",
    getDirectAddress: () => currentAddress(),
    start: async () => {
      if (started || stopped) {
        return;
      }
      started = true;
      writeStatus(false);
      if (!shouldStartBridge()) return;
      if (!binary) return;

      // Local ingress the bridge forwards tailnet TCP to. It performs the HTTP
      // upgrade and WebSocket framing, then hands the socket to the daemon.
      const server = createServer();
      const wss = new WebSocketServer({ server, path: "/ws" });
      wss.on("connection", (ws) => {
        void options.attachSocket(ws as unknown as WebSocketLike, { transport: "tailnet" });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(resolveConfiguredLocalProxyPort(), "127.0.0.1", () => resolve());
      });
      ingressServer = server;
      ingressWss = wss;
      const localPort = (server.address() as AddressInfo).port;
      localProxyPort = localPort;
      // Persist the loopback ingress as soon as it exists. Desktop uses this
      // endpoint to send its own client through the same tailnet-authenticated
      // WebSocket path as mobile, without relying on the OS Tailscale DNS
      // resolver (the embedded tsnet node owns DNS internally).
      writeStatus(false);

      const args = [
        "--tailnet-port",
        String(options.port),
        "--local-port",
        String(localPort),
        ...(stateDir ? ["--state-dir", stateDir] : []),
        ...(options.hostname ? ["--hostname", options.hostname] : []),
        ...(options.useTls ? ["--tls"] : []),
      ];
      const spawnBridge = options.spawnBridge ?? spawn;
      child = spawnBridge(binary, args, {
        ...process.env,
        // The Go bridge consumes the standard Tailscale variable only inside
        // this child process. JAgentDesk configuration uses its own namespace.
        TS_AUTHKEY: options.authKey ?? process.env.JAGENTDESK_TAILSCALE_AUTH_KEY ?? "",
        TS_STATE_DIR: stateDir,
      });
      attachBridgeOutputHandlers(child);
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      started = false;
      readyHost = null;
      loginUrl = null;
      localProxyPort = null;
      writeStatus(false);

      if (child) {
        const proc = child;
        child = null;
        proc.kill("SIGTERM");
      }
      if (ingressWss) {
        ingressWss.close();
        ingressWss = null;
      }
      if (ingressServer) {
        const server = ingressServer;
        ingressServer = null;
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
      }
    },
  };
}
