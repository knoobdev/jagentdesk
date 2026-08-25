# Kubernetes cluster management

JAgentDesk ships a Kubernetes cockpit — a k8s‑Lens‑style resource browser plus a per‑cluster AI
chat — that runs identically on the **Electron desktop app** and the **iOS/Android app**. It talks
to your clusters through the daemon's Kubernetes client, so the app never needs a local `kubectl`
and the agent can operate a cluster that isn't in any local kubeconfig.

> Browsing a cluster requires **no project**. Only the AI chat needs a working directory (a
> project), because the agent runs there.

---

## 1. Connect a cluster

1. Open **Clusters** from the left sidebar.
2. JAgentDesk lists every context from the daemon host's `~/.kube/config`
   (docker‑desktop, GKE, EKS, …).
3. Press **Connect** on a context. A green dot marks it connected, and the row gains
   **Open workloads · Ask an agent · Disconnect**.

Connection errors are surfaced inline; a failed context shows **Retry**.

---

## 2. Browse resources

Press **Open workloads** to enter the cluster view.

- **Desktop** shows three columns: the resource‑kind navigation, the resource list, and the chat
  dock (a right‑hand side panel).
- **Mobile** slides in the kind menu; tapping a kind opens its list, and the chat is a floating
  button.

Supported kinds include **Namespace, Node, Event, Pod, Deployment, DaemonSet, StatefulSet,
ReplicaSet, ReplicationController, Job, CronJob, ConfigMap, Secret, ResourceQuota, LimitRange,
HorizontalPodAutoscaler, PodDisruptionBudget, PriorityClass, RuntimeClass, Service, Endpoints,
Ingress, IngressClass, NetworkPolicy**, and the common storage kinds.

The resource table is **searchable and sortable** (by name / age) and **responsive** — on phones it
drops secondary columns and folds namespace + status into a subtitle so the search box and AGE
stay visible.

---

## 3. Inspect a resource

Tap a row to open the detail view:

- **Overview** — a structured, k8s‑Lens‑style summary (namespace, node, IPs, QoS, containers,
  conditions, labels, …).
- **YAML** — the live manifest, with **Edit YAML → Apply** for changes.
- **Logs** — streamed logs with **Follow** and a **container selector**.
- **Shell** — an interactive `exec` terminal into a chosen container.
- **Port‑forward** — forward a pod port to localhost.
- **Events** — Kubernetes Events filtered to the resource.

Workload actions appear where they apply: **Scale** and **Restart** (Deployments, DaemonSets,
StatefulSets), **Rollback** (Deployments), and **Delete**. The daemon applies the correct patch
strategy for each (JSON / merge / strategic‑merge / server‑side apply) so scale and restart behave
like `kubectl`.

---

## 4. Ask AI about a resource

Every resource detail has an **Ask AI** button (a sparkle pill in the header).

- It opens the cluster's chat and hands the agent the exact resource you're viewing. If the **logs**
  pane is open, the on‑screen log buffer is attached too, so *“what's in this log?”* has context.
- The agent is instructed to prefer the daemon's **cluster‑scoped tools**, which are exposed over
  the `jagentdesk` MCP server:
  - `mcp__jagentdesk__kubectl_get` — `get` / `describe` / `logs` / `list`, bound to the connected
    `clusterId`.
  - `mcp__jagentdesk__kubectl_apply` — changes, bound to the same `clusterId`.
  - `mcp__jagentdesk__cluster_list` — enumerate connected clusters.
- Replies stream live — assistant text **and** tool calls (e.g. *Kubectl Get*) — in the chat dock.

The chat composer is the full agent composer (model / thinking / permission / `@files` /
`/commands`), so you can keep the conversation going after the first answer.

---

## 5. Chat dock: history, new chats, and the project picker

Open the **history** (clock icon) in the chat header:

- **PROJECT FOR NEW CHATS** *(shown when you have 2+ projects)* — pick which project/workspace new
  cluster chats run in. This is the agent's working directory; the choice is remembered across
  clusters. With a single project the picker is hidden and that project is used.
- **New chat** — start a fresh conversation. Empty chats get distinct titles (*Cluster chat*,
  *Cluster chat 2*, …); chats started from **Ask AI** are titled from their first message.
- **Chat list** — every non‑archived conversation for the cluster with its title and relative time.
  Tap one to switch back to it and its full transcript.

One agent is reused per cluster by default (so opening workloads never spawns duplicate agents);
**New chat** is how you deliberately branch into a separate conversation.

---

## Notes & limitations

- The AI chat needs a **provider** (set up under **Setup providers**) and at least one **project**
  so the agent has a working directory; until then the dock shows *“Connect a host & add a project
  to chat with an agent.”*
- The daemon reads `~/.kube/config` on start; if you connect a cluster right after (re)starting the
  daemon and the list looks empty, give it a moment or reopen **Clusters**.
- Agent‑to‑agent tools (`list_agents`, `send_agent_prompt`, `create_agent`) operate on the whole
  daemon; `list_agents` defaults to the caller's project directory but can look wider — see
  [docs/architecture.md](architecture.md) and [docs/agent-lifecycle.md](agent-lifecycle.md).
