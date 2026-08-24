# MANIFEST — Story 7b: exec/shell UI (terminal don gian vao pod)

Ban la CODER @jagentdesk/app branch k8s/s1a-kube-client. Them Shell vao pod detail dung exec stream.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG useUnistyles. KHONG mock. KHONG sua file ngoai danh sach.

## CHI DUOC DOC
- `packages/app/src/components/cluster-resource-detail.tsx`
- `packages/client/src/daemon-client.ts` (clusterExecStart)
- `packages/app/src/styles/theme.ts`

## API: `client.clusterExecStart({id,namespace,pod,container?,command?}, onData) -> {execId, write:(d)=>void, close:()=>Promise<void>}`

## FILE TAO: `packages/app/src/components/cluster-pod-shell.tsx`
`ClusterPodShell({serverId, clusterId, namespace, pod, container?, onClose})`:
- On mount: clusterExecStart(command: ["/bin/sh"], onData -> append vao output buffer, gioi han ~2000 dong, auto-scroll).
- Output: monospace ScrollView (surface0). Input: 1 dong TextInput; nhan Enter/Send -> write(text + "\n"); clear input.
- useEffect cleanup PHAI goi close() (tranh leak exec). Nut Close -> close() + onClose.
- Neu loi (exec fail) -> hien text ro. StyleSheet + tokens, KHONG useUnistyles.

## FILE SUA: `packages/app/src/components/cluster-resource-detail.tsx`
- KHI kind === "Pod": nut "Shell" -> mo <ClusterPodShell .../> (trong sheet/modal hoac inline section).

## LENH TU CHAY:
1. `npm run typecheck --workspace=@jagentdesk/app` -> 0
2. `npx oxlint packages/app/src/components/cluster-pod-shell.tsx packages/app/src/components/cluster-resource-detail.tsx` -> 0 error (complexity <=20)
3. `npx oxfmt --check packages/app/src/components/cluster-pod-shell.tsx` -> ok
Bao cao. Chu y: cleanup PHAI close() exec.
