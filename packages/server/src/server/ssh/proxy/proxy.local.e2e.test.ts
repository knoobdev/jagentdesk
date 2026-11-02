import { execFile } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectThroughProxy } from "./connect.js";
import type { SshProxyConfig } from "./connect.js";
import { ProxyError } from "./proxy-error.js";

const execFileAsync = promisify(execFile);

// Real-proxy integration (spec 25.3 step 2, 25.2 SshServer.proxy). Everything runs
// against real containers on a dedicated Docker network; the tunnel target is the
// test sshd (published on host port 2242 per the milestone prompt).

const NETWORK = "jad-ssh-proxy-net";
const SSHD = { host: "jad-sshd-proxy", port: 2222 };
const PROXY_PASSWORD = "proxypass";
const READY_TIMEOUT_MS = 60_000;

interface ContainerSpec {
  name: string;
  runArgs: string[];
  hostPort: number;
}

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const TOPOLOGY: ContainerSpec[] = [
  {
    name: "jad-sshd-proxy",
    hostPort: 2242,
    runArgs: [
      "run",
      "-d",
      "--name",
      "jad-sshd-proxy",
      "--network",
      NETWORK,
      "-p",
      "2242:2222",
      "-e",
      "PASSWORD_ACCESS=true",
      "-e",
      "USER_NAME=jad",
      "-e",
      "USER_PASSWORD=jadtest",
      "-e",
      "SUDO_ACCESS=true",
      "lscr.io/linuxserver/openssh-server",
    ],
  },
  {
    name: "jad-socks5-open",
    hostPort: 2243,
    runArgs: [
      "run",
      "-d",
      "--name",
      "jad-socks5-open",
      "--network",
      NETWORK,
      "-p",
      "2243:1080",
      "-e",
      "REQUIRE_AUTH=false",
      "serjs/go-socks5-proxy",
    ],
  },
  {
    name: "jad-socks5-auth",
    hostPort: 2244,
    runArgs: [
      "run",
      "-d",
      "--name",
      "jad-socks5-auth",
      "--network",
      NETWORK,
      "-p",
      "2244:1080",
      "-e",
      "REQUIRE_AUTH=true",
      "-e",
      "PROXY_USER=proxyuser",
      "-e",
      `PROXY_PASSWORD=${PROXY_PASSWORD}`,
      "serjs/go-socks5-proxy",
    ],
  },
  {
    name: "jad-tinyproxy",
    hostPort: 2245,
    runArgs: [
      "run",
      "-d",
      "--name",
      "jad-tinyproxy",
      "--network",
      NETWORK,
      "-p",
      "2245:8888",
      "-v",
      `${fixture("tinyproxy.conf")}:/etc/tinyproxy/tinyproxy.conf:ro`,
      "ajoergensen/tinyproxy",
    ],
  },
  {
    name: "jad-tinyproxy-auth",
    hostPort: 2246,
    runArgs: [
      "run",
      "-d",
      "--name",
      "jad-tinyproxy-auth",
      "--network",
      NETWORK,
      "-p",
      "2246:8888",
      "-v",
      `${fixture("tinyproxy-auth.conf")}:/etc/tinyproxy/tinyproxy.conf:ro`,
      "ajoergensen/tinyproxy",
    ],
  },
];

const socks5Open: SshProxyConfig = { type: "socks5", host: "127.0.0.1", port: 2243 };
const socks5Auth: SshProxyConfig = {
  type: "socks5",
  host: "127.0.0.1",
  port: 2244,
  username: "proxyuser",
  password: PROXY_PASSWORD,
};
const httpOpen: SshProxyConfig = { type: "http", host: "127.0.0.1", port: 2245 };
const httpAuth: SshProxyConfig = {
  type: "http",
  host: "127.0.0.1",
  port: 2246,
  username: "proxyuser",
  password: PROXY_PASSWORD,
};

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 30_000 });
  return stdout.trim();
}

const startedContainers: string[] = [];
let startedNetwork = false;

beforeAll(async () => {
  const existing = await docker(["network", "ls", "-q", "--filter", `name=^${NETWORK}$`]);
  if (existing === "") {
    await docker(["network", "create", NETWORK]);
    startedNetwork = true;
  }
  for (const spec of TOPOLOGY) {
    await ensureContainer(spec);
    await ensureAttached(spec.name);
    await waitForPort(spec.hostPort);
  }
});

afterAll(async () => {
  for (const name of startedContainers) {
    await docker(["rm", "-f", name]);
  }
  if (startedNetwork) {
    await docker(["network", "rm", NETWORK]);
  }
});

