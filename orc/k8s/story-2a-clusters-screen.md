# MANIFEST — Story 2a: Clusters screen (end-to-end UI, nhin thay + test live)

Ban la CODER trong @jagentdesk/app (React Native/Expo, react-native-unistyles v3, lucide-react-native,
expo-router). Tao 1 man hinh Clusters goi 4 RPC cluster THAT (da co san tren DaemonClient). Muc tieu:
mo app -> vao Clusters -> Import context -> Connect -> thay POD THAT tu cluster.

## CAM TUYET DOI
- KHONG WebFetch. Chi doc file trong danh sach.
- KHONG mock data / ten bia. Du lieu tu DaemonClient that; chua co thi render empty/loading hop le.
- KHONG dung `theme.colors.accent` (co the khong ton tai) — dung `theme.colors.palette.green[400]` cho nhan manh.
- Styling BAT BUOC dung react-native-unistyles: `StyleSheet.create((theme)=>({...}))` + `useUnistyles()`.
  Icon lucide doi mau qua `withUnistyles(Icon)` + uniProps mapping. KHONG hardcode hex.

## CHI DUOC DOC (seam)
- `packages/app/src/panels/setup-panel.tsx` (pattern: useHostRuntimeClient, goi RPC, styles, container)
- `packages/app/src/components/host-status-dot.tsx` (pattern dot mau theo state + withUnistyles)
- `packages/app/src/runtime/host-runtime.ts` (useHostRuntimeClient line ~2538, getHostRuntimeStore)
- `packages/app/src/components/agent-list.tsx` (pattern FlatList + renderItem + keyExtractor)
- `packages/app/src/components/adaptive-modal-sheet.tsx` (AdaptiveModalSheet + AdaptiveTextInput)
- `packages/app/src/components/left-sidebar.tsx` + `packages/app/src/utils/host-routes.ts` (them route + entry)
- `packages/protocol/src/cluster/rpc-schemas.ts` (kieu ClusterInfo, KubeContextInfo, payload)
- `packages/app/src/hooks/use-hosts.ts` HOAC noi lay serverId host dang ket noi (grep useHosts)

## API DaemonClient da co (goi truc tiep, dung dung ten):
- `client.clusterContexts()` -> `{ contexts: KubeContextInfo[], error }`  (KubeContextInfo: {name,cluster,server,user,namespace?,current})
- `client.clusterImport({ contextName })` -> `{ clusters: ClusterInfo[], error }`
- `client.clusterList()` -> `{ clusters: ClusterInfo[], error }`  (ClusterInfo: {id,contextName,displayName,state,nodeCount?,podCount?,lastError?})
- `client.clusterConnect({ id })` -> `{ cluster: ClusterInfo|null, error }`
- `client.clusterResources({ id, kind: "pods", namespace? })` -> `{ kind, items: unknown[], error }`  (items = PodDTO: {name,namespace,phase,ready,restarts,node?,statusReason?})

## FILE TAO/SUA

### 1. `packages/app/src/screens/clusters-screen.tsx` (TAO)
Component `ClustersScreen`:
- Lay `serverId` tu route param (expo-router `useLocalSearchParams`) HOAC host dang ket noi dau tien (useHosts). `const client = useHostRuntimeClient(serverId)`.
- State: contexts, clusters, selectedClusterId, pods, loading/error.
- useEffect on mount: neu client, goi `clusterList()` -> setClusters; `clusterContexts()` -> setContexts.
- UI (dung tokens + unistyles):
  - Header "Clusters".
  - Section "Detected contexts" (tu clusterContexts): moi context 1 row: dot + name + server (muted) + nut "Import" (goi clusterImport({contextName}) roi refresh clusterList). Neu context da co trong clusters (theo contextName) -> hien "Imported".
  - Section "Clusters" (tu clusterList): moi cluster 1 card: dot mau theo state (connected=green[400], connecting=amber[500], error=red[500], saved=border) — MIRROR `hostStatusDotColor`; ten + state text; nut "Connect" (goi clusterConnect({id}) roi refresh) khi state != connected; khi connected hien nodeCount/podCount + nut "Workloads" set selectedClusterId + goi clusterResources({id,kind:"pods"}) -> setPods.
  - Section "Pods" (khi co selectedClusterId): FlatList pods: dot theo phase/statusReason (CrashLoop/Failed=red, Pending=amber, Running=green) + name + namespace(muted) + ready + restarts. Desktop: cot; mobile (useIsCompactFormFactor): card. Empty state hop le neu 0 pod.
- Moi loi RPC -> hien error text, KHONG nuot.

### 2. Route — them file expo-router
- Xem cach route host ton tai (grep `app/h/[serverId]`), tao `packages/app/src/app/h/[serverId]/clusters.tsx` render `<ClustersScreen />` (lay serverId tu param). Neu cau truc khac, theo dung pattern route hien co cua man Sessions/Settings.

### 3. Entry point — `left-sidebar.tsx` footer
- Them 1 icon button (lucide `Boxes` qua withUnistyles) o hang footer icon (canh Hosts/Home/Settings) route toi clusters (dung `buildClustersRoute(serverId)` neu them vao host-routes.ts, hoac router.push truc tiep). serverId = host dang active.
- Neu them `buildClustersRoute` vao `packages/app/src/utils/host-routes.ts` theo pattern `buildSettingsRoute`.

## LENH BAN PHAI TU CHAY (nghia "xong")
1. `npm run typecheck --workspace=@jagentdesk/app` -> 0 loi.
2. `npx oxlint packages/app/src/screens/clusters-screen.tsx packages/app/src/app/h/[serverId]/clusters.tsx packages/app/src/utils/host-routes.ts packages/app/src/components/left-sidebar.tsx` -> 0 error (complexity <=20; tach component/helper neu can).
3. `npx oxfmt --check packages/app/src/screens/clusters-screen.tsx` -> format dung (chay oxfmt neu can).
Bao cao: dan output + danh sach file da tao/sua. (Screenshot/live do orchestrator chay o GATE.)
