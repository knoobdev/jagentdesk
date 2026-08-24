// probe-read.ts — ORCHESTRATOR artifact (khong phai code san pham).
// Quan sat hanh vi THAT: dung kube-client (do coder S1 viet) list context + pod read-only tu
// kubeconfig hien hanh cua user. In "PROBE_OK pods=<N>" khi thanh cong. Playbook §2: data that.
//
// Hop dong API ma coder S1 PHAI cung cap (khop manifest story-1):
//   kube-config-source.ts  -> export function detectKubeContexts(): Promise<KubeContextInfo[]>
//   kube-client.ts         -> export class KubeClient { constructor(contextName: string);
//                              connect(): Promise<void>; listPods(namespace?: string): Promise<PodDTO[]> }
import { detectKubeContexts } from "../../packages/server/src/server/cluster/kube-config-source";
import { KubeClient } from "../../packages/server/src/server/cluster/kube-client";

async function main() {
  const contexts = await detectKubeContexts();
  if (!Array.isArray(contexts) || contexts.length === 0) {
    console.error("PROBE_FAIL: khong phat hien context nao trong kubeconfig");
    process.exit(1);
  }
  console.error(`contexts=${contexts.length}: ${contexts.map((c) => c.name).join(", ")}`);
  const current = contexts.find((c) => (c as { current?: boolean }).current) ?? contexts[0];
  const client = new KubeClient(current.name);
  await client.connect();
  const pods = await client.listPods();
  if (!Array.isArray(pods)) {
    console.error("PROBE_FAIL: listPods khong tra ve mang");
    process.exit(1);
  }
  // read-only: chi in so luong, khong mutate
  console.log(`PROBE_OK pods=${pods.length} context=${current.name}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("PROBE_FAIL:", err?.message ?? err);
  process.exit(1);
});