async function ensureContainer(spec: ContainerSpec): Promise<void> {
  const any = await docker(["ps", "-aq", "--filter", `name=^${spec.name}$`]);
  if (any === "") {
    await docker(spec.runArgs);
    startedContainers.push(spec.name);
    return;
  }
  const running = await docker(["ps", "-q", "--filter", `name=^${spec.name}$`]);
  if (running === "") {
    await docker(["start", spec.name]);
  }
}

async function ensureAttached(name: string): Promise<void> {
  const networks = await docker([
    "inspect",
    "-f",
    "{{range $k, $v := .NetworkSettings.Networks}}{{$k}},{{end}}",
    name,
  ]);
  if (!networks.split(",").includes(NETWORK)) {
    await docker(["network", "connect", NETWORK, name]);
  }
}

function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`port ${port} never accepted connections`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function catchProxyError(promise: Promise<net.Socket>): Promise<ProxyError> {
  return promise.then(
    (socket) => {
      socket.destroy();
      throw new Error("connectThroughProxy unexpectedly resolved");
    },
    (error: unknown) => {
      if (error instanceof ProxyError) return error;
      throw error;
    },
  );
}

async function runUnameThroughProxy(proxy: SshProxyConfig): Promise<string> {
  const socket = await connectThroughProxy(proxy, SSHD);
  const client = new Client();
  const output = await new Promise<string>((resolve, reject) => {
    client.on("ready", () => {
      client.exec("uname -s", (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = "";
        stream.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        stream.on("error", reject);
        stream.on("close", (code) => {
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(`uname exited with code ${code}`));
        });
      });
    });
    client.on("error", reject);
    client.connect({
      sock: socket,
      username: "jad",
      password: "jadtest",
      hostVerifier: () => true,
    });
  });
  client.end();
  return output;
}

describe("connectThroughProxy against real proxies", () => {
  it("tunnels an ssh2 password-auth connection through a no-auth SOCKS5 proxy", async () => {
    expect(await runUnameThroughProxy(socks5Open)).toBe("Linux");
  });

  it("tunnels an ssh2 password-auth connection through a username/password SOCKS5 proxy", async () => {
    expect(await runUnameThroughProxy(socks5Auth)).toBe("Linux");
  });

  it("tunnels an ssh2 password-auth connection through a plain HTTP CONNECT proxy", async () => {
    expect(await runUnameThroughProxy(httpOpen)).toBe("Linux");
  });

  it("tunnels an ssh2 password-auth connection through a Basic-auth HTTP CONNECT proxy", async () => {
    expect(await runUnameThroughProxy(httpAuth)).toBe("Linux");
  });

  it("reports proxy_auth_failed when the SOCKS5 proxy rejects the credentials", async () => {
    const error = await catchProxyError(
      connectThroughProxy(
        { type: "socks5", host: "127.0.0.1", port: 2244, username: "proxyuser", password: "nope" },
        SSHD,
      ),
    );
    expect(error.code).toBe("proxy_auth_failed");
  });

  it("reports proxy_auth_failed when the HTTP proxy rejects the credentials", async () => {
    const error = await catchProxyError(
      connectThroughProxy(
        { type: "http", host: "127.0.0.1", port: 2246, username: "proxyuser", password: "nope" },
        SSHD,
      ),
    );
    expect(error.code).toBe("proxy_auth_failed");
  });

  it("reports proxy_refused when the SOCKS5 proxy cannot reach the target port", async () => {
    const error = await catchProxyError(
      connectThroughProxy(socks5Open, { host: "jad-sshd-proxy", port: 2299 }),
    );
    expect(error.code).toBe("proxy_refused");
  });

  it("reports proxy_unreachable when the HTTP proxy cannot reach the target port", async () => {
    const error = await catchProxyError(
      connectThroughProxy(httpOpen, { host: "jad-sshd-proxy", port: 2299 }),
    );
    expect(error.code).toBe("proxy_unreachable");
  });

  it("reports proxy_unreachable when nothing listens on the proxy port", async () => {
    const error = await catchProxyError(
      connectThroughProxy({ type: "socks5", host: "127.0.0.1", port: 2241 }, SSHD),
    );
    expect(error.code).toBe("proxy_unreachable");
  });

  it("reports proxy_unreachable when the proxy never answers the CONNECT", async () => {
    const error = await catchProxyError(
      connectThroughProxy(socks5Open, { host: "10.255.255.1", port: 9 }, { timeoutMs: 1500 }),
    );
    expect(error.code).toBe("proxy_unreachable");
  });
});
