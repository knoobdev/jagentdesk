# MANIFEST — Story conv: reveal-secret + node cordon/uncordon + cronjob trigger/suspend (daemon+RPC)

Ban la CODER @jagentdesk/server + protocol + client, branch k8s/s1a-kube-client. Them ops tien ich.
revealSecret DA CO trong kube-client (S1c). Them cordon/uncordon/trigger/suspend + expose het qua RPC.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG mock. KHONG sua file ngoai danh sach. KHONG hand-edit file generated.

## CHI DUOC DOC
- `packages/server/src/server/cluster/kube-client.ts` (them method; da co objectApi, applyGeneric, revealSecret)
- `packages/protocol/src/cluster/rpc-schemas.ts` (them RPC, xem pattern cu)
- `packages/protocol/src/messages.ts` (dang ky union)
- `packages/server/src/server/session/cluster/cluster-session.ts` (them handler)
- `packages/client/src/daemon-client.ts` (them method)

## A. kube-client.ts — them 4 method (dung objectApi.patch giong applyGeneric)
- `async cordonNode(name: string, unschedulable: boolean): Promise<WriteResult>` — patch Node `{spec:{unschedulable}}` (objectApi.patch, fieldManager "jagentdesk").
- `async triggerCronJob(namespace: string, name: string): Promise<WriteResult>` — doc CronJob (getGeneric/objectApi.read), tao Job moi tu `spec.jobTemplate` voi metadata.name = `${name}-manual-<random hex 5>`, ownerReference toi cronjob; create qua objectApi.create.
- `async setCronJobSuspend(namespace: string, name: string, suspend: boolean): Promise<WriteResult>` — patch CronJob `{spec:{suspend}}`.
- (revealSecret da co — giu nguyen.)

## B. rpc-schemas.ts — them RPC (moi request co requestId, response payload.requestId)
- `cluster/reveal-secret` (req {requestId,id,namespace,name}) -> resp {requestId, data: Record<string,string>|null, error}
- `cluster/node-op` (req {requestId,id,name,op:"cordon"|"uncordon"}) -> resp {requestId, result: WriteResult|null, error}
- `cluster/cronjob-op` (req {requestId,id,namespace,name,op:"trigger"|"suspend"|"resume"}) -> resp {requestId, result: WriteResult|null, error}
Them request vao SessionInbound, response vao SessionOutbound (messages.ts). Regen validators.

## C. cluster-session.ts — 3 handler
- reveal-secret -> client.revealSecret(ns,name) -> data. (Ghi chu: day la thao tac co chu y; van tra qua wire da ma hoa Tailscale.)
- node-op -> client.cordonNode(name, op==="cordon")
- cronjob-op -> trigger->triggerCronJob; suspend->setCronJobSuspend(true); resume->setCronJobSuspend(false)
Them 3 case vao dispatchClusterMessage.

## D. daemon-client.ts — 3 method: clusterRevealSecret({id,namespace,name}), clusterNodeOp({id,name,op}), clusterCronjobOp({id,namespace,name,op}).

## LENH TU CHAY:
1. `npm run generate:validators --workspace=@jagentdesk/protocol` -> ok
2. `npm run typecheck --workspace=@jagentdesk/protocol && cd packages/server && npx tsgo -p tsconfig.server.typecheck.json --noEmit && cd .. && npm run typecheck --workspace=@jagentdesk/client` -> 0
3. `npx oxlint packages/protocol/src/cluster packages/server/src/server/cluster/kube-client.ts packages/server/src/server/session/cluster/cluster-session.ts packages/client/src/daemon-client.ts` -> 0 error (complexity <=20 tach helper)
4. `grep -rE "cluster/(reveal-secret|node-op|cronjob-op)" packages/protocol/src packages/server/src packages/client/src` -> 3 tang
Bao cao output 4 lenh.
