# MANIFEST — Story 21: "Ask an agent" moi noi (agent chat + kubectl context)

Ban la CODER @jagentdesk/app branch k8s/s1a-kube-client. Them nut Ask/Diagnose spawn agent voi
context resource + cluster, dieu huong toi chat. "Agent chat bat cu dau."

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG useUnistyles. KHONG mock. KHONG sua file ngoai danh sach.

## CHI DUOC DOC
- `packages/app/src/components/cluster-resource-detail.tsx` (props serverId,clusterId,kind,namespace,name; client; yaml state)
- `packages/app/src/components/cluster-resource-browser.tsx` (them nut "Ask an agent" cap cluster/kind)
- `packages/app/src/screens/clusters-screen.tsx` (nut "Ask an agent" tren cluster card da connect)
- `packages/client/src/daemon-client.ts` (createAgent ~2552, options ~387; fetchWorkspaces ~4)
- `packages/app/src/utils/navigate-to-agent/index.ts` (navigateToAgent)
- `packages/app/src/hooks/use-providers-snapshot.ts` (lay provider kha dung) — HOAC session store providers
- `packages/app/src/stores/session-store.ts` (lay workspace cwd hien co)

## TAO helper `packages/app/src/components/cluster-ask-agent.ts`
- `export async function askAgentAboutResource(input: { client, serverId, clusterId, kind, namespace?, name?, yaml?, provider, cwd }): Promise<void>`
  - Tao prompt:
    ```
    You are operating Kubernetes cluster "<clusterId>".
    <Neu co name: Diagnose <kind> "<name>"<neu ns: in namespace "<ns>">. | Neu khong: Help manage cluster "<clusterId>".>
    Use kubectl_get (action get/describe/logs/list) and kubectl_apply with clusterId="<clusterId>".
    Inspect the resource, recent events and logs, then report the likely cause and a safe fix.
    ```
  - `const agent = await client.createAgent({ provider, cwd, initialPrompt: prompt, labels: { "jagentdesk.cluster.id": clusterId }, ...(yaml ? { attachments: [{ type:"text", mimeType:"text/plain", title: `${kind}/${name}.yaml`, text: yaml }] } : {}) });`
  - `navigateToAgent({ serverId, agentId: agent.id });`

## Nut UI (3 cho)
- `cluster-resource-detail.tsx`: nut "Diagnose" (co name+yaml).
- `cluster-resource-browser.tsx`: nut "Ask an agent" cap kind hien tai (khong name).
- `clusters-screen.tsx`: nut "Ask an agent" tren cluster card da connect (chi clusterId).
Moi cho: lay provider = provider dau tien kha dung (use-providers-snapshot / session); cwd = cwd cua workspace dau tien trong session store (hoac tu fetchWorkspaces). NEU khong co provider hoac khong co workspace/cwd -> nut disabled + text nho "Connect a host & add a project first". Bat loi createAgent -> hien thong bao, KHONG crash.
Styling StyleSheet + tokens, KHONG useUnistyles.

## LENH TU CHAY:
1. `npm run typecheck --workspace=@jagentdesk/app` -> 0
2. `npx oxlint packages/app/src/components/cluster-ask-agent.ts packages/app/src/components/cluster-resource-detail.tsx packages/app/src/components/cluster-resource-browser.tsx packages/app/src/screens/clusters-screen.tsx` -> 0 error (complexity <=20)
3. `npx oxfmt --check packages/app/src/components/cluster-ask-agent.ts` -> ok
Bao cao + xac nhan createAgent + navigateToAgent duoc goi.
