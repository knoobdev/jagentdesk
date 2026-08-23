# MANIFEST — Story 1b-ext: RPC generic cho MOI kind + cluster/kinds

Ban la CODER. Mo rong RPC cluster de duyet MOI kind (khong chi 4). Dung generic engine S1c
(GENERIC_KINDS, listGeneric, discoverCRDs, getGeneric, deleteGeneric) da co trong kube-client.ts.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo (chi format file ban sua). KHONG mock. KHONG sua file ngoai danh sach.

## CHI DUOC DOC
- `packages/protocol/src/cluster/rpc-schemas.ts` (them RPC moi, giu cai cu)
- `packages/protocol/src/messages.ts` (dang ky union - xem cach cluster/* da them)
- `packages/server/src/server/session/cluster/cluster-session.ts` (them handler)
- `packages/server/src/server/cluster/kube-client.ts` (API: GENERIC_KINDS, listGeneric, getGeneric, deleteGeneric, discoverCRDs)
- `packages/client/src/daemon-client.ts` (them method, xem cluster* co san)

## THAY DOI

### A. `rpc-schemas.ts` — THEM 2 RPC (giu cluster/resources cu de tuong thich)
- `cluster/kinds` (req `{requestId, id}`) -> `cluster/kinds/response` `{requestId, kinds: Array<{kind,apiVersion,namespaced,category}>, error}` — server tra GENERIC_KINDS + discoverCRDs(id) gop lai.
- `cluster/resource/list` (req `{requestId, id, kind: string, namespace?}`) -> `.../response` `{requestId, kind, items: z.array(z.unknown()), error}` — dung listGeneric cho BAT KY kind.
Export z.infer types. Them ca 2 request vao SessionInbound, 2 response vao SessionOutbound trong messages.ts.

### B. Regen: `npm run generate:validators --workspace=@jagentdesk/protocol`

### C. `cluster-session.ts` — THEM handler
- handleClusterKinds: `const client = registry.getClient(id)`; `const crds = client ? await client.discoverCRDs() : []`; emit `{ kinds: [...GENERIC_KINDS, ...crds], error:null }`. Neu chua connect, chi tra GENERIC_KINDS.
- handleClusterResourceList: `client.listGeneric(kind, namespace)` -> emit items. Loi -> error string.
Them 2 case vao dispatchClusterMessage.

### D. `daemon-client.ts` — THEM 2 method: `clusterKinds({id})`, `clusterResourceList({id, kind, namespace?})` theo pattern clusterResources co san.

## LENH TU CHAY (nghia "xong")
1. `npm run generate:validators --workspace=@jagentdesk/protocol` -> ok
2. `npm run typecheck --workspace=@jagentdesk/protocol && cd packages/server && npx tsgo -p tsconfig.server.typecheck.json --noEmit && cd .. && npm run typecheck --workspace=@jagentdesk/client` -> 0 loi
3. `npx oxlint packages/protocol/src/cluster packages/server/src/server/session/cluster/cluster-session.ts packages/client/src/daemon-client.ts` -> 0 error
4. `grep -rE "cluster/(kinds|resource/list)" packages/protocol/src packages/server/src packages/client/src` -> thay 3 tang
Bao cao output 4 lenh.
