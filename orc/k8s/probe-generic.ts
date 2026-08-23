// probe-generic.ts — ORCHESTRATOR artifact. Quan sat hanh vi THAT cua generic engine (S1c):
// list nhieu KIND khac nhau read-only tu cluster hien hanh + apply dry-run KHONG mutate.
// Hop dong API coder S1c PHAI cung cap trong kube-client.ts:
//   listGeneric(kind: string, namespace?: string): Promise<Array<Record<string, unknown>>>
//   applyGeneric(manifestYaml: string, dryRun: boolean): Promise<{ ok: boolean; dryRun: boolean; message: string }>
//   GENERIC_KINDS: ReadonlyArray<{ kind: string; apiVersion: string; namespaced: boolean; category: string }>
import { detectKubeContexts } from "../../packages/server/src/server/cluster/kube-config-source";
import { KubeClient } from "../../packages/server/src/server/cluster/kube-client";
import { GENERIC_KINDS } from "../../packages/server/src/server/cluster/kube-client";

async function main() {
  const contexts = await detectKubeContexts();
  const current = contexts.find((c) => (c as { current?: boolean }).current) ?? contexts[0];
  const client = new KubeClient(current.name);
  await client.connect();

  if (!Array.isArray(GENERIC_KINDS) || GENERIC_KINDS.length < 25) {
    console.error(`PROBE_FAIL: GENERIC_KINDS qua it (${GENERIC_KINDS?.length}); Lens parity can >=25 kind`);
    process.exit(1);
  }

  // list 3 KIND khac nhau read-only
  const kinds = ["Namespace", "Service", "ConfigMap"];
  const counts: Record<string, number> = {};
  for (const k of kinds) {
    const items = await client.listGeneric(k);
    if (!Array.isArray(items)) {
      console.error(`PROBE_FAIL: listGeneric(${k}) khong tra mang`);
      process.exit(1);
    }
    counts[k] = items.length;
  }

  // apply DRY-RUN mot ConfigMap tam — KHONG duoc mutate that (dryRun=true)
  const yaml = `apiVersion: v1
kind: ConfigMap
metadata:
  name: jagentdesk-probe-dryrun
  namespace: default
data:
  probe: "1"
`;
  const res = await client.applyGeneric(yaml, true);
  if (!res.ok || !res.dryRun) {
    console.error(`PROBE_FAIL: applyGeneric dry-run khong ok: ${JSON.stringify(res)}`);
    process.exit(1);
  }

  console.log(
    `PROBE_OK kinds=${GENERIC_KINDS.length} Namespace=${counts.Namespace} Service=${counts.Service} ConfigMap=${counts.ConfigMap} applyDryRun=ok context=${current.name}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("PROBE_FAIL:", err?.message ?? err);
  process.exit(1);
});
