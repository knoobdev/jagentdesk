// probe-mcp-tools.ts — connect a real MCP client straight to the daemon's
// /mcp/agents endpoint and list the tools it serves. No LLM. Answers: does the
// daemon actually expose kubectl_get to an agent MCP session?
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
const waitListen = (port: number, tries = 60): Promise<void> =>
  new Promise((res, rej) => {
    let n = 0;
    const tick = () => {
      const c = net.connect(port, "127.0.0.1", () => {
        c.destroy();
        res();
      });
      c.on("error", () => {
        c.destroy();
        if (++n > tries) rej(new Error("no listen"));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });

async function main() {
  const dPort = await freePort();
  const home = mkdtempSync(path.join(tmpdir(), "jad-mcpprobe-"));
  const serverDir = path.resolve(__dirname, "../../packages/server");
  const tsxBin = path.resolve(__dirname, "../../node_modules/.bin/tsx");
  const daemon = spawn(tsxBin, ["scripts/supervisor-entrypoint.ts", "--dev"], {
    cwd: serverDir,
    env: {
      ...process.env,
      JAGENTDESK_HOME: home,
      JAGENTDESK_LISTEN: `127.0.0.1:${dPort}`,
      JAGENTDESK_SERVER_ID: "srv_mcpprobe",
      JAGENTDESK_NODE_ENV: "development",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let derr = "";
  daemon.stderr?.on("data", (b: Buffer) => (derr = (derr + b).split("\n").slice(-30).join("\n")));
  const fin = (ok: boolean, msg: string) => {
    console.log(ok ? `\n✅ ${msg}` : `\n❌ ${msg}\n${derr.slice(-1200)}`);
    try {
      daemon.kill("SIGKILL");
    } catch {}
    process.exit(ok ? 0 : 1);
  };

  try {
    await waitListen(dPort);
    const url = new URL(`http://127.0.0.1:${dPort}/mcp/agents?callerAgentId=probe-agent`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "probe", version: "1.0.0" });
    await client.connect(transport);
    const res = (await client.listTools()) as { tools: Array<{ name: string }> };
    const names = res.tools.map((t) => t.name).sort();
    console.log(`[probe] ${names.length} tools served by /mcp/agents:`);
    console.log(names.join(", "));
    const hasGet = names.some((n) => /kubectl_get/.test(n));
    const hasApply = names.some((n) => /kubectl_apply/.test(n));
    await client.close();
    fin(
      hasGet && hasApply,
      `daemon MCP exposes kubectl_get=${hasGet} kubectl_apply=${hasApply}`,
    );
  } catch (e: unknown) {
    fin(false, `exception: ${e instanceof Error ? e.message : String(e)}`);
  }
}
void main();
