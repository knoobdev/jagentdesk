# MANIFEST — Story conv-ui: wire reveal-secret / node-op / cronjob-op vao detail

Ban la CODER @jagentdesk/app branch k8s/s1a-kube-client. Them nut theo kind vao resource detail.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG useUnistyles. KHONG mock. KHONG sua file ngoai danh sach.

## CHI DUOC DOC
- `packages/app/src/components/cluster-resource-detail.tsx` (them vao)
- `packages/client/src/daemon-client.ts` (clusterRevealSecret, clusterNodeOp, clusterCronjobOp)
- `packages/app/src/styles/theme.ts`

## API (da co):
- `client.clusterRevealSecret({id,namespace,name})` -> `{ data: Record<string,string>|null, error }`
- `client.clusterNodeOp({id,name,op:"cordon"|"uncordon"})` -> `{ result:{ok,message}|null, error }`
- `client.clusterCronjobOp({id,namespace,name,op:"trigger"|"suspend"|"resume"})` -> `{ result:{ok,message}|null, error }`

## FILE SUA: `packages/app/src/components/cluster-resource-detail.tsx`
Trong action bar, them nut theo kind (case-insensitive):
- kind === "Secret": nut "Reveal". Nhan -> clusterRevealSecret -> hien tung key: value (plaintext) trong khoi
  monospace. Co canh bao nho "Sensitive — revealed values" (mau warning). Nut "Hide" de an lai.
- kind === "Node": nut "Cordon" va "Uncordon" -> clusterNodeOp. Hien result.message. Sau thanh cong onChanged.
- kind === "CronJob": nut "Trigger", "Suspend", "Resume" -> clusterCronjobOp. Hien message.
Moi ket qua/loi hien ro. Styling StyleSheet + tokens, KHONG useUnistyles.

## LENH TU CHAY:
1. `npm run typecheck --workspace=@jagentdesk/app` -> 0
2. `npx oxlint packages/app/src/components/cluster-resource-detail.tsx` -> 0 error (complexity <=20 tach helper/sub-component neu can)
3. `npx oxfmt --check packages/app/src/components/cluster-resource-detail.tsx` -> ok
Bao cao output.
