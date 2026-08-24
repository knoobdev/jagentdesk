# MANIFEST — Story 19a: Helm releases (daemon + RPC) qua helm CLI

Ban la CODER server+protocol+client branch k8s/s1a-kube-client. Them Helm bang cach shell `helm`
voi --kube-context cua cluster. Graceful neu helm chua cai.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG mock. KHONG sua file ngoai danh sach. KHONG hand-edit generated.

## CHI DUOC DOC
- `packages/server/src/server/cluster/kube-client.ts` (lay contextName: co field this-contextName; expose getter neu can)
- `packages/server/src/server/cluster/cluster-registry.ts` (registry.getClient -> contextName)
- `packages/protocol/src/cluster/rpc-schemas.ts` / `messages.ts`
- `packages/server/src/server/session/cluster/cluster-session.ts` + `session.ts` (dispatch)
- `packages/client/src/daemon-client.ts`
- `packages/server/src/server/enrich-path.ts` HOAC executable-resolution (tim helm binary PATH)

## A. TAO `packages/server/src/server/cluster/helm-client.ts`
- Ham chay helm: `async function runHelm(contextName: string, args: string[]): Promise<{ok:boolean, stdout:string, stderr:string}>`
  dung `node:child_process` execFile("helm", [...args, "--kube-context", contextName], {env: enriched PATH}). Bat ENOENT -> {ok:false, stderr:"helm CLI not installed on daemon host"}.
- `async helmList(contextName): Promise<HelmReleaseDTO[]>` -> `helm list -A -o json` parse. DTO {name,namespace,revision,updated,status,chart,appVersion}.
- `async helmHistory(contextName, namespace, name): Promise<HelmRevisionDTO[]>` -> `helm history <name> -n <ns> -o json`.
- `async helmValues(contextName, namespace, name): Promise<string>` -> `helm get values <name> -n <ns>` (text yaml).
- `async helmRollback(contextName, namespace, name, revision): Promise<{ok,message}>` -> `helm rollback <name> <rev> -n <ns>`.
- `async helmUninstall(contextName, namespace, name): Promise<{ok,message}>` -> `helm uninstall <name> -n <ns>`.
Export cac DTO type. KHONG log credential. Moc thoi gian: helm tra updated string, giu nguyen string (khong ep _ms de gon).

## B. RPC (rpc-schemas.ts): domain con helm
- `cluster/helm/list` (req{requestId,id}) -> {requestId, releases: z.array(z.unknown()), error}
- `cluster/helm/history` (req{requestId,id,namespace,name}) -> {requestId, revisions: z.array(z.unknown()), error}
- `cluster/helm/values` (req{requestId,id,namespace,name}) -> {requestId, values: string|null, error}
- `cluster/helm/rollback` (req{requestId,id,namespace,name,revision:number}) -> {requestId, result:{ok,message}|null, error}
- `cluster/helm/uninstall` (req{requestId,id,namespace,name}) -> {requestId, result:{ok,message}|null, error}
Dang ky union. Regen validators.

## C. cluster-session.ts: 5 handler (dung registry.getClient(id) de lay contextName -> goi helm-client). THEM 5 case vao dispatchClusterMessage trong session.ts (KIEM lai co case).
   (Neu KubeClient chua expose contextName, them getter `get contextName()` vao kube-client.ts.)

## D. daemon-client.ts: clusterHelmList/History/Values/Rollback/Uninstall.

## E. Test `packages/server/src/server/cluster/helm-client.test.ts`: mock execFile, test helmList parse JSON -> DTO; test ENOENT -> {ok:false, "not installed"}. KHONG Date.now.

## LENH TU CHAY:
1. `npm run generate:validators --workspace=@jagentdesk/protocol` -> ok
2. `npm run typecheck --workspace=@jagentdesk/protocol && cd packages/server && npx tsgo -p tsconfig.server.typecheck.json --noEmit && cd .. && npm run typecheck --workspace=@jagentdesk/client` -> 0
3. `npx oxlint packages/server/src/server/cluster/helm-client.ts packages/server/src/server/cluster/helm-client.test.ts packages/protocol/src/cluster packages/server/src/server/session/cluster/cluster-session.ts packages/server/src/server/session.ts packages/client/src/daemon-client.ts` -> 0 error
4. `cd packages/server && npx vitest run src/server/cluster/helm-client.test.ts` -> xanh; `grep -cE 'case "cluster/helm/' src/server/session.ts` -> 5
Bao cao output.
