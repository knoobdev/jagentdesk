# MANIFEST — Story 1d-logs: live log streaming (subscribe/push) — daemon+protocol+client

Ban la CODER server+protocol+client branch k8s/s1a-kube-client. Them streaming log pod theo pattern
`fs.file.update` (subscribe -> push chunk -> unsubscribe). Dung @kubernetes/client-node `Log`.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG mock. KHONG sua file ngoai danh sach. KHONG hand-edit generated.

## CHI DUOC DOC
- `packages/protocol/src/messages.ts` — pattern `FileSubscribeRequestSchema`(~2322), `FileUpdateSchema`(~4987, push khong requestId), `FileUnsubscribeRequestSchema`. Copy pattern.
- `packages/protocol/src/cluster/rpc-schemas.ts`
- `packages/server/src/server/session/files/workspace-files-session.ts` (pattern handleFileSubscribeRequest: mo observer, luu unsubscribe vao Map theo subscriptionId, host.emit push, teardown)
- `packages/server/src/server/session/cluster/cluster-session.ts` + `session.ts`
- `packages/server/src/server/cluster/kube-client.ts` (them stream method; da co this.kc)
- `node_modules/@kubernetes/client-node/dist/index.d.ts` (class `Log`: `log(namespace,pod,container,stream,options)` tra AbortController/request)
- `packages/client/src/daemon-client.ts` (pattern resubscribe fs; sendCorrelatedSessionRequest + push listener theo subscriptionId)

## A. kube-client.ts — them
- `streamPodLogs(namespace, pod, container: string|undefined, onChunk: (text:string)=>void): Promise<() => void>`
  - dung `new Log(this.kc)` + PassThrough stream; `log(namespace, pod, container ?? "", stream, { follow:true, tailLines:100, pretty:false })`.
  - stream.on("data", d => onChunk(d.toString())). Tra ham stop() (abort request + destroy stream).

## B. rpc-schemas.ts — 3 message (theo pattern fs)
- `cluster/logs/subscribe` (req {requestId,id,subscriptionId,namespace,pod,container?}) -> `cluster/logs/subscribe/response` {requestId, subscriptionId, error}
- `cluster/logs/chunk` (PUSH, KHONG requestId) {subscriptionId, chunk: string}
- `cluster/logs/unsubscribe` (req {requestId,subscriptionId}) -> `.../response` {requestId, ok}
Dang ky: subscribe+unsubscribe request vao SessionInbound; subscribe/response + chunk + unsubscribe/response vao SessionOutbound. Regen validators.

## C. cluster-session.ts
- Field `private logSubscriptions = new Map<string, () => void>();`
- handleLogsSubscribe: client = registry.getClient(id); stop = await client.streamPodLogs(ns,pod,container, chunk => this.host.emit({type:"cluster/logs/chunk", payload:{subscriptionId, chunk}})); luu stop vao map theo subscriptionId; emit subscribe/response. (Push chunk KHONG co payload.requestId — dat truc tiep {subscriptionId,chunk} lam payload hoac top-level theo dung pattern FileUpdateSchema.)
- handleLogsUnsubscribe: goi stop() tu map, xoa, emit response.
- Teardown session: goi het stop() trong map (them vao noi dispose/close cua session neu co, hoac best-effort).
- THEM 2 case (subscribe/unsubscribe) vao dispatchClusterMessage trong session.ts (KIEM co case).

## D. daemon-client.ts
- `clusterLogsSubscribe({id,namespace,pod,container?}, onChunk: (chunk:string)=>void): Promise<{subscriptionId, unsubscribe: ()=>Promise<void>}>` — sinh subscriptionId (crypto), dang ky push listener cho "cluster/logs/chunk" loc theo subscriptionId -> onChunk; gui subscribe; tra unsubscribe().

## LENH TU CHAY:
1. `npm run generate:validators --workspace=@jagentdesk/protocol` -> ok
2. `npm run typecheck --workspace=@jagentdesk/protocol && cd packages/server && npx tsgo -p tsconfig.server.typecheck.json --noEmit && cd .. && npm run typecheck --workspace=@jagentdesk/client` -> 0
3. `npx oxlint packages/server/src/server/cluster/kube-client.ts packages/protocol/src/cluster packages/server/src/server/session/cluster/cluster-session.ts packages/server/src/server/session.ts packages/client/src/daemon-client.ts` -> 0 error
4. `grep -cE 'case "cluster/logs/(subscribe|unsubscribe)"' packages/server/src/server/session.ts` -> 2
Bao cao output.
