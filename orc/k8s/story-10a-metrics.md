# MANIFEST — Story 10a: metrics client + RPC (node/pod CPU+mem)

Ban la CODER server+protocol+client branch k8s/s1a-kube-client. Them metrics qua metrics.k8s.io API.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG mock. KHONG sua file ngoai danh sach. KHONG hand-edit generated.

## CHI DUOC DOC
- `packages/server/src/server/cluster/kube-client.ts` (them method; da co this.kc)
- `node_modules/@kubernetes/client-node/dist/index.d.ts` (tim Metrics hoac cach goi apis/metrics.k8s.io/v1beta1)
- `packages/protocol/src/cluster/rpc-schemas.ts` / `messages.ts`
- `packages/server/src/server/session/cluster/cluster-session.ts` + `packages/server/src/server/session.ts` (dispatch)
- `packages/client/src/daemon-client.ts`

## A. kube-client.ts — them method
- `async getNodeMetrics(): Promise<Array<{name:string, cpuNano:number, memoryBytes:number}>>`
  - Goi metrics.k8s.io/v1beta1/nodes. Neu client-node co class `Metrics`, dung `new Metrics(this.kc).getNodeMetrics()`.
    Neu khong, dung objectApi/CustomObjectsApi goi group "metrics.k8s.io" v1beta1 resource "nodes".
  - Parse `usage.cpu` (vd "123456n" nano, hoac "12m" milli) -> cpuNano; `usage.memory` (vd "256Mi","1Gi") -> bytes.
  - Neu metrics-server KHONG co (loi 404/ServiceUnavailable) -> throw Error ro "metrics-server not available".
- `async getPodMetrics(namespace?: string): Promise<Array<{name:string,namespace:string,cpuNano:number,memoryBytes:number}>>` tuong tu voi resource "pods".
- Them helper parse: parseCpuToNano(s), parseMemToBytes(s) (Ki/Mi/Gi/Ti + so thuan). KHONG Date.now trong path test.

## B. RPC: `cluster/metrics` (req {requestId,id,scope:"nodes"|"pods",namespace?}) -> resp {requestId, scope, items: z.array(z.unknown()), error}. Dang ky union. Regen validators.

## C. cluster-session.ts handler handleClusterMetrics: scope nodes -> getNodeMetrics; pods -> getPodMetrics. + THEM case "cluster/metrics" vao dispatchClusterMessage TRONG session.ts (BAT BUOC - kiem lai co case do).

## D. daemon-client.ts: `clusterMetrics({id,scope,namespace?})`.

## LENH TU CHAY:
1. `npm run generate:validators --workspace=@jagentdesk/protocol` -> ok
2. `npm run typecheck --workspace=@jagentdesk/protocol && cd packages/server && npx tsgo -p tsconfig.server.typecheck.json --noEmit && cd .. && npm run typecheck --workspace=@jagentdesk/client` -> 0
3. `npx oxlint packages/protocol/src/cluster packages/server/src/server/cluster/kube-client.ts packages/server/src/server/session/cluster/cluster-session.ts packages/server/src/server/session.ts packages/client/src/daemon-client.ts` -> 0 error
4. `grep -nE 'case "cluster/metrics"' packages/server/src/server/session.ts` -> PHAI thay (dispatch wired)
Bao cao output 4 lenh.
