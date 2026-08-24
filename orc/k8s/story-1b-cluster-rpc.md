# MANIFEST — Story 1b: cluster RPC domain (protocol + websocket + client)

Ban la CODER. Lam DUNG manifest. Story 1a (module `packages/server/src/server/cluster/`) DA XONG —
ban DUNG LAI no, khong sua. Theo dung pattern domain `loop` (subdir slash-namespaced).

## CAM TUYET DOI
- KHONG WebFetch, KHONG tim du an khac. Chi doc file trong danh sach duoi.
- KHONG mock data. KHONG sua file `cluster/*.ts` cua story 1a (chi IMPORT).
- KHONG hand-edit file generated `packages/protocol/src/generated/validation/ws-outbound.aot.ts` —
  no do codegen sinh; chay lenh regen.
- DTO/payload len wire KHONG chua token/credential (module 1a da bao dam; giu nguyen).

## CHI DUOC DOC (hoc pattern — copy y het cach lam cua `loop`)
- `packages/protocol/src/loop/rpc-schemas.ts`  (pattern schema domain moi)
- `packages/protocol/src/messages.ts` lines 55-66 (import loop), 2594+ (SessionInbound union, cho loop 2760-2764), 5448+ (SessionOutbound union, cho loop 5627-5631)
- `packages/server/src/server/session.ts` lines 833 (construct sub-session), 1842-1860 (chuoi dispatch `??`), 2304 (dispatchChatScheduleLoopMessage switch)
- `packages/server/src/server/session/chat/chat-schedule-loop-session.ts` (pattern sub-session + host.emit)
- `packages/client/src/daemon-client.ts` lines 553 (payload alias), 5419 (loopList method), 1802/955 (sendCorrelatedSessionRequest)
- `packages/server/src/server/cluster/cluster-dto.ts` + `cluster-registry.ts` + `kube-client.ts` (API story 1a — de goi)
- Cach ClusterRegistry duoc cap cho daemon: doc `packages/server/src/server/session.ts` constructor + noi loopService duoc truyen vao (grep "loopService"), lam Y HET cho ClusterRegistry.

## FILE TAO/SUA

### A. Protocol — `packages/protocol/src/cluster/rpc-schemas.ts` (TAO)
Zod schema cho tung RPC, `type` la literal slash-namespaced. Moi request co `requestId`, moi response
co `payload.requestId` (de client tu correlate — KHONG can sua CorrelatedResponseMessage). Cac RPC:
- `cluster/contexts` -> `cluster/contexts/response` payload `{ requestId, contexts: KubeContextInfo[], error: string|null }`
- `cluster/import` (req `{ requestId, contextName?, kubeconfigYaml?, displayName? }`) -> `.../response` `{ requestId, clusters: ClusterInfo[], error }`
- `cluster/list` -> `.../response` `{ requestId, clusters: ClusterInfo[], error }`
- `cluster/connect` (req `{ requestId, id }`) -> `.../response` `{ requestId, cluster: ClusterInfo|null, error }`
- `cluster/disconnect` (req `{ requestId, id }`) -> `.../response` `{ requestId, ok: boolean, error }`
- `cluster/resources` (req `{ requestId, id, kind: "pods"|"deployments"|"nodes"|"events", namespace? }`) -> `.../response` `{ requestId, kind, items: unknown[], error }`  (items = DTO[] tuong ung tu kube-client)
- `cluster/get` (req `{ requestId, id, kind, namespace?, name }`) -> `.../response` `{ requestId, yaml: string|null, error }`
- `cluster/logs` (req `{ requestId, id, namespace, pod, container? }`) -> `.../response` `{ requestId, logs: string|null, error }`  (mot-shot, KHONG stream o story nay)
- `cluster/write` (req `{ requestId, id, kind, namespace?, name, action: "scale"|"delete"|"restart"|"apply", replicas?, manifestYaml?, dryRun: boolean }`) -> `.../response` `{ requestId, result: WriteResult|null, error }`
Dinh nghia Zod cho KubeContextInfo/ClusterInfo/WriteResult TRONG file nay (mirror cluster-dto.ts, dung
z.object). DTO resource (Pod/Deployment/Node/Event) truyen qua `z.array(z.unknown())` cho items de gon
(server dam bao dung DTO tu 1a). Export ca z.infer types.

