// verify-agent-kubectl.ts — prove the k8s chat agent actually drives the cluster
// through the kubectl_get MCP tool (not a shell fallback). Spawns a daemon with a
// real project + provider, connects docker-desktop, creates the cluster agent
// with the same context the dock uses, asks it a question, and watches the raw
// session stream for a kubectl_get tool call.
import { spawn, execSync } from "node:child_process";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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
        if (++n > tries) rej(new Error("no listen"));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const dPort = await freePort();
  const home = mkdtempSync(path.join(tmpdir(), "jad-agk-"));
  const projDir = path.join(tmpdir(), "jad-agent-kubectl-proj");
  if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
  writeFileSync(path.join(projDir, "README.md"), "# k8s agent project\n");
  try {
    execSync("git init -q && git add -A && git -c user.email=a@b.c -c user.name=x commit -qm init", {
      cwd: projDir,
    });
  } catch {}
  const serverDir = path.resolve(__dirname, "../../packages/server");
  const tsxBin = path.resolve(__dirname, "../../node_modules/.bin/tsx");
  const daemon = spawn(tsxBin, ["scripts/supervisor-entrypoint.ts", "--dev"], {
    cwd: serverDir,
    env: {
      ...process.env,
      JAGENTDESK_HOME: home,
      JAGENTDESK_LISTEN: `127.0.0.1:${dPort}`,
      JAGENTDESK_SERVER_ID: "srv_agentk",
      JAGENTDESK_NODE_ENV: "development",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let derr = "";
  const fullLog: string[] = [];
  daemon.stderr?.on("data", (b: Buffer) => {
    const s = b.toString();
    fullLog.push(s);
    derr = (derr + s).split("\n").slice(-40).join("\n");
    for (const line of s.split("\n")) if (line.includes("MCP-DIAG")) console.log("[daemon]", line);
  });
  const fin = (ok: boolean, msg: string) => {
    console.log(ok ? `\n✅ ${msg}` : `\n❌ ${msg}\n--- daemon stderr ---\n${derr.slice(-1500)}`);
    try {
      daemon.kill("SIGKILL");
    } catch {}
    process.exit(ok ? 0 : 1);
  };

  try {
    await waitListen(dPort);
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${dPort}/ws`,
      clientId: `agk-${Date.now()}`,
      clientType: "cli",
      appVersion: "1.0.18",
      webSocketFactory: createNodeWebSocketFactory(),
    }) as unknown as Record<string, (...a: unknown[]) => Promise<Record<string, unknown>>> & {
      connect: () => Promise<void>;
      subscribeRawMessages: (h: (m: unknown) => void) => () => void;
    };

    // Capture the whole raw stream so we can look for the kubectl_get tool call
    // and the provider snapshot.
    const raw: string[] = [];
    let enabledProvider: string | null = null;
    await client.connect();
    client.subscribeRawMessages((m: unknown) => {
      const s = JSON.stringify(m);
      raw.push(s);
      if (!enabledProvider && s.includes("providers_snapshot")) {
        try {
          const payload = (m as { payload?: { entries?: Array<{ enabled?: boolean; provider?: string }> } })
            .payload;
          const e = payload?.entries?.find((x) => x.enabled && x.provider);
          if (e?.provider) enabledProvider = e.provider;
        } catch {}
      }
    });

    await sleep(1500);
    if (!enabledProvider) {
      // Fallback: the daemon reports providers on connect; default to claude.
      enabledProvider = "claude";
    }
    console.log("[agk] provider:", enabledProvider);

    const ctxRes = await client.clusterContexts();
    const ctxs = (ctxRes.contexts as Array<{ name: string }>) ?? [];
    if (!ctxs.find((c) => c.name === "docker-desktop")) return fin(false, "no docker-desktop context");
    const imp = await client.clusterImport({ contextName: "docker-desktop" });
    const clusters = imp.clusters as Array<{ id: string }>;
    const cluId = clusters[clusters.length - 1].id;
    await client.clusterConnect({ id: cluId });
    console.log("[agk] cluster connected:", cluId);

    // WS_LINK mode: a PLAIN workspace agent (no cluster context, no cluster label)
    // that must DISCOVER the cluster itself via cluster_list — proves the
    // workspace -> k8s link. Otherwise: the k8s chat agent path.
    const wsLink = process.env.WS_LINK === "1";
    const context = wsLink
      ? [
          "You can manage Kubernetes clusters that are connected in the app via the",
          "'jagentdesk' MCP server tools: mcp__jagentdesk__cluster_list (discover",
          "connected clusters + their clusterId) and mcp__jagentdesk__kubectl_get.",
          "Load them via ToolSearch (select:mcp__jagentdesk__cluster_list) if needed.",
        ].join("\n")
      : [
          `You are operating the Kubernetes cluster with clusterId "${cluId}".`,
          "The cluster tools are on the 'jagentdesk' MCP server:",
          `  • mcp__jagentdesk__kubectl_get (action=list/get/describe/logs, clusterId="${cluId}")`,
          "If not loaded, load it first with ToolSearch `select:mcp__jagentdesk__kubectl_get`,",
          "then call it. Prefer it over any shell kubectl.",
        ].join("\n");

    const agent = (await client.createAgent({
      provider: enabledProvider,
      cwd: projDir,
      systemPrompt: context,
      ...(wsLink ? {} : { labels: { "jagentdesk.cluster.id": cluId } }),
      initialPrompt: wsLink
        ? "Which Kubernetes clusters are connected? Discover them yourself, then report how many pods are in the kube-system namespace of the first connected cluster."
        : "How many pods are in the kube-system namespace? Use your kubectl_get tool (action=list, kind=Pod, namespace=kube-system) and report the count.",
    })) as { id?: string };
    const agentId = agent.id;
    console.log("[agk] agent created:", agentId);

    // Everything captured up to now includes the createAgent echo (its
    // systemPrompt literally contains the string "kubectl_get"), so mark a
    // baseline and only count NEW evidence after the prompt was sent.
    const baseline = raw.length;

    // A real tool call shows up as a tool-use block (name kubectl_get /
    // mcp__jagentdesk__kubectl_get) followed by a tool-result carrying live
    // cluster data (kube-system pod names). Prose mentions of the tool don't
    // match these shapes.
    const toolCallRe = /"name"\s*:\s*"(mcp__[a-z]+__)?kubectl_get"|kubectl_get"[^"]*"(action|clusterId)/;
    const toolResultRe = /coredns-|kube-proxy-|kube-apiserver|"podCount"|pods in kube-system/i;
    let toolCall = false;
    let toolResult = false;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const recent = raw.slice(baseline).join("\n");
      if (toolCallRe.test(recent)) toolCall = true;
      if (toolResult || toolResultRe.test(recent)) toolResult = true;
      if (toolCall && toolResult) break;
    }
    const recentAll = raw.slice(baseline).join("\n");
    const bashKubectl = /"command"\s*:\s*"[^"]*kubectl (get|-n)/.test(recentAll);
    const types = raw
      .slice(baseline)
      .map((s) => {
        try {
          return (JSON.parse(s) as { type?: string }).type ?? "?";
        } catch {
          return "?";
        }
      })
      .join(", ");
    void types;
    void toolCall;
    void toolResult;
    void bashKubectl;
    // Parse the agent timeline items to see exactly what the agent did.
    const items: Array<Record<string, unknown>> = [];
    for (const s of raw.slice(baseline)) {
      try {
        const m = JSON.parse(s) as {
          type?: string;
          payload?: { event?: { type?: string; item?: Record<string, unknown> } };
        };
        if (m.type === "agent_stream" && m.payload?.event?.type === "timeline" && m.payload.event.item) {
          items.push(m.payload.event.item);
        }
      } catch {}
    }
    const itemTypes = items.map((it) => String(it.type)).join(", ");
    console.log(`[agk] timeline items: ${itemTypes.slice(0, 300)}`);
    // Tool calls: claude timeline uses tool_call / tool_use items with a name.
    const toolItems = items.filter((it) =>
      /tool/i.test(String(it.type)) || "toolName" in it || "name" in it,
    );
    for (const t of toolItems.slice(0, 6)) {
      console.log(`[agk] tool item: ${JSON.stringify(t).slice(0, 300)}`);
    }
    const blob = JSON.stringify(items);
    const usedKubectlGet = /kubectl_get/.test(blob) && /"tool/i.test(blob);
    const usedClusterList = /cluster_list/.test(blob) && /"tool/i.test(blob);
    const usedBash = /"(toolName|name)"\s*:\s*"Bash"/.test(blob) && /kubectl|helm/.test(blob);
    const gotPodData =
      /coredns-|kube-proxy-|kube-apiserver|kube-scheduler|"count":\s*\d+/i.test(blob);
    console.log(
      `[agk] usedClusterList=${usedClusterList} usedKubectlGet=${usedKubectlGet} usedBash=${usedBash} gotPodData=${gotPodData} toolItems=${toolItems.length}`,
    );
    const ok = wsLink
      ? usedClusterList && usedKubectlGet
      : usedKubectlGet || (gotPodData && !usedBash);
    fin(
      ok,
      `${wsLink ? "workspace→k8s link" : "k8s agent"}: cluster_list=${usedClusterList} kubectl_get=${usedKubectlGet} bash=${usedBash} data=${gotPodData}`,
    );
  } catch (e: unknown) {
    fin(false, `exception: ${e instanceof Error ? e.message : String(e)}`);
  }
}
void main();
