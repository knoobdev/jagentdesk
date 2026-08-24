# MANIFEST — Story 3: generic resource browser (category nav + bang resource moi kind)

Ban la CODER trong @jagentdesk/app branch k8s/s1a-kube-client. Tao component duyet MOI kind
resource Lens-style, cam vao Clusters screen khi cluster da connect. Dung RPC generic da co.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo (chi file ban sua). KHONG useUnistyles (dung StyleSheet + variants). KHONG mock. KHONG sua file ngoai danh sach.

## CHI DUOC DOC
- `packages/app/src/screens/clusters-screen.tsx` (S2a — cam browser vao day)
- `packages/app/src/components/cluster-dot.tsx` (dot components)
- `packages/app/src/runtime/host-runtime.ts` (useHostRuntimeClient)
- `packages/app/src/components/agent-list.tsx` (pattern FlatList)
- `packages/client/src/daemon-client.ts` (method clusterKinds, clusterResourceList)
- `packages/app/src/styles/theme.ts` (token: surface0/1/2, foreground, foregroundMuted, border, palette, spacing, borderRadius, fontSize)

## API DaemonClient (da co):
- `client.clusterKinds({ id })` -> `{ kinds: Array<{kind,apiVersion,namespaced,category}>, error }`
- `client.clusterResourceList({ id, kind, namespace? })` -> `{ kind, items: unknown[], error }`
  items la object k8s raw: item.metadata.name, item.metadata.namespace, item.metadata.creationTimestamp.

## FILE TAO/SUA

### 1. `packages/app/src/components/cluster-resource-browser.tsx` (TAO)
Component `ClusterResourceBrowser({ serverId, clusterId })`:
- On mount: `client.clusterKinds({id: clusterId})` -> setKinds. Nhom kinds theo `category`
  (thu tu: Cluster, Workloads, Config, Network, Storage, Access, Custom).
- UI 2 phan (desktop: 2 cot; mobile useIsCompactFormFactor: nav tren duoi dang chip/scroll ngang):
  - LEFT nav rail: cac category header + kind row (ten kind). Chon kind -> setSelectedKind + goi
    clusterResourceList({id, kind}) -> setItems.
  - RIGHT table: header NAME | NAMESPACE | AGE; moi item 1 row: metadata.name, metadata.namespace ?? "-",
    tuoi tinh tu creationTimestamp (helper formatAge(ms) -> "3d"/"5h"/"12m"). Dung FlatList.
    Empty state hop le neu 0 item. Loading state khi dang goi RPC. Loi -> text do.
- Styling: StyleSheet.create((theme)=>...), tokens that. Dot mau: dung PodStatusDot cho kind Pod
  (doc item.status.phase), khong thi ClusterStatusDot bo qua. KHONG useUnistyles.
- formatAge: nhan creationTimestamp string, tinh chenh so voi thoi diem render (dung `Date.now()` o
  RUNTIME la duoc — KHONG nam trong test). Round: >=1d ->"Nd", >=1h->"Nh", else "Nm".

### 2. `packages/app/src/screens/clusters-screen.tsx` (SUA)
- Khi mot cluster co state === "connected" VA duoc chon (selectedClusterId), render
  `<ClusterResourceBrowser serverId={serverId} clusterId={selectedClusterId} />` THAY cho / DUOI phan
  pods hien tai (giu phan pods cu hoac thay bang browser — uu tien browser vi no tong quat hon).

## LENH TU CHAY (nghia "xong")
1. `npm run typecheck --workspace=@jagentdesk/app` -> 0 loi
2. `npx oxlint packages/app/src/components/cluster-resource-browser.tsx packages/app/src/screens/clusters-screen.tsx` -> 0 error (KHONG suppress, KHONG useUnistyles, complexity <=20 tach helper neu can)
3. `npx oxfmt --check packages/app/src/components/cluster-resource-browser.tsx` -> ok
Bao cao output + danh sach file.
