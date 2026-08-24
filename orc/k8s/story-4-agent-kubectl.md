# MANIFEST — Story 4: agent kubectl tool (read auto-run + write qua permission card)

Ban la CODER trong @jagentdesk/server. Them 2 tool cho agent: kubectl_get (read, auto-run) va
kubectl_apply (write, hien permission card Deny/Accept). Tai dung ClusterRegistry/KubeClient da co.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG mock. KHONG sua file ngoai danh sach.
## agent-manager.ts la FILE LOI 4000 dong — sua TOI THIEU, dung lam vo cai cu.

## CHI DUOC DOC
- `packages/server/src/server/agent/tools/jagentdesk-tools.ts` (registry: JAgentDeskToolHostDependencies ~line100, createJAgentDeskToolCatalog ~548, registerTool ~585, tool mau list_workspaces ~1490)
- `packages/server/src/server/agent/tools/types.ts` (JAgentDeskToolDefinition)
- `packages/server/src/server/agent/agent-manager.ts` (respondToPermission ~2361/2370, onStreamPermissionRequested ~3954, dispatchStream, requireAgent, emitState)
- `packages/server/src/server/agent/providers/acp-agent.ts` (requestPermission ~2167 — pattern raise card)
- `packages/server/src/server/agent/agent-sdk-types.ts` (AgentPermissionRequest ~ , AgentPermissionResponse ~445/467, permission_requested/resolved events)
- `packages/server/src/server/bootstrap.ts` (clusterRegistry da tao ~1206; createAgentToolHostDependencies ~1305)
- `packages/server/src/server/cluster/kube-client.ts` + `cluster-registry.ts` (getClient, listGeneric, getGeneric, applyWrite)

## THAY DOI

### A. `agent-manager.ts` — host permission bridge (cho tool write hien card)
1. Them field: `private hostToolPermissions = new Map<string, (r: AgentPermissionResponse) => void>();`
2. Them method `async requestHostToolPermission(agentId, request): Promise<AgentPermissionResponse>`:
   - `const agent = this.requireAgent(agentId);` sinh `id = randomUUID()`; dung `AgentPermissionRequest` day du (id + provider = agent.session.provider + request fields).
   - Luu resolve vao hostToolPermissions, LUU request vao `agent.pendingPermissions` (giong onStreamPermissionRequested lam) + broadcast attention "permission" de card hien.
   - `this.dispatchStream(agentId, { type: "permission_requested", provider, request })`.
   - return Promise cho toi khi resolve.
3. Trong `respondToPermission(agentId, requestId, response)` — NGAY DAU, truoc khi goi agent.session.respondToPermission:
   ```
   const hostResolve = this.hostToolPermissions.get(requestId);
   if (hostResolve) {
     this.hostToolPermissions.delete(requestId);
     agent.pendingPermissions.delete(requestId);
     this.dispatchStream(agentId, { type: "permission_resolved", provider: agent.session.provider, requestId, resolution: response });
     this.emitState(agent);
     hostResolve(response);
     return;
   }
   ```
   Giu nguyen phan con lai. (Kiem ten field/method that: requireAgent, dispatchStream, emitState, pendingPermissions, broadcastAgentAttention — dung dung ten trong file.)

### B. `jagentdesk-tools.ts` — 2 tool
1. `JAgentDeskToolHostDependencies` (~100): them `clusterRegistry?: ClusterRegistry;` (import type tu ../../cluster/cluster-registry.js). Neu tool write can goi agentManager.requestHostToolPermission, them `agentManager?` vao deps neu chua co (kiem xem deps da co tham chieu agentManager chua; neu chua, them `requestHostToolPermission?: (agentId, req) => Promise<AgentPermissionResponse>` vao deps de tranh vong phu thuoc).
2. registerTool "kubectl_get" (read, auto-run): inputSchema {clusterId, action: enum["get","list","describe","logs"], kind, namespace?, name?}. handler: `const client = options.clusterRegistry?.getClient(clusterId)`; action list -> JSON listGeneric(kind,ns); logs -> getPodLogs; else getGeneric. Tra {content:[{type:"text",text}]}.
3. registerTool "kubectl_apply" (write): inputSchema {clusterId, action: enum["apply","delete","scale","restart"], manifestYaml?, kind?, namespace?, name?, replicas?}. handler:
   - `if (!callerAgentId) throw`. client tu getClient.
   - (tuy chon) dry-run truoc: client.applyWrite({...,dryRun:true}) de dua vao mo ta.
   - Goi permission bridge: `const decision = await options.requestHostToolPermission(callerAgentId, { name:"kubectl_apply", kind:"tool", title:`${action} on ${clusterId}`, description: manifestYaml ?? `${action} ${kind}/${name}`, input });`
   - `if (decision.behavior !== "allow") return {content:[{type:"text",text:"Denied by user."}], isError:true};`
   - `const result = await client.applyWrite({ kind, namespace, name, action, replicas, manifestYaml, dryRun:false });` tra JSON.

### C. `bootstrap.ts` — wiring
- Trong `createAgentToolHostDependencies` (~1305): them `clusterRegistry,` (instance ~1206) + `requestHostToolPermission: (agentId, req) => agentManager.requestHostToolPermission(agentId, req),` (dung agentManager co san trong scope; neu khong co, tra bien phu hop).

### D. Test — `packages/server/src/server/agent/tools/kubectl-tools.test.ts` (TAO)
- Test catalog dang ky "kubectl_get" + "kubectl_apply".
- Test kubectl_apply goi requestHostToolPermission va KHI decision.behavior !== "allow" thi KHONG goi applyWrite (mock clusterRegistry + requestHostToolPermission). KHI "allow" thi goi applyWrite dryRun:false.
- KHONG Date.now(), KHONG cluster that.

## LENH TU CHAY (nghia "xong")
1. `cd packages/server && npx tsgo -p tsconfig.server.typecheck.json --noEmit` -> 0 loi
2. `npx oxlint packages/server/src/server/agent/tools/jagentdesk-tools.ts packages/server/src/server/agent/tools/kubectl-tools.test.ts packages/server/src/server/agent/agent-manager.ts packages/server/src/server/bootstrap.ts` -> 0 error (complexity <=20)
3. `cd packages/server && npx vitest run src/server/agent/tools/kubectl-tools.test.ts src/server/agent/agent-prompt.test.ts` -> xanh (agent-prompt.test.ts PHAI van xanh = khong regression)
Bao cao output 3 lenh.
