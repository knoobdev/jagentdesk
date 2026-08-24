# MANIFEST — Story 1d-logs-ui: Follow (live) toggle trong logs viewer

Ban la CODER @jagentdesk/app branch k8s/s1a-kube-client. Them che do Follow (live stream) vao logs viewer.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG useUnistyles. KHONG mock. KHONG sua file ngoai danh sach.

## CHI DUOC DOC
- `packages/app/src/components/cluster-resource-detail.tsx` (logs viewer S6 o day)
- `packages/client/src/daemon-client.ts` (clusterLogsSubscribe)
- `packages/app/src/styles/theme.ts`

## API: `client.clusterLogsSubscribe({id,namespace,pod,container?}, onChunk)` -> `{subscriptionId, unsubscribe: ()=>Promise<void>}`

## FILE SUA: `packages/app/src/components/cluster-resource-detail.tsx`
- Trong logs viewer (kind Pod), them toggle "Follow" (live).
- Khi bat: goi clusterLogsSubscribe, onChunk append vao state log (buffer, gioi han ~2000 dong cuoi de tranh phinh), auto-scroll xuong.
- Khi tat / dong detail / unmount: goi unsubscribe() (useEffect cleanup PHAI unsubscribe -> tranh leak stream).
- Giu nut Refresh (one-shot) cho che do khong follow. StyleSheet + tokens, KHONG useUnistyles.

## LENH TU CHAY:
1. `npm run typecheck --workspace=@jagentdesk/app` -> 0
2. `npx oxlint packages/app/src/components/cluster-resource-detail.tsx` -> 0 error (complexity <=20 tach helper/sub-component neu can)
3. `npx oxfmt --check packages/app/src/components/cluster-resource-detail.tsx` -> ok
Bao cao. Chu y: useEffect cleanup PHAI unsubscribe.
