// audit-kube.ts — exercise EVERY cluster backend op against the real current
// kube context (docker-desktop) and report PASS/FAIL per function. Read-only or
// dry-run only; never mutates the cluster.
import { detectKubeContexts } from "../../packages/server/src/server/cluster/kube-config-source";
import { KubeClient, GENERIC_KINDS } from "../../packages/server/src/server/cluster/kube-client";

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    rows.push({ name, ok: true, detail });
  } catch (e) {
    rows.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

async function main() {
  const contexts = await detectKubeContexts();
  const wanted = process.env.AUDIT_CTX ?? "docker-desktop";
  const ctx =
    contexts.find((c) => c.name === wanted) ?? contexts.find((c) => c.current) ?? contexts[0];
  const client = new KubeClient(ctx.name);
  await client.connect();
  console.log(`[audit] context=${ctx.name} genericKinds=${GENERIC_KINDS.length}`);

  // ---- READ ops ----
  let firstPod: { ns: string; name: string; container?: string } | null = null;
  await check("listPods", async () => {
    const pods = await client.listPods();
    const p = pods[0] as unknown as { namespace?: string; name?: string };
    if (pods.length) firstPod = { ns: p.namespace ?? "kube-system", name: p.name ?? "" };
    return `${pods.length} pods`;
  });
  await check("listDeployments", async () => `${(await client.listDeployments()).length} deploys`);
  await check("listNodes", async () => `${(await client.listNodes()).length} nodes`);
  await check("listEvents", async () => `${(await client.listEvents()).length} events`);

  // Generic list across the full kind set.
  const genericKinds = GENERIC_KINDS.map((k) => k.kind);
  let genericFails = 0;
  const failedKinds: string[] = [];
  for (const k of genericKinds) {
    try {
      await client.listGeneric(k);
    } catch (e) {
      genericFails++;
      failedKinds.push(`${k}:${e instanceof Error ? e.message.slice(0, 40) : ""}`);
    }
  }
  rows.push({
    name: "listGeneric(all kinds)",
    ok: genericFails === 0,
    detail:
      genericFails === 0
        ? `all ${genericKinds.length} kinds listed`
        : `${genericFails}/${genericKinds.length} failed: ${failedKinds.slice(0, 6).join(" | ")}`,
  });

  // getResourceYaml across many kinds (the detail-view path) — pick one real
  // object per kind from a generic list and read it back.
  const detailKinds = [
    "Pod",
    "Deployment",
    "StatefulSet",
    "DaemonSet",
    "Service",
    "ConfigMap",
    "Secret",
    "ServiceAccount",
    "Node",
    "Namespace",
  ];
  let getFails = 0;
  const getFailed: string[] = [];
  for (const kind of detailKinds) {
    try {
      const entry = GENERIC_KINDS.find((g) => g.kind === kind);
      const list = await client.listGeneric(kind);
      if (!list.length) continue;
      const obj = list[0] as { metadata?: { name?: string; namespace?: string } };
      const yaml = await client.getResourceYaml(
        kind,
        entry?.namespaced ? obj.metadata?.namespace : undefined,
        obj.metadata?.name ?? "",
      );
      if (!yaml || yaml.length < 10) throw new Error("empty yaml");
    } catch (e) {
      getFails++;
      getFailed.push(`${kind}:${e instanceof Error ? e.message.slice(0, 40) : ""}`);
    }
  }
  rows.push({
    name: "getResourceYaml(detail kinds)",
    ok: getFails === 0,
    detail: getFails === 0 ? `all ${detailKinds.length} kinds read` : getFailed.join(" | "),
  });

  // Logs from a real pod (coredns).
  await check("getPodLogs", async () => {
    const pods = (await client.listGeneric("Pod")) as Array<{
      metadata?: { name?: string; namespace?: string };
    }>;
    const cd = pods.find((p) => (p.metadata?.name ?? "").startsWith("coredns")) ?? pods[0];
    const logs = await client.getPodLogs(
      cd.metadata?.namespace ?? "kube-system",
      cd.metadata?.name ?? "",
    );
    return `${logs.split("\n").length} log lines from ${cd.metadata?.name}`;
  });

  // Metrics (metrics-server may be absent on docker-desktop).
  await check(
    "getNodeMetrics",
    async () => `${(await client.getNodeMetrics()).length} node metrics`,
  );
  await check("getPodMetrics", async () => `${(await client.getPodMetrics()).length} pod metrics`);

  // ---- WRITE ops (dry-run only) ----
  await check("applyWrite scale (dryRun)", async () => {
    const deps = (await client.listGeneric("Deployment")) as Array<{
      metadata?: { name?: string; namespace?: string };
    }>;
    const d = deps[0];
    const r = await client.applyWrite({
      kind: "Deployment",
      namespace: d.metadata?.namespace,
      name: d.metadata?.name ?? "",
      action: "scale",
      replicas: 1,
      dryRun: true,
    });
    if (!r.ok) throw new Error(r.message);
    return `dryRun ok: ${r.message}`;
  });
  await check("applyWrite restart (dryRun)", async () => {
    const deps = (await client.listGeneric("Deployment")) as Array<{
      metadata?: { name?: string; namespace?: string };
    }>;
    const d = deps[0];
    const r = await client.applyWrite({
      kind: "Deployment",
      namespace: d.metadata?.namespace,
      name: d.metadata?.name ?? "",
      action: "restart",
      dryRun: true,
    });
    if (!r.ok) throw new Error(r.message);
    return `dryRun ok`;
  });
  await check("applyGeneric configmap (dryRun)", async () => {
    const r = await client.applyGeneric(
      `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: jagentdesk-audit\n  namespace: default\ndata:\n  x: "1"\n`,
      true,
    );
    if (!r.ok || !r.dryRun) throw new Error(r.message);
    return `dryRun ok`;
  });

  // ---- exec (find a pod with a shell) ----
  await check("execInPod", async () => {
    const pods = (await client.listGeneric("Pod")) as Array<{
      metadata?: { name?: string; namespace?: string };
      spec?: { containers?: Array<{ name?: string }> };
      status?: { phase?: string };
    }>;
    const running = pods.filter((p) => p.status?.phase === "Running");
    // Prefer app pods (e.g. qdrant) that ship a shell over kube-system distroless
    // images that legitimately have none.
    const appFirst = [
      ...running.filter((p) => (p.metadata?.namespace ?? "") !== "kube-system"),
      ...running.filter((p) => (p.metadata?.namespace ?? "") === "kube-system"),
    ];
    const candidates = appFirst.slice(0, 10);
    const errors: string[] = [];
    for (const p of candidates) {
      const ns = p.metadata?.namespace ?? "";
      const name = p.metadata?.name ?? "";
      const container = p.spec?.containers?.[0]?.name;
      try {
        const out = await new Promise<string>((resolve, reject) => {
          let buf = "";
          const timer = setTimeout(() => reject(new Error("timeout")), 8000);
          client
            .execInPod(ns, name, container, ["/bin/sh", "-c", "echo EXEC_OK"], (t) => {
              buf += t;
              if (buf.includes("EXEC_OK")) {
                clearTimeout(timer);
                resolve(buf);
              }
            })
            .then((h) => setTimeout(() => h.close(), 6000))
            .catch((e) => {
              clearTimeout(timer);
              reject(e);
            });
        });
        if (out.includes("EXEC_OK")) return `works on ${name} (container ${container})`;
      } catch (e) {
        errors.push(`${name}:${e instanceof Error ? e.message.slice(0, 30) : ""}`);
      }
    }
    throw new Error(`no pod exec succeeded. tried: ${errors.slice(0, 4).join(" | ")}`);
  });

  // ---- port-forward (start + immediately close) ----
  await check("startPortForward", async () => {
    const pods = (await client.listGeneric("Pod")) as Array<{
      metadata?: { name?: string; namespace?: string };
      status?: { phase?: string };
    }>;
    const cd = pods.find((p) => (p.metadata?.name ?? "").startsWith("coredns"));
    if (!cd) throw new Error("no coredns pod");
    const h = await client.startPortForward(
      cd.metadata?.namespace ?? "kube-system",
      cd.metadata?.name ?? "",
      53,
      () => {},
    );
    h.close();
    return `forward started+closed on ${cd.metadata?.name}:53`;
  });

  // ---- report ----
  console.log("\n================ K8S FUNCTION AUDIT ================");
  for (const r of rows) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name.padEnd(32)} ${r.detail}`);
  }
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length}/${rows.length} passed.`);
  if (failed.length) console.log("FAILED:", failed.map((r) => r.name).join(", "));
  process.exit(0);
}

main().catch((err) => {
  console.error("AUDIT_CRASH:", err?.message ?? err);
  process.exit(1);
});
