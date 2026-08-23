# MANIFEST — Story 1a: daemon kube-client core (KHONG protocol, KHONG UI)

Ban la CODER. Lam DUNG manifest nay, KHONG hon KHONG kem.

## CAM TUYET DOI
- KHONG WebFetch, KHONG tim du an khac, KHONG doc file ngoai danh sach duoi.
- KHONG mock data, KHONG ten nguoi bia, KHONG example.com, KHONG Date.now() trong duong co test.
- KHONG dung sang package khac ngoai `@jagentdesk/server`.
- KHONG sua file ngoai danh sach "FILE TAO/SUA".
- DTO tra ve client TUYET DOI KHONG chua token / certificate-authority-data / client-key-data /
  bearer / password. Credential o lai kubeconfig tren host.

## CHI DUOC DOC (de hoc pattern + API)
- `packages/server/package.json` (them dependency)
- `packages/server/src/server/daemon-config-store.ts` (pattern luu config, neu can persist danh sach cluster)
- `packages/server/tsconfig.server.json`
- `node_modules/@kubernetes/client-node/dist/index.d.ts` (API cua thu vien — DOC de biet chu ky ham)
- `orc/k8s/probe-read.ts` (hop dong API ban PHAI khop)

## BUOC 0 — them dependency
Chay: `npm install --workspace=@jagentdesk/server @kubernetes/client-node@^1`
Dung API kieu 1.x (promise, tham so dang OBJECT: `listPodForAllNamespaces()`,
`listNamespacedPod({ namespace })`, v.v.). Kiem chu ky that trong `index.d.ts` truoc khi goi.

## FILE TAO (tat ca trong `packages/server/src/server/cluster/`)

### 1. `cluster-dto.ts` — kieu DTO serializable (KHONG credential)
```ts
export interface KubeContextInfo { name: string; cluster: string; server: string; user: string; namespace?: string; current: boolean; }
export type ClusterConnectionState = "saved" | "connecting" | "connected" | "error";
export interface ContainerDTO { name: string; image: string; ready: boolean; restartCount: number; state: string; /* Running|Waiting:<reason>|Terminated:<reason> */ memoryLimit?: string; memoryRequest?: string; lastExitCode?: number; }
export interface PodDTO { name: string; namespace: string; phase: string; ready: string; /* "1/1" */ restarts: number; node?: string; containers: ContainerDTO[]; labels: Record<string,string>; createdAt_ms: number; statusReason?: string; /* CrashLoopBackOff... */ }
export interface DeploymentDTO { name: string; namespace: string; ready: string; available: number; desired: number; updatedAt_ms: number; labels: Record<string,string>; }
export interface NodeDTO { name: string; ready: boolean; roles: string[]; version: string; cpuCapacity?: string; memoryCapacity?: string; }
export interface EventDTO { type: string; /* Normal|Warning */ reason: string; message: string; involvedKind: string; involvedName: string; namespace?: string; lastSeen_ms: number; }
export interface ClusterInfo { id: string; /* clu_<hex> */ contextName: string; displayName: string; distro?: string; state: ClusterConnectionState; nodeCount?: number; podCount?: number; lastError?: string; lastSeen_ms?: number; }
export interface WriteResult { ok: boolean; dryRun: boolean; message: string; }
```
YEU CAU: KHONG them field nao chua credential. Moc thoi gian hau to `_ms`, la Unix ms UTC (`new Date(x).getTime()`).

### 2. `kube-config-source.ts`
- `export async function detectKubeContexts(): Promise<KubeContextInfo[]>`
  - `const kc = new KubeConfig(); kc.loadFromDefault();`
  - Map `kc.getContexts()` -> KubeContextInfo. `server` lay tu `kc.getCluster(ctx.cluster)?.server`.
    `current` = `ctx.name === kc.getCurrentContext()`.
- `export function contextsFromKubeconfigString(yaml: string): KubeContextInfo[]`
  - `const kc = new KubeConfig(); kc.loadFromString(yaml);` roi map nhu tren.

