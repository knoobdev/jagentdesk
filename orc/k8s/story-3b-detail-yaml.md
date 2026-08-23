# MANIFEST — Story 3b: resource detail + YAML view/edit/apply + delete/scale/restart

Ban la CODER @jagentdesk/app branch k8s/s1a-kube-client. Them detail view cho resource browser:
chon 1 resource -> xem YAML -> sua + apply -> delete/scale/restart. Dung RPC da co.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG useUnistyles (StyleSheet + variants). KHONG mock. KHONG sua file ngoai danh sach.

## CHI DUOC DOC
- `packages/app/src/components/cluster-resource-browser.tsx` (S3 — them detail vao / hoac component rieng)
- `packages/app/src/components/adaptive-modal-sheet.tsx` (AdaptiveModalSheet + AdaptiveTextInput cho editor)
- `packages/app/src/components/cluster-dot.tsx`
- `packages/client/src/daemon-client.ts` (clusterGet, clusterWrite)
- `packages/app/src/styles/theme.ts`

## API DaemonClient (da co):
- `client.clusterGet({ id, kind, namespace?, name })` -> `{ yaml: string|null, error }`
- `client.clusterWrite({ id, kind, namespace?, name, action: "scale"|"delete"|"restart"|"apply", replicas?, manifestYaml?, dryRun })` -> `{ result: {ok,dryRun,message}|null, error }`

## FILE TAO/SUA

### 1. `packages/app/src/components/cluster-resource-detail.tsx` (TAO)
`ClusterResourceDetail({ serverId, clusterId, kind, namespace, name, onClose })`:
- On mount: `clusterGet({id:clusterId,kind,namespace,name})` -> setYaml.
- UI (AdaptiveModalSheet: desktop drawer/modal, mobile bottom sheet):
  - Header: kind/name + namespace.
  - Action bar: nut Delete (destructive), Restart (neu kind Deployment/DaemonSet/StatefulSet), Scale (neu workload co replicas — o nhap so + Apply), Edit YAML (toggle).
  - Body: YAML text (monospace). Khi Edit bat -> AdaptiveTextInput multiline chinh sua duoc; nut Apply goi clusterWrite({action:"apply", manifestYaml: edited, dryRun:false}); truoc do co the goi dryRun:true de xac nhan.
  - Delete: hien confirm (2 buoc: nhan Delete -> "Confirm delete?" -> clusterWrite action delete). KHONG xoa ngay 1 nhan.
  - Moi ket qua clusterWrite: hien message (result.message hoac error). Sau apply/delete thanh cong -> onClose + trigger refresh list (callback onChanged).
- Styling StyleSheet + tokens; nut destructive dung theme.colors.destructive neu co, khong thi palette.red[500].

### 2. `packages/app/src/components/cluster-resource-browser.tsx` (SUA)
- Moi row resource -> Pressable onPress set selected {kind,namespace,name} -> render <ClusterResourceDetail .../> voi onChanged = reload list hien tai.

## LENH TU CHAY (nghia "xong")
1. `npm run typecheck --workspace=@jagentdesk/app` -> 0 loi
2. `npx oxlint packages/app/src/components/cluster-resource-detail.tsx packages/app/src/components/cluster-resource-browser.tsx` -> 0 error (KHONG useUnistyles, complexity <=20)
3. `npx oxfmt --check packages/app/src/components/cluster-resource-detail.tsx` -> ok
Bao cao output + file list.
