# MANIFEST — Story 1c: generic dynamic resource engine (moi GVK) + apply YAML that

Ban la CODER. Mo rong `packages/server/src/server/cluster/kube-client.ts` (S1a) de phu MOI kind
(khong chi 4 kind cung). Day la chia khoa full Lens parity. GIU nguyen cac method cu.

## CAM TUYET DOI
- KHONG WebFetch. Chi doc file trong danh sach.
- KHONG mock. `applyGeneric` phai goi API that (dryRun that de khong mutate).
- KHONG xoa/sua method cu cua kube-client (listPods...). Chi THEM.
- DTO/ket qua len wire KHONG chua credential.

## CHI DUOC DOC
- `packages/server/src/server/cluster/kube-client.ts` (S1a — them vao day)
- `packages/server/src/server/cluster/cluster-dto.ts`
- `node_modules/@kubernetes/client-node/dist/index.d.ts` (tim class `KubernetesObjectApi`, `ApiextensionsV1Api`, chu ky `list/read/create/patch/delete`)
- `orc/k8s/probe-generic.ts` (hop dong API ban PHAI khop)

## THEM VAO `kube-client.ts`

### 1. Bang `GENERIC_KINDS` (export const, o cuoi file)
Mang READONLY moi phan tu `{ kind, apiVersion, namespaced, category }` phu HET built-in Lens
(toi thieu 30 kind), category thuoc: "Cluster"|"Workloads"|"Config"|"Network"|"Storage"|"Access"|"Custom".
Bat buoc co (dung apiVersion CHINH XAC):
- Workloads: Pod v1(ns), Deployment apps/v1(ns), DaemonSet apps/v1(ns), StatefulSet apps/v1(ns),
  ReplicaSet apps/v1(ns), ReplicationController v1(ns), Job batch/v1(ns), CronJob batch/v1(ns)
- Config: ConfigMap v1(ns), Secret v1(ns), ResourceQuota v1(ns), LimitRange v1(ns),
  HorizontalPodAutoscaler autoscaling/v2(ns), PodDisruptionBudget policy/v1(ns),
  PriorityClass scheduling.k8s.io/v1(cluster), RuntimeClass node.k8s.io/v1(cluster)
- Network: Service v1(ns), Endpoints v1(ns), Ingress networking.k8s.io/v1(ns),
  IngressClass networking.k8s.io/v1(cluster), NetworkPolicy networking.k8s.io/v1(ns)
- Storage: PersistentVolumeClaim v1(ns), PersistentVolume v1(cluster), StorageClass storage.k8s.io/v1(cluster)
- Cluster: Namespace v1(cluster), Node v1(cluster), Event v1(ns)
- Access: ServiceAccount v1(ns), ClusterRole rbac.authorization.k8s.io/v1(cluster),
  Role rbac.authorization.k8s.io/v1(ns), ClusterRoleBinding rbac.../v1(cluster), RoleBinding rbac.../v1(ns)

### 2. Method generic (dung `KubernetesObjectApi`)
Trong `connect()`, THEM `this.objectApi = KubernetesObjectApi.makeApiClient(this.kc)` (import tu client-node).
- `async listGeneric(kind: string, namespace?: string): Promise<Array<Record<string, unknown>>>`
  - Tra cuu apiVersion tu GENERIC_KINDS theo kind (case-insensitive). Neu namespaced && namespace cho => list trong ns; neu khong => list all-namespaces/cluster-scope.
  - Dung `this.objectApi.list(apiVersion, kind, namespace)` (kiem chu ky that trong index.d.ts; mot so version tra `{ items }`). Tra mang item raw.
- `async getGeneric(kind: string, namespace: string | undefined, name: string): Promise<string>` — read qua objectApi roi `dumpYaml`.
- `async applyGeneric(manifestYaml: string, dryRun: boolean): Promise<WriteResult>`
  - parse yaml (`loadYaml` tu client-node), dung `this.objectApi.patch(obj, undefined, dryRun ? "All" : undefined, "jagentdesk", true)` kieu server-side apply (fieldManager "jagentdesk", force). Neu object chua ton tai, fallback `create(obj, ..., dryRun)`. Tra WriteResult ro rang. dryRun=true PHAI khong mutate.
- `async deleteGeneric(kind: string, namespace: string | undefined, name: string, dryRun: boolean): Promise<WriteResult>`
- `async discoverCRDs(): Promise<Array<{ kind: string; apiVersion: string; namespaced: boolean; category: "Custom" }>>`
  - `ApiextensionsV1Api.makeApiClient(kc)` -> `listCustomResourceDefinition()` -> map moi CRD -> kind (spec.names.kind), apiVersion (`<group>/<served version>`), namespaced (spec.scope === "Namespaced").
- `async revealSecret(namespace: string, name: string): Promise<Record<string,string>>` — read Secret, base64-decode `.data` -> plaintext map. (CHI khi duoc goi tuong minh; day la thao tac thu cong co chu y.)

Cap nhat `applyWrite` action "apply": goi `applyGeneric(op.manifestYaml, op.dryRun)` thay cho stub "not yet implemented".

### 3. Test — them vao `cluster.test.ts` (hoac `cluster-generic.test.ts`)
Mock `@kubernetes/client-node` tang thu vien. Test: GENERIC_KINDS co >=30 kind + co Pod/Service/Namespace/CustomResourceDefinition; listGeneric tra mang; applyGeneric dryRun goi patch voi dryRun="All". KHONG Date.now().

## LENH BAN PHAI TU CHAY (nghia "xong")
1. `npx oxlint packages/server/src/server/cluster/*.ts` -> 0 error (chu y complexity <=20: tach helper neu can).
2. `cd packages/server && npx tsgo -p tsconfig.server.typecheck.json --noEmit` -> 0 loi.
3. `cd packages/server && npx vitest run src/server/cluster/` -> xanh.
4. Tu repo root: `npx tsx orc/k8s/probe-generic.ts` -> in `PROBE_OK kinds=>=30 ... applyDryRun=ok` tu cluster THAT.
Bao cao: dan output 4 lenh.
