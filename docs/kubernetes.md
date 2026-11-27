# Kubernetes clusters

The Clusters screen is a resource browser plus a per-cluster agent chat, the same on desktop and
mobile. The daemon talks to the cluster with its own Kubernetes client, so the app needs no local
`kubectl`. It is the `clusters` [built-in](builtin-plugins.md) (on by default); Argo CD requires
it.

Browsing needs no project. Only the chat needs one, because the agent runs in a working directory.

Code: `plugins/clusters/` (screens, `cluster/*` handlers, Helm client, agent tools). The cluster
registry, Kubernetes client and DTOs stay in `packages/server/src/server/cluster/` because SSH
remote clusters and Argo CD use them.

## Connect a cluster

1. Open **Clusters** from the sidebar's Tools group.
2. The list shows every context in the daemon host's default kubeconfig (`KUBECONFIG`, or
   `~/.kube/config`). It is read each time the list loads.
3. Press **Connect** on a context. A green dot marks it connected and the row gains
   **Open workloads** and **Disconnect**. Errors show inline.

A cluster on a remote machine can be imported through an SSH server; see [SSH servers](ssh.md).

## Browse resources

**Open workloads** opens the cluster view. Desktop shows the kind navigation, the resource list and
the chat dock side by side. Mobile slides in the kind menu, and the chat opens from a floating
button.

The navigation opens on **Overview**: node, pod, deployment, service and namespace counts,
container restarts, a pod health bar and node readiness. Below it are the resource kinds
(workloads, config, network, storage and cluster kinds, including events) and **Helm → Releases**.

The resource table filters by namespace, searches, and sorts by name or age. On phones it drops
secondary columns and folds namespace and status into a subtitle.

## Inspect a resource

Tap a row to open its detail:

- **Overview**: a structured summary, with the resource's Kubernetes events. ConfigMap and Secret
  keys render as code blocks; secret values stay masked behind per-key **Show** / **Hide**.
- **YAML**: the live manifest, with **Edit YAML** → **Apply**.
- **Logs**: streamed logs with **Follow**, a container selector, timestamps, severity colouring
  and download of the on-screen buffer.
- **Shell**: an interactive `exec` terminal into a chosen container.
- **Port-forward**: forwards a Pod or Service port to localhost; a Service resolves to a backing
  pod.

Actions appear where they apply: **Scale** and **Restart** for Deployments, DaemonSets and
StatefulSets, **Rollback** for Deployments, **Trigger** / **Suspend** / **Resume** for CronJobs,
**Cordon** / **Uncordon** for Nodes, and **Delete**. The daemon picks the patch strategy per
operation, so scale and restart behave like `kubectl`.

Helm releases show values and history, with rollback and uninstall. They need `helm` on the daemon
host; Settings → host → Tools & prompts can install it ([Host tools](host-tools.md)).

## Ask AI

Every resource detail has **Ask AI**. It opens the cluster's chat and hands the agent the resource
you are viewing; with the logs pane open, the on-screen log buffer goes too.

Cluster agents carry the label `jagentdesk.cluster.id` and are told to use the cluster tools on the
`jagentdesk` MCP server:

| Tool            | Does                                                         |
| --------------- | ------------------------------------------------------------ |
| `kubectl_get`   | get, describe, logs and list on a connected cluster          |
| `kubectl_apply` | changes; agent-scoped, asks for your approval before it runs |
| `cluster_list`  | lists connected clusters and their ids                       |

Replies stream into the chat dock, including tool calls. The composer is the full agent composer.

## Chat history and project

The clock icon in the chat header opens history:

- **PROJECT FOR NEW CHATS** (shown with two or more projects) picks the working directory for new
  cluster chats. The choice is remembered across clusters.
- **New chat** starts a separate conversation. Empty chats are titled "Cluster chat", "Cluster chat
  2", and so on; chats started from **Ask AI** take their title from the first message.
- The list shows the cluster's non-archived chats. Tap one to switch to it.

One agent is reused per cluster, so opening workloads never spawns duplicates. **New chat** is the
way to branch.

The chat needs a configured provider and at least one project. Until then the dock shows "Connect a
host & add a project to chat with an agent".
