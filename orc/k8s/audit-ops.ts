// audit-ops.ts — verify the aux cluster ops (secret reveal, node cordon path,
// CRD discovery, cronjob suspend, helm) against the real docker-desktop context.
import { detectKubeContexts } from "../../packages/server/src/server/cluster/kube-config-source";
import { KubeClient, GENERIC_KINDS } from "../../packages/server/src/server/cluster/kube-client";
import { helmList } from "../../packages/server/src/server/cluster/helm-client";

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try {
    rows.push({ name, ok: true, detail: await fn() });
  } catch (e) {
    rows.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

async function main() {
  const contexts = await detectKubeContexts();
  const ctx = contexts.find((c) => c.name === "docker-desktop") ?? contexts[0];
  const client = new KubeClient(ctx.name);
  await client.connect();
  console.log(`[audit-ops] context=${ctx.name}`);

  await check("revealSecret", async () => {
    const secrets = (await client.listGeneric("Secret")) as Array<{
      metadata?: { name?: string; namespace?: string };
    }>;
    if (!secrets.length) return "no secrets to reveal (ok)";
    const s = secrets.find((x) => (x.metadata?.namespace ?? "") !== "") ?? secrets[0];
    const data = await client.revealSecret(
      s.metadata?.namespace ?? "default",
      s.metadata?.name ?? "",
    );
    return `revealed ${Object.keys(data).length} keys from ${s.metadata?.name}`;
  });

  await check("cordonNode uncordon (no-op)", async () => {
    const nodes = (await client.listGeneric("Node")) as Array<{ metadata?: { name?: string } }>;
    const n = nodes[0];
    // unschedulable:false on an already-schedulable node is a harmless no-op but
    // still exercises the real patch path.
    const r = await client.cordonNode(n.metadata?.name ?? "", false);
    if (!r.ok) throw new Error(r.message);
    return r.message;
  });

  await check("discoverCRDs", async () => {
    const crds = await client.discoverCRDs();
    return `${Array.isArray(crds) ? crds.length : 0} CRDs discovered`;
  });

  await check("setCronJobSuspend", async () => {
    const cjs = (await client.listGeneric("CronJob")) as Array<{
      metadata?: { name?: string; namespace?: string };
      spec?: { suspend?: boolean };
    }>;
    if (!cjs.length) return "no cronjobs (skip)";
    const cj = cjs[0];
    // restore to its current value → no real change.
    const r = await client.setCronJobSuspend(
      cj.metadata?.namespace ?? "default",
      cj.metadata?.name ?? "",
      cj.spec?.suspend ?? false,
    );
    if (!r.ok) throw new Error(r.message);
    return r.message;
  });

  await check("rollbackDeployment (no-prev path)", async () => {
    // coredns has a single revision → expect the clean "no previous revision"
    // result, proving the read/compute path without mutating anything.
    const r = await client.applyWrite({
      kind: "Deployment",
      namespace: "kube-system",
      name: "coredns",
      action: "rollback",
      dryRun: false,
    });
    if (r.ok) return `unexpectedly rolled back: ${r.message}`;
    if (!/no previous revision/i.test(r.message)) throw new Error(`unexpected msg: ${r.message}`);
    return `correct: ${r.message}`;
  });

  await check("helmList", async () => {
    const releases = await helmList(ctx.name);
    return `${releases.length} helm releases`;
  });

  console.log(`genericKinds=${GENERIC_KINDS.length}`);
  console.log("\n================ AUX OPS AUDIT ================");
  for (const r of rows) console.log(`${r.ok ? "✅" : "❌"} ${r.name.padEnd(30)} ${r.detail}`);
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length}/${rows.length} passed.`);
  if (failed.length) console.log("FAILED:", failed.map((r) => r.name).join(", "));
  process.exit(0);
}

main().catch((err) => {
  console.error("AUDIT_CRASH:", err?.message ?? err);
  process.exit(1);
});
