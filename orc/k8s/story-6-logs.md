# MANIFEST — Story 6: Pod logs viewer

Ban la CODER @jagentdesk/app branch k8s/s1a-kube-client. Them xem log pod (mot-shot qua clusterLogs).

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG useUnistyles. KHONG mock. KHONG sua file ngoai danh sach.

## CHI DUOC DOC
- `packages/app/src/components/cluster-resource-detail.tsx` (S3b — them Logs vao)
- `packages/app/src/components/adaptive-modal-sheet.tsx`
- `packages/client/src/daemon-client.ts` (clusterLogs)
- `packages/app/src/styles/theme.ts`

## API (da co): `client.clusterLogs({ id, namespace, pod, container? })` -> `{ logs: string|null, error }`

## FILE SUA: `packages/app/src/components/cluster-resource-detail.tsx`
- KHI kind === "Pod" (case-insensitive): them nut "Logs" trong action bar.
- Nhan Logs -> goi clusterLogs({id, namespace, pod: name}) -> hien log trong khoi monospace scroll doc,
  nen surface0, chu foregroundMuted, wrap. Co nut Refresh (goi lai). Co container selector NEU item
  co nhieu container (doc tu YAML da tai hoac bo qua neu khong biet -> chi pod-level). Empty/loading/error hop le.
- Styling StyleSheet + tokens, KHONG useUnistyles.

## LENH TU CHAY:
1. `npm run typecheck --workspace=@jagentdesk/app` -> 0
2. `npx oxlint packages/app/src/components/cluster-resource-detail.tsx` -> 0 error
3. `npx oxfmt --check packages/app/src/components/cluster-resource-detail.tsx` -> ok (chay oxfmt neu can, chi file nay)
Bao cao output.
