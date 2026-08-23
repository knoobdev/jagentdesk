import { KubeConfig } from "@kubernetes/client-node";
import type { KubeContextInfo } from "./cluster-dto.js";

export async function detectKubeContexts(): Promise<KubeContextInfo[]> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return mapContexts(kc);
}

export function contextsFromKubeconfigString(yaml: string): KubeContextInfo[] {
  const kc = new KubeConfig();
  kc.loadFromString(yaml);
  return mapContexts(kc);
}

function mapContexts(kc: KubeConfig): KubeContextInfo[] {
  const currentContext = kc.getCurrentContext();
  return kc.getContexts().map((ctx) => {
    const cluster = kc.getCluster(ctx.cluster);
    return {
      name: ctx.name,
      cluster: ctx.cluster,
      server: cluster?.server ?? "",
      user: ctx.user,
      namespace: ctx.namespace,
      current: ctx.name === currentContext,
    };
  });
}