### 3. `kube-client.ts`
- `export class KubeClient`
  - `constructor(contextName: string)`
  - `async connect(): Promise<void>` — `this.kc = new KubeConfig(); this.kc.loadFromDefault(); this.kc.setCurrentContext(contextName);` tao `CoreV1Api`, `AppsV1Api` qua `kc.makeApiClient(...)`. Goi 1 lenh nhe (vd `listNamespace` hoac version) de xac nhan ket noi; loi -> throw ro rang.
  - `async listPods(namespace?: string): Promise<PodDTO[]>` — namespace undefined => tat ca namespace. Map dung: `ready` = `<so container ready>/<tong>`, `restarts` = tong restartCount, `statusReason` tu container waiting reason hoac pod phase, `lastExitCode` tu lastState.terminated.exitCode.
  - `async listDeployments(namespace?): Promise<DeploymentDTO[]>`
  - `async listNodes(): Promise<NodeDTO[]>` — `ready` tu condition type Ready == "True"; roles tu label `node-role.kubernetes.io/*`.
  - `async listEvents(namespace?): Promise<EventDTO[]>`
  - `async getResourceYaml(kind: string, namespace: string | undefined, name: string): Promise<string>` — tra YAML manifest (dung `js-yaml` neu co san trong deps, neu khong tra JSON string; KIEM deps truoc).
  - `async getPodLogs(namespace: string, pod: string, container?: string): Promise<string>`
  - `async applyWrite(op: { kind: string; namespace?: string; name: string; action: "scale"|"delete"|"restart"|"apply"; replicas?: number; manifestYaml?: string; dryRun: boolean }): Promise<WriteResult>` — khi `dryRun` true, dung tham so dryRun cua API (`dryRun: "All"`) de KHONG mutate. Tra WriteResult ro rang.
  - `async disconnect(): Promise<void>`

### 4. `cluster-registry.ts`
- `export class ClusterRegistry`
  - `importContext(contextName: string, displayName?: string): ClusterInfo` — sinh id `clu_` + 12 hex (dung `crypto.randomBytes`). state = "saved".
  - `importKubeconfigString(yaml: string, displayName?: string): ClusterInfo[]`
  - `list(): ClusterInfo[]`
  - `async connect(id: string): Promise<ClusterInfo>` — state connecting -> tao KubeClient.connect() -> connected; cap nhat nodeCount/podCount tu listNodes/listPods; loi -> state "error" + lastError. `lastSeen_ms` cap nhat.
  - `async disconnect(id: string): Promise<void>`
  - `getClient(id: string): KubeClient | undefined`
  - Persist DANH SACH cluster (chi contextName + displayName + id, KHONG credential) qua daemon-config-store neu de; neu kho, giu in-memory + TODO comment. KHONG persist token.

### 5. `cluster.test.ts` (unit, KHONG can cluster that)
- Test `detectKubeContexts` va mapping DTO bang cach mock KubeConfig/api o TANG THU VIEN (vi::mock `@kubernetes/client-node`), KHONG mock DTO ket qua. Test: pod co 2 container 1 ready => ready "1/1"; restarts = tong; statusReason lay dung; DTO khong co field credential (assert khong co key token/cert).
- KHONG Date.now() — dung moc co dinh trong fixture.

## LENH BAN PHAI TU CHAY (nghia "xong")
1. `npm install --workspace=@jagentdesk/server @kubernetes/client-node@^1` -> thanh cong.
2. `cd packages/server && npx tsgo -p tsconfig.server.typecheck.json --noEmit` -> 0 loi.
3. `cd packages/server && npx vitest run src/server/cluster/cluster.test.ts` -> xanh.
4. Tu repo root: `npx tsx orc/k8s/probe-read.ts` -> in dong `PROBE_OK pods=<N>` (N>=0) tu cluster THAT
   read-only. Neu loi ket noi cluster, in ro loi — KHONG duoc mock de gia dat.
Bao cao: dan output 4 lenh. "Xong" = ca 4 chay dung, dac biet [4] list pod THAT.
