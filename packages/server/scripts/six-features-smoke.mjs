// Smoke check for the integrated daemon: one real RPC per feature (spec 26–31) against a built
// daemon. Usage: node scripts/six-features-smoke.mjs <port>
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

const port = Number(process.argv[2] ?? 47901);
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  clientId: `clid_six_smoke_${randomBytes(3).toString("hex")}`,
  clientType: "cli",
  appVersion: "0.9.47",
  webSocketFactory: (url, options) =>
    new WebSocket(url, options?.protocols, { headers: options?.headers }),
});

const results = [];
async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
  } catch (error) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      detail: String(error?.message ?? error),
    });
  }
}

await client.connect();
await new Promise((resolve) => setTimeout(resolve, 500));
const features = client.getLastServerInfoMessage()?.features ?? {};
await check("server_info features", async () => {
  const wanted = ["specMode", "activityGraph", "argocd", "sideload", "jira"];
  const missing = wanted.filter((key) => features[key] !== true);
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  return wanted.join(", ");
});
await check("jira.connections.list", async () => {
  const payload = await client.jiraRequest(
    "jira.connections.list.request",
    {},
    { timeoutMs: 5000 },
  );
  return `${payload.connections?.length ?? "?"} connections${payload.error ? ` error=${payload.error.code}` : ""}`;
});
await check("argocd.instances.list", async () => {
  const payload = await client.argocd("argocd.instances.list.request", {}, { timeout: 5000 });
  return `${payload.instances?.length ?? "?"} instances${payload.error ? ` error=${payload.error.code ?? payload.error}` : ""}`;
});
await check("sideload.accounts.list", async () => {
  const payload = await client.sideloadCall("sideload.accounts.list.request", {});
  return `${payload.accounts?.length ?? "?"} accounts${payload.error ? ` error=${payload.error.code ?? payload.error}` : ""}`;
});
await check("simulator/list (physical availability)", async () => {
  const payload = await client.simulatorList();
  return `devices=${payload.devices?.length ?? "?"} physical=${JSON.stringify(payload.availability?.physical ?? null)}`;
});
await check("agent.spec_mode.get (unknown agent)", async () => {
  const result = await client.specModeGet("agt_smoke_missing");
  return JSON.stringify(result).slice(0, 120);
});
await check("agent.activity_graph.get (unknown agent)", async () => {
  const result = await client.activityGraphGet({ agentId: "agt_smoke_missing", view: "flow" });
  return JSON.stringify(result).slice(0, 120);
});
await client.close?.();
for (const result of results) {
  console.log(
    `${result.ok ? "PASS" : "FAIL"}  ${result.name}  (${result.ms} ms)  ${result.detail}`,
  );
}
process.exit(results.every((result) => result.ok) ? 0 : 1);
