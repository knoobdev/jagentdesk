# MANIFEST — Story 10b: metrics UI (CPU/mem node+pod)

Ban la CODER @jagentdesk/app branch k8s/s1a-kube-client. Hien metrics tu clusterMetrics.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG useUnistyles. KHONG mock. KHONG sua file ngoai danh sach.

## CHI DUOC DOC
- `packages/app/src/components/cluster-resource-browser.tsx`
- `packages/client/src/daemon-client.ts` (clusterMetrics)
- `packages/app/src/styles/theme.ts`

## API: `client.clusterMetrics({id,scope:"nodes"|"pods",namespace?})` -> `{ scope, items: unknown[], error }`
items nodes: {name,cpuNano,memoryBytes}; pods: {name,namespace,cpuNano,memoryBytes}.

## FILE SUA: `packages/app/src/components/cluster-resource-browser.tsx`
- KHI selectedKind === "Node": sau khi list, goi clusterMetrics({id,scope:"nodes"}) va hien them cot CPU (mCPU = cpuNano/1e6 lam tron) + Mem (MiB = memoryBytes/1048576) canh moi node row (match theo name).
- KHI selectedKind === "Pod": tuong tu scope "pods" (match name+namespace).
- Neu clusterMetrics error (metrics-server not available) -> hien nhan nho "metrics unavailable", KHONG lam hong list.
- Helper formatCpu(nano)->"123m", formatMem(bytes)->"256Mi". StyleSheet + tokens, KHONG useUnistyles.

## LENH TU CHAY:
1. `npm run typecheck --workspace=@jagentdesk/app` -> 0
2. `npx oxlint packages/app/src/components/cluster-resource-browser.tsx` -> 0 error (complexity <=20)
3. `npx oxfmt --check packages/app/src/components/cluster-resource-browser.tsx` -> ok
Bao cao.
