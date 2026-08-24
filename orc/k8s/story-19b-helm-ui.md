# MANIFEST — Story 19b: Helm UI (releases list + detail)

Ban la CODER @jagentdesk/app branch k8s/s1a-kube-client. Them muc Helm vao resource browser.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG useUnistyles. KHONG mock. KHONG sua file ngoai danh sach.

## CHI DUOC DOC
- `packages/app/src/components/cluster-resource-browser.tsx` (them muc "Helm" vao nav)
- `packages/app/src/components/adaptive-modal-sheet.tsx`
- `packages/app/src/components/cluster-resource-detail.tsx` (tham khao pattern detail/action)
- `packages/client/src/daemon-client.ts` (clusterHelmList/History/Values/Rollback/Uninstall)
- `packages/app/src/styles/theme.ts`

## API (da co):
- clusterHelmList({id}) -> {releases: unknown[], error}  release: {name,namespace,revision,updated,status,chart,appVersion}
- clusterHelmHistory({id,namespace,name}) -> {revisions: unknown[], error}
- clusterHelmValues({id,namespace,name}) -> {values: string|null, error}
- clusterHelmRollback({id,namespace,name,revision}) -> {result:{ok,message}|null, error}
- clusterHelmUninstall({id,namespace,name}) -> {result:{ok,message}|null, error}

## FILE TAO: `packages/app/src/components/cluster-helm-view.tsx`
`ClusterHelmView({serverId, clusterId})`:
- On mount clusterHelmList -> table: NAME | NAMESPACE | CHART | REV | STATUS | UPDATED.
- Chon 1 release -> mo detail (AdaptiveModalSheet): tab Values (clusterHelmValues, monospace) + tab History (clusterHelmHistory table rev/status/updated + nut Rollback moi rev -> clusterHelmRollback confirm). Nut Uninstall (confirm 2 buoc) -> clusterHelmUninstall.
- Neu error "helm CLI not installed" -> hien huong dan "Install helm on daemon host". StyleSheet + tokens, KHONG useUnistyles.

## FILE SUA: `packages/app/src/components/cluster-resource-browser.tsx`
- Them 1 muc nav "Helm" (category rieng, khong thuoc GENERIC_KINDS). Chon -> render <ClusterHelmView .../> thay bang resource table.

## LENH TU CHAY:
1. `npm run typecheck --workspace=@jagentdesk/app` -> 0
2. `npx oxlint packages/app/src/components/cluster-helm-view.tsx packages/app/src/components/cluster-resource-browser.tsx` -> 0 error (complexity <=20, tach sub-component neu can)
3. `npx oxfmt --check packages/app/src/components/cluster-helm-view.tsx` -> ok
Bao cao.
