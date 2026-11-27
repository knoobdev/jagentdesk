import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentShimEnv,
  BROWSER_SHIM_FILE,
  installAgentBrowserShims,
  writeAgentShimEndpoint,
} from "./install.js";
import { NO_BROWSER_HOST_MESSAGE } from "./shim-script.js";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "shim-test-token";

interface Posted {
  authorization: string | undefined;
  body: { agentId: string; target: { url?: string; path?: string } };
}

/** A stand-in for the daemon's open route: records requests, answers as configured. */
class FakeDaemon {
  readonly posted: Posted[] = [];
  reply: { status: number; body: unknown } = { status: 200, body: { ok: true, url: "" } };
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = JSON.parse(raw) as Posted["body"];
        this.posted.push({ authorization: req.headers.authorization, body });
        const reply =
          this.reply.status === 200
            ? {
                ok: true,
                url:
                  body.target.url ??
                  `http://127.0.0.1/served/${path.basename(body.target.path ?? "")}`,
              }
            : this.reply.body;
        res.writeHead(this.reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/api/agent-browser/open`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

describe("agent browser shim", () => {
  const daemon = new FakeDaemon();
  let root: string;
  let shimDir: string;
  let fakeBin: string;
  let workspace: string;
  let callLog: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    // Real path: the shim resolves relative paths from process.cwd(), which macOS reports
    // under /private/var.
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-shim-")));
    shimDir = path.join(root, "agent-bin");
    fakeBin = path.join(root, "fake-bin");
    workspace = path.join(root, "workspace");
    callLog = path.join(root, "system-calls.log");
    await installAgentBrowserShims({
      dir: shimDir,
      nodePath: process.execPath,
      electron: false,
      platform: "darwin",
    });
    await writeAgentShimEndpoint({ dir: shimDir, url: await daemon.start(), token: TOKEN });
    // Stand-ins for the system commands, ahead of /usr/bin: the real `open` never runs here.
    spawnSync("mkdir", ["-p", fakeBin, workspace]);
    for (const name of ["open", "xdg-open"]) {
      const file = path.join(fakeBin, name);
      writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${callLog}"\n`, { mode: 0o755 });
    }
    writeFileSync(path.join(workspace, "report.html"), "<h1>report</h1>");
    writeFileSync(path.join(workspace, "a.pdf"), "%PDF-1.4");
    writeFileSync(path.join(workspace, "data.xlsx"), "xlsx");
    writeFileSync(path.join(workspace, "x.png"), "png");
    const shim = agentShimEnv({ dir: shimDir, basePath: `${fakeBin}:/usr/bin:/bin` });
    env = { HOME: root, PATH: shim.PATH, BROWSER: shim.BROWSER, JAGENTDESK_AGENT_ID: AGENT_ID };
  });

  afterAll(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    daemon.posted.length = 0;
    daemon.reply = { status: 200, body: null };
    rmSync(callLog, { force: true });
  });

  /** Async: the fake daemon answers from this same process while the shim waits. */
  function run(
    command: string,
    args: string[],
    overrides: NodeJS.ProcessEnv = {},
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: workspace, env: { ...env, ...overrides } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  function systemCalls(): string[] {
    return existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : [];
  }

  it("puts the shim directory first on PATH and BROWSER on the .js shim", async () => {
    expect(env.PATH?.split(":")[0]).toBe(shimDir);
    expect(env.BROWSER).toBe(path.join(shimDir, BROWSER_SHIM_FILE));
    expect((await run("/bin/sh", ["-c", "command -v open"])).stdout.trim()).toBe(
      path.join(shimDir, "open"),
    );
  });

  it.each([
    ["open https URL", "open", ["https://example.org"], { url: "https://example.org" }],
    ["open ./report.html", "open", ["./report.html"], { path: "report.html" }],
    [
      "open -g https URL",
      "open",
      ["-g", "https://example.org/x"],
      { url: "https://example.org/x" },
    ],
    ["open file:// pdf", "open", ["file://WORKSPACE/a.pdf"], { path: "a.pdf" }],
    [
      "xdg-open https URL",
      "xdg-open",
      ["http://localhost:3000/"],
      { url: "http://localhost:3000/" },
    ],
    ["xdg-open report.html", "xdg-open", ["report.html"], { path: "report.html" }],
  ])("%s opens in the app, not the system", async (_label, name, rawArgs, expected) => {
    const args = rawArgs.map((arg) => arg.replace("WORKSPACE", workspace));
    const result = await run(path.join(shimDir, name), args);
    expect(result.status).toBe(0);
    expect(systemCalls()).toEqual([]);
    expect(daemon.posted).toHaveLength(1);
    expect(daemon.posted[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(daemon.posted[0]?.body.agentId).toBe(AGENT_ID);
    const target = daemon.posted[0]!.body.target;
    if ("url" in expected) {
      expect(target).toEqual({ url: expected.url });
      expect(result.stdout).toBe(`Opened in the JAgentDesk browser: ${expected.url}\n`);
    } else {
      expect(target).toEqual({ path: path.join(workspace, expected.path) });
      expect(result.stdout).toContain("Opened in the JAgentDesk browser: ");
    }
  });

  it.each([
    ["open -a Preview x.png", "open", ["-a", "Preview", "x.png"]],
    ["open data.xlsx", "open", ["data.xlsx"]],
    ["open a missing .html", "open", ["missing.html"]],
    ["open a folder", "open", ["."]],
    ["xdg-open data.xlsx", "xdg-open", ["data.xlsx"]],
  ])("%s passes through to the system command unchanged", async (_label, name, args) => {
    const result = await run(path.join(shimDir, name), args);
    expect(result.status).toBe(0);
    expect(daemon.posted).toEqual([]);
    expect(systemCalls()).toEqual([`${name} ${args.join(" ")}`]);
  });

  it("opens web targets in the app and passes the rest through", async () => {
    const result = await run(path.join(shimDir, "open"), ["https://example.org", "data.xlsx"]);
    expect(result.status).toBe(0);
    expect(daemon.posted.map((entry) => entry.body.target)).toEqual([
      { url: "https://example.org" },
    ]);
    expect(systemCalls()).toEqual(["open data.xlsx"]);
  });

  it("is found by name from a shell, as an agent's command runs", async () => {
    const result = await run("/bin/sh", ["-c", "open ./report.html"]);
    expect(result.status).toBe(0);
    expect(daemon.posted.map((entry) => entry.body.target)).toEqual([
      { path: path.join(workspace, "report.html") },
    ]);
    expect(systemCalls()).toEqual([]);
  });

  it("runs as $BROWSER from a shell with a file:// URL", async () => {
    const pdf = pathToFileURL(path.join(workspace, "a.pdf")).href;
    const result = await run("/bin/sh", ["-c", `"$BROWSER" ${pdf}`]);
    expect(result.status).toBe(0);
    expect(daemon.posted.map((entry) => entry.body.target)).toEqual([
      { path: path.join(workspace, "a.pdf") },
    ]);
  });

  it("takes the last argument as the URL when a dev server runs it with node", async () => {
    // Vite and Create React App: spawn(process.execPath, [BROWSER, ...process.argv.slice(2), url]).
    const result = await run(process.execPath, [
      env.BROWSER!,
      "--port",
      "3000",
      "http://localhost:3000/",
    ]);
    expect(result.status).toBe(0);
    expect(daemon.posted.map((entry) => entry.body.target)).toEqual([
      { url: "http://localhost:3000/" },
    ]);
    expect(systemCalls()).toEqual([]);
  });

  it("with no browser host, fails with the spec message and opens nothing", async () => {
    daemon.reply = {
      status: 409,
      body: { ok: false, code: "browser_no_host", message: NO_BROWSER_HOST_MESSAGE },
    };
    for (const [name, args] of [
      ["open", ["https://example.org"]],
      ["open", ["report.html"]],
      [BROWSER_SHIM_FILE, ["http://localhost:3000/"]],
    ] as const) {
      const result = await run(path.join(shimDir, name), [...args]);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`${NO_BROWSER_HOST_MESSAGE}\n`);
    }
    expect(systemCalls()).toEqual([]);
  });

  it("never falls back to the system browser when JAgentDesk cannot be reached", async () => {
    const unknownAgent = await run(path.join(shimDir, "open"), ["https://example.org"], {
      JAGENTDESK_AGENT_ID: "",
    });
    expect(unknownAgent.status).toBe(1);
    expect(unknownAgent.stderr).toContain(NO_BROWSER_HOST_MESSAGE);
    expect(daemon.posted).toEqual([]);
    expect(systemCalls()).toEqual([]);
  });

  it("rejects BROWSER targets that are not web pages without opening anything", async () => {
    const result = await run(path.join(shimDir, BROWSER_SHIM_FILE), ["data.xlsx"]);
    expect(result.status).toBe(2);
    expect(daemon.posted).toEqual([]);
    expect(systemCalls()).toEqual([]);
  });

  const python = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!python)("is what Python's webbrowser runs", async () => {
    const result = await run("python3", [
      "-c",
      "import webbrowser, sys; sys.exit(0 if webbrowser.open('https://example.org/py') else 3)",
    ]);
    expect(result.status).toBe(0);
    expect(daemon.posted.map((entry) => entry.body.target)).toEqual([
      { url: "https://example.org/py" },
    ]);
    expect(systemCalls()).toEqual([]);
  });
});
