# Lens parity matrix — full k8slens feature coverage cho JAgentDesk

Muc tieu: phu HET chuc nang Lens (docs.k8slens.dev), khong phai lat cat. Kien truc:
**generic resource engine** (discovery + dynamic client: list/get/watch/apply/delete moi GVK) +
renderer/columns/actions theo tung loai + operations (logs/shell/port-forward/metrics) + agent.
S1a (kube-client core) DA XONG nhung chi 4 kind cung — S1c se tong quat hoa.

## A. Resource kinds phai phu (theo sidebar Lens)

### Cluster
- [ ] Overview (metrics CPU/mem/pod usage, health, cluster info)
- [ ] Nodes — list, detail, cordon/uncordon, drain, taints, conditions, metrics, shell-to-node

### Workloads
- [ ] Overview (workloads status charts)
- [ ] Pods — detail, logs, shell/exec, port-forward, delete, edit, containers, env, volumes, metrics
- [ ] Deployments — scale, restart, rollback, edit, delete, pods, revisions
- [ ] DaemonSets — edit, delete, pods
- [ ] StatefulSets — scale, edit, delete, pods
- [ ] ReplicaSets — scale, delete
- [ ] ReplicationControllers
- [ ] Jobs — delete, pods, logs
- [ ] CronJobs — trigger now, suspend/resume, delete

### Config
- [ ] ConfigMaps — view/edit data
- [ ] Secrets — reveal (base64 decode), edit, delete
- [ ] ResourceQuotas
- [ ] LimitRanges
- [ ] HorizontalPodAutoscalers
- [ ] PodDisruptionBudgets
- [ ] PriorityClasses
- [ ] RuntimeClasses
- [ ] MutatingWebhookConfigurations / ValidatingWebhookConfigurations

### Network
- [ ] Services — detail, endpoints, port-forward
- [ ] Endpoints
- [ ] Ingresses
- [ ] IngressClasses
- [ ] NetworkPolicies
- [ ] Port Forwarding — manage active forwards (start/stop/list)

### Storage
- [ ] PersistentVolumeClaims
- [ ] PersistentVolumes
- [ ] StorageClasses

### Namespaces — list, create, delete, detail, multi-select selector

### Events — global, filter type/namespace/object, sort by lastSeen

### Access Control (RBAC)
- [ ] ServiceAccounts
- [ ] ClusterRoles / Roles
- [ ] ClusterRoleBindings / RoleBindings

### Custom Resources
- [ ] CRD definitions list
- [ ] Custom resource instances (dynamic, per CRD) — list/detail/edit/delete

### Helm
- [ ] Releases — list, detail, values, history, upgrade, rollback, uninstall
- [ ] Charts — repos, browse, install

## B. Thao tac xuyen suot (moi resource)
- [ ] List: filter (namespace/search/label), sort, chon cot
- [ ] Detail drawer: metadata, spec, status, related, events, owner refs
- [ ] YAML: view + EDIT + apply (server-side apply, dry-run truoc) — scope da chot cho sua YAML
- [ ] Delete (confirm) / Create-from-YAML
- [ ] Scale (workloads), Restart (rolling), Rollback (deploy)
- [ ] Logs: stream, multi-container, previous, since/tail
- [ ] Shell/exec vao container (PTY, reuse terminal infra)
- [ ] Port-forward: start/stop, list active
- [ ] Metrics: CPU/mem (metrics-server; Prometheus optional)
- [ ] Node ops: cordon/uncordon/drain

## C. App-level
- [ ] Add cluster: auto kubeconfig + paste + manual (C1/C2) + Watch kubeconfig
- [ ] Multi-cluster catalog, connect/disconnect (C3/C4)
- [ ] Namespace selector (multi), global search
- [ ] Cluster overview dashboard
- [ ] AGENT (diem manh rieng): kubectl tool read auto + write qua permission Deny/Accept;
      "Diagnose pod", "Explain YAML", "Propose fix"

## D. Story DAG day du (thay cho S1-S5 cu)

FOUNDATION (daemon/protocol)
- S1a  kube-client core (4 kind cung) ................................ ✅ DONE (c4cab37bb)
- S1b  cluster RPC domain (protocol+session+client) ................. 🔄 dang chay
- S1c  GENERIC dynamic engine: discovery API + list/get/watch/apply/delete moi GVK; secrets reveal; metrics client
- S1d  streaming: watch subscription + log stream + exec/shell PTY + port-forward (protocol+server)

APP CORE
- S2   cluster = workspace + add/connect (C1/C2/C3) + namespace selector
- S3   generic resource-list panel (moi kind, columns/filter/sort) + sidebar category nav (Lens-style)
- S3b  detail drawer + YAML view/EDIT/apply + delete/scale/restart/rollback actions

OPERATIONS
- S6   Pod logs viewer (stream, multi-container, previous, tail)
- S7   Pod shell/exec terminal (reuse @jagentdesk terminal)
- S8   Port-forwarding manager (start/stop/list)
- S9   Node ops (cordon/drain/uncordon) + node detail + shell-to-node
- S10  Metrics (overview charts + per-pod/node CPU/mem)

RESOURCE COVERAGE (columns + detail + actions per category, tren generic engine)
- S11  Workloads full (Pods/Deploy/DS/STS/RS/Jobs/CronJobs + scale/restart/trigger/suspend/rollback)
- S12  Config (ConfigMaps/Secrets/ResourceQuotas/LimitRanges/HPA/PDB/PriorityClasses/RuntimeClasses/Webhooks)
- S13  Network (Services/Endpoints/Ingresses/IngressClasses/NetworkPolicies)
- S14  Storage (PVC/PV/StorageClasses)
- S15  Namespaces (list/create/delete)
- S16  Events (global, filter)
- S17  RBAC (ServiceAccounts/Roles/ClusterRoles/bindings)
- S18  Custom Resources (CRD list + dynamic instances)

HELM
- S19  Helm releases (list/detail/values/history/upgrade/rollback/uninstall)
- S20  Helm charts (repos/browse/install)

AGENT (diem manh)
- S4   agent kubectl tool + permission (apply/scale/delete qua Deny/Accept)
- S21  agent diagnose flows (diagnose pod, explain YAML, propose fix)

MOBILE
- S5   mobile parity (list/detail/logs/shell/agent qua swipe panel + bottom sheet)

## E. Nguyen tac phu het (chong "lam mot phan bao xong")
- Generic engine phu MOI kind qua discovery — khong hardcode danh sach.
- Moi story nghiem thu bang hanh vi quan sat duoc tren cluster THAT read-only (write = dry-run).
- verify-k8s-e2e.sh mo rong: moi category co 1 buoc probe read that.
- Checklist A/B/C nay la hop dong "xong" — con o trong la CHUA xong.
