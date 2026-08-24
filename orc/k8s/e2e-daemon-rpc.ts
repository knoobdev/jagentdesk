import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient } from "../../packages/client/src/index";
import { createNodeWebSocketFactory } from "../../packages/app/e2e/support/helpers/node-ws-factory";

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
        if (++n > tries) rej(new Error("daemon did not listen"));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });

async function main() {
  let port = await freePort();
  while (port === 6767) port = await freePort();
  const home = mkdtempSync(path.join(tmpdir(), "jad-e2e-k8s-"));
  const serverDir = path.resolve(__dirname, "../../packages/server");
  const tsxBin = path.resolve(__dirname, "../../node_modules/.bin/tsx");
  console.log(`[e2e] spawning daemon on 127.0.0.1:${port} home=${home}`);
  const daemon = spawn(tsxBin, ["scripts/supervisor-entrypoint.ts", "--dev"], {
    cwd: serverDir,
    env: {
      ...process.env,
      JAGENTDESK_HOME: home,
      JAGENTDESK_LISTEN: `127.0.0.1:${port}`,
      JAGENTDESK_NODE_ENV: "development",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let derr = "";
  daemon.stderr?.on("data", (b: Buffer) => (derr = (derr + b.toString()).split("\n").slice(-30).join("\n")));

  const done = (ok: boolean, msg: string) => {
    console.log(ok ? `\n[e2e] ✅ ${msg}` : `\n[e2e] ❌ ${msg}\n--- daemon stderr ---\n${derr}`);
    try { daemon.kill("SIGKILL"); } catch {}
    process.exit(ok ? 0 : 1);
  };

  try {
    await waitListen(port);
    console.log("[e2e] daemon listening");
    const client: any = new DaemonClient({
      url: `ws://127.0.0.1:${port}/ws`,
      clientId: `e2e-k8s-${Date.now()}`,
      clientType: "cli",
      appVersion: "1.0.16",
      webSocketFactory: createNodeWebSocketFactory(),
    });
    await client.connect();
    console.log("[e2e] client connected + paired (dev local)");

    const ctxRes = await client.clusterContexts();
    if (ctxRes.error) return done(false, `clusterContexts error: ${ctxRes.error}`);
    const ctxs = ctxRes.contexts ?? [];
    console.log(`[e2e] contexts=${ctxs.length}: ${ctxs.map((c: any) => c.name).join(", ").slice(0, 200)}`);
    if (!ctxs.length) return done(false, "no kube contexts detected via daemon RPC");

    const target = ctxs.find((c: any) => c.current) ?? ctxs[0];
    const imp = await client.clusterImport({ contextName: target.name });
    if (imp.error) return done(false, `clusterImport error: ${imp.error}`);
    const clu = imp.clusters[imp.clusters.length - 1];
    console.log(`[e2e] imported cluster id=${clu.id} ctx=${clu.contextName}`);

    const con = await client.clusterConnect({ id: clu.id });
    if (con.error || !con.cluster) return done(false, `clusterConnect error: ${con.error}`);
    console.log(`[e2e] connected state=${con.cluster.state} nodes=${con.cluster.nodeCount} pods=${con.cluster.podCount}`);

    const pods = await client.clusterResources({ id: clu.id, kind: "pods" });
    if (pods.error) return done(false, `clusterResources pods error: ${pods.error}`);
    console.log(`[e2e] RPC clusterResources pods=${(pods.items ?? []).length} (first: ${(pods.items?.[0] as any)?.name})`);

    const kinds = await client.clusterKinds({ id: clu.id });
    console.log(`[e2e] RPC clusterKinds=${(kinds.kinds ?? []).length}`);

    const svc = await client.clusterResourceList({ id: clu.id, kind: "Service" });
    console.log(`[e2e] RPC clusterResourceList Service=${(svc.items ?? []).length}`);

    const helm = await client.clusterHelmList({ id: clu.id });
    console.log(`[e2e] RPC clusterHelmList releases=${(helm.releases ?? []).length} err=${helm.error ?? "none"}`);

    if ((pods.items ?? []).length > 0 && (kinds.kinds ?? []).length >= 30) {
      return done(true, `DAEMON RPC E2E PASS: real pods=${pods.items.length}, kinds=${kinds.kinds.length}, services=${(svc.items ?? []).length} via full daemon->protocol->client stack`);
    }
    return done(false, "assertions failed (pods/kinds)");
  } catch (e: any) {
    return done(false, `exception: ${e?.message ?? e}`);
  }
}
main();