### B. `packages/protocol/src/messages.ts` (SUA)
- Them import block sau dong ~66: `import { ClusterContextsRequestSchema, ClusterContextsResponseSchema, ... } from "./cluster/rpc-schemas.js";` (đủ moi schema).
- Them TAT CA request schema vao mang `SessionInboundMessageSchema` (sau cho loop ~2764).
- Them TAT CA response schema vao mang `SessionOutboundMessageSchema` (sau cho loop ~5631).

### C. Regen validators (BAT BUOC — response vao WSOutboundMessageSchema)
`npm run generate:validators --workspace=@jagentdesk/protocol`
(file generated tu cap nhat; KHONG sua tay.)

### D. Server sub-session — `packages/server/src/server/session/cluster/cluster-session.ts` (TAO)
- `class ClusterSession` giong `ChatScheduleLoopSession`: constructor nhan `{ host: { emit(msg) }, clusterRegistry: ClusterRegistry, logger }`.
- 1 handler moi RPC: goi ClusterRegistry/KubeClient (story 1a) roi `this.host.emit({ type: ".../response", payload: {...} })`. Bat loi -> tra `error: String(err)`, khong throw ra ngoai.
  - contexts -> `detectKubeContexts()`
  - import -> `registry.importContext()` hoac `importKubeconfigString()`
  - list -> `registry.list()`
  - connect/disconnect -> `registry.connect(id)/disconnect(id)`
  - resources -> `registry.getClient(id)` roi `listPods/listDeployments/listNodes/listEvents`
  - get -> `client.getResourceYaml(kind, ns, name)`
  - logs -> `client.getPodLogs(ns, pod, container)`
  - write -> `client.applyWrite({...})`

### E. `packages/server/src/server/session.ts` (SUA)
- Tao MOT `ClusterRegistry` singleton o tang daemon (grep noi `loopService` duoc tao va truyen vao Session — lam y het: tao registry o do, truyen vao Session options, roi Session tao `ClusterSession`). Neu registry hop ly de o session-scope thi tao trong constructor Session gan dong 833.
- Them method `dispatchClusterMessage(msg)`: `switch(msg.type)` cac case `"cluster/contexts"` ... goi `this.clusterSession.handle...(msg)`. Default `return undefined`.
- Them `this.dispatchClusterMessage(msg) ??` vao chuoi o `dispatchInboundMessage` (~1858).

### F. Client — `packages/client/src/daemon-client.ts` (SUA)
- Them payload alias (gan 553): `type ClusterContextsPayload = Extract<SessionOutboundMessage, { type: "cluster/contexts/response" }>["payload"];` (va cho cac response khac).
- Them method moi RPC theo pattern `loopList` (5419), dung `sendCorrelatedSessionRequest({ requestId, message: { type: "cluster/xxx", ...args }, responseType: "cluster/xxx/response" })`.

### G. Test — `packages/protocol/src/cluster/rpc-schemas.test.ts` (TAO)
Mirror `packages/protocol/src/loop/rpc-schemas.test.ts`: parse moi request/response schema voi 1 mau hop le,
assert `type` literal + shape. KHONG Date.now().

## LENH BAN PHAI TU CHAY (nghia "xong")
1. `npm run generate:validators --workspace=@jagentdesk/protocol` -> thanh cong.
2. `npm run typecheck --workspace=@jagentdesk/protocol && npm run typecheck --workspace=@jagentdesk/server && npm run typecheck --workspace=@jagentdesk/client` -> 0 loi.
3. `npx vitest run packages/protocol/src/cluster/rpc-schemas.test.ts` -> xanh.
4. Grep chung minh dang ky: `grep -rE "cluster/(contexts|list|connect|resources|logs|write)" packages/protocol/src packages/server/src packages/client/src` -> thay ca 3 tang.
Bao cao: dan output 4 lenh.
