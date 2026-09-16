import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import { spawnProcess } from "../../utils/spawn.js";

// Cloudflare quick tunnel wrapper (spec §21.9 / ADR-0018). Spawns
// `cloudflared tunnel --url http://127.0.0.1:<port>`, scrapes the ephemeral
// `*.trycloudflare.com` URL from its output, and is a child process so the URL dies the
// moment we stop it or the daemon exits. No Cloudflare account/token needed.

// cloudflared prints the public URL on stderr, e.g.:
//   |  https://random-words-1234.trycloudflare.com                                   |
const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class CloudflaredMissingError extends Error {
  constructor() {
    super(
      "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) to share sessions.",
    );
    this.name = "CloudflaredMissingError";
  }
}

export interface TunnelHandle {
  url: string;
  stop: () => Promise<void>;
}

export class TunnelManager {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ module: "tunnel-manager" });
  }

  // Start a quick tunnel to a local port and resolve once the public URL appears.
  // Rejects with CloudflaredMissingError if the binary is absent, or on timeout.
  async start(localPort: number, timeoutMs = 30_000): Promise<TunnelHandle> {
    let child: ChildProcess;
    try {
      child = spawnProcess("cloudflared", [
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://127.0.0.1:${localPort}`,
      ]);
    } catch {
      throw new CloudflaredMissingError();
    }

    return await new Promise<TunnelHandle>((resolve, reject) => {
      let settled = false;
      let buffered = "";

      const stop = async (): Promise<void> => {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      };

      const finishOk = (url: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.logger.info({ url, localPort }, "Cloudflare quick tunnel ready");
        resolve({ url, stop });
      };
      const finishErr = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void stop();
        reject(err);
      };

      const scan = (chunk: Buffer): void => {
        buffered += chunk.toString();
        const match = buffered.match(TRYCLOUDFLARE_URL);
        if (match) finishOk(match[0]);
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);

      child.on("error", (err: NodeJS.ErrnoException) => {
        finishErr(err.code === "ENOENT" ? new CloudflaredMissingError() : err);
      });
      child.on("exit", (code) => {
        finishErr(new Error(`cloudflared exited before the tunnel was ready (code ${code})`));
      });

      const timer = setTimeout(() => {
        finishErr(new Error(`Timed out waiting for the Cloudflare tunnel (${timeoutMs}ms)`));
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }
}
