# MANIFEST — Story 8: port-forward UI (start/stop status)
CODER @jagentdesk/app branch k8s/s1a-kube-client. Them Port-forward action cho Pod (va Service neu de).
CAM: KHONG WebFetch, KHONG oxfmt toan repo, KHONG useUnistyles, KHONG mock, KHONG sua file ngoai danh sach.
DOC: cluster-resource-detail.tsx, daemon-client.ts (clusterPortForwardStart), styles/theme.ts.
API: client.clusterPortForwardStart({id,namespace,pod,podPort}, onData) -> {pfId, write, close}.
FILE SUA cluster-resource-detail.tsx: KHI kind Pod, them nut "Port-forward". Nhan -> hoi podPort (TextInput so, default 80) -> clusterPortForwardStart -> hien trang thai "Forwarding pod:<port> on daemon host (active)" + nut Stop (goi close()). useEffect cleanup PHAI close(). Hien so bytes nhan (dem tu onData) de chung to luong that. StyleSheet KHONG useUnistyles.
LENH: 1) npm run typecheck --workspace=@jagentdesk/app -> 0; 2) npx oxlint packages/app/src/components/cluster-resource-detail.tsx -> 0 error; 3) npx oxfmt --check ... -> ok. Bao cao. cleanup PHAI close().
