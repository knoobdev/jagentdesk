import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentShimEnv, installAgentBrowserShims, writeAgentShimEndpoint } from "./install.js";

const require = createRequire(import.meta.url);
const VITE_BIN = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

/**
 * Spec 04 A4.27b.4b, dev-server case: a Vite project with `server.open: true` started from an
 * agent's shell. On macOS Vite drives an already-open Chrome with `osascript` unless BROWSER is a
 * `.js` file, which it runs with Node instead. `ps` and `osascript` are stand-ins that report a
 * running Chrome and record the call, so the user's real Chrome is never touched.
 */
describe("agent browser shim with a Vite dev server", () => {
  let root: string;
  let shimDir: string;
  let fakeBin: string;
  let project: string;
  let callLog: string;
  let daemon: Server;
  const posted: Array<{ target: { url?: string } }> = [];

  /** The daemon's open route, reduced to recording what the shim sent. */
  async function recordOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as { target: { url?: string } };
    posted.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: body.target.url }));
  }

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-shim-vite-")));
    shimDir = path.join(root, "agent-bin");
    fakeBin = path.join(root, "fake-bin");
    project = path.join(root, "app");
    callLog = path.join(root, "system-calls.log");
    mkdirSync(fakeBin);
    mkdirSync(project);
    daemon = createHttpServer(recordOpen);
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    const { port } = daemon.address() as AddressInfo;
    await installAgentBrowserShims({ dir: shimDir, nodePath: process.execPath, electron: false });
    await writeAgentShimEndpoint({
      dir: shimDir,
      url: `http://127.0.0.1:${port}/api/agent-browser/open`,
      token: "vite-test",
    });
    writeFileSync(path.join(fakeBin, "ps"), "#!/bin/sh\necho ' 1 ?? 0:00.01 Google Chrome'\n", {
      mode: 0o755,
    });
    for (const name of ["osascript", "open", "xdg-open"]) {
      writeFileSync(path.join(fakeBin, name), `#!/bin/sh\necho "${name} $*" >> "${callLog}"\n`, {
        mode: 0o755,
      });
    }
    writeFileSync(path.join(project, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(
      path.join(project, "vite.config.mjs"),
      "export default { server: { open: true, host: '127.0.0.1' }, logLevel: 'silent' };\n",
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(callLog, { force: true });
    posted.length = 0;
  });

  async function startVite(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
    const port = await freePort();
    return spawn(process.execPath, [VITE_BIN, "--port", String(port), "--strictPort"], {
      cwd: project,
      env,
      stdio: "ignore",
    });
  }

  function systemCalls(): string[] {
    return existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : [];
  }

  it.runIf(process.platform === "darwin")(
    "without the BROWSER shim Vite drives the running Chrome through osascript",
    async () => {
      const shim = agentShimEnv({ dir: shimDir, basePath: `${fakeBin}:/usr/bin:/bin` });
      const vite = await startVite({ HOME: root, PATH: shim.PATH, JAGENTDESK_AGENT_ID: "a" });
      try {
        await waitFor(() => systemCalls().length > 0, 20_000);
      } finally {
        await stop(vite);
      }
      expect(systemCalls()[0]).toMatch(
        /^osascript openChrome\.js http:\/\/127\.0\.0\.1:\d+\/ Google Chrome$/,
      );
    },
  );

  it("with BROWSER on the shim, the dev server URL goes to the app and no osascript or open runs", async () => {
    const shim = agentShimEnv({ dir: shimDir, basePath: `${fakeBin}:/usr/bin:/bin` });
    const vite = await startVite({
      HOME: root,
      PATH: shim.PATH,
      BROWSER: shim.BROWSER,
      JAGENTDESK_AGENT_ID: "11111111-2222-4333-8444-555555555555",
    });
    try {
      await waitFor(() => posted.length > 0, 20_000);
      // Give a wrongly started osascript or open time to show up before stopping.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await stop(vite);
    }
    expect(posted).toHaveLength(1);
    expect(posted[0]?.target.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(systemCalls()).toEqual([]);
  });
});
