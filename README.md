# JAgentDesk

**Self-hosted remote control for your coding agents — now with a built-in Kubernetes cockpit.**

JAgentDesk lets you run AI coding agents (Claude Code, Codex, and more) on your own
machine and drive them from anywhere. A lightweight **daemon** runs on your workstation and
manages agent processes; **desktop** (macOS / Windows / Linux) and **mobile** (iOS / Android)
apps connect straight to it over **Tailscale** — no relay server, no data leaving your
tailnet. Every device completes an application‑level **pairing** (offer link / QR + a 6‑digit
code) before it can control the daemon.

> **📦 [Download the latest release →](https://github.com/knoobdev/jagentdesk/releases/latest)**

JAgentDesk is a rebranded, independently‑developed fork of [Paseo](https://github.com/getpaseo/paseo)
with a few deliberate boundaries:

- **No in‑app editor.** You can view files, diffs, and logs — but you edit through the agent, not a text editor.
- **Tailscale is the only remote transport.** No JAgentDesk relay.
- **Application‑level pairing** with an offer link / QR and a 6‑digit verification code.
- **Multi‑agent orchestration** (Supervisor → Lead → Peer) and agent‑to‑agent messaging.

---

## What can it do?

- **Run & steer agents remotely** — start agents, send prompts, watch streamed output and tool
  calls, interrupt runs, review file diffs, all from desktop or phone.
- **Multiple providers** — Claude Code and other CLI agents, each with model / thinking /
  permission controls in the composer.
- **Agent orchestration** — a Supervisor/Lead/Peer runtime; agents can `list_agents`,
  `send_agent_prompt`, and `create_agent` to coordinate work across the daemon.
- **Kubernetes cluster management** — a full Kubernetes cockpit built into the app.
- **Per‑cluster AI chat** — ask an agent about any resource or its logs; the agent uses
  real `kubectl` tools scoped to the exact cluster you connected.
- **Databases** _(new)_ — a full database IDE built into the app: seven engines (PostgreSQL,
  MySQL, SQLite, SQL Server, Oracle, MongoDB, ClickHouse), multiple databases per connection, an
  object explorer with counts, a data grid with inline editing, a SQL console with autocomplete and
  query plans, ER diagram, and an AI chat with SQL tools — credentials never leave the daemon.
- **Skills** _(new)_ — reusable expertise agents **use** (attach many from the composer) and
  **learn** from real conversations; auto‑loaded by message, no hand‑typed corrections.
- **Plugins** _(new)_ — extend the app with local, trusted code: surfaces, sidebar items,
  workspace panels, command‑center items, attachment sources, and themes (off by default).
- **Active‑turn steering** _(new)_ — send a message into a running turn without cancelling it.
- **Agentic browser** _(new)_ — the agent drives a real built‑in browser (open tabs, click,
  evaluate) with optional **stealth** (fingerprint/webdriver normalisation) and a **session vault**
  for your own logins.
- **Usage & cost insights** _(new)_ — a dashboard of tokens, spend, and per‑model / per‑agent
  breakdowns.
- **Multi‑language UI** _(new)_ — switch the app language from Settings.

---

## ✨ New in this release

### Databases — a full database IDE (desktop **and** mobile)

Open **Databases** from the sidebar to work with your data from inside JAgentDesk:

- **Seven engines** — PostgreSQL, MySQL, SQLite, SQL Server, Oracle, MongoDB, ClickHouse — behind
  one provider‑agnostic contract; credentials never leave the daemon.
- **Multiple databases per connection** — list and switch databases on a server, with a
  an IDE‑style tree (schemas, tables, columns, indexes, foreign keys, views, sequences, routines)
  showing per‑node counts, plus **cross‑database compare** (structure + data).
- **Data grid** — inline editing, `WHERE` filter, column sort, two‑axis scroll, clone row, CSV
  import, export to CSV/JSON/SQL, aggregate view, record view, and transaction isolation levels.
- **SQL console** — schema‑aware autocomplete, inspections, multiple result tabs, `EXPLAIN` / query
  plan, and query history — with **foreign‑key navigation** and **full‑text search**.
- **ER diagram**, **DDL view**, **schema diff**, and an **AI chat** with SQL tools grounded on the
  live schema.

See [CHANGELOG.md](CHANGELOG.md) for the full v0.0.4 notes.

### Kubernetes cluster management (desktop **and** mobile)

Open **Clusters** from the sidebar to manage Kubernetes from inside JAgentDesk:

- **Connect any context** from `~/.kube/config` (docker‑desktop, GKE, EKS, …) — browsing needs
  no project; just connect and explore.
- **Browse every resource type** — Namespaces, Nodes, Events, Pods, Deployments, DaemonSets,
  StatefulSets, ReplicaSets, Jobs, CronJobs, ConfigMaps, Secrets, Services, Ingress, and more,
  with a searchable, sortable, responsive table (compact columns on phones).
- **Cluster Overview dashboard** — the kind menu opens on a KPI dashboard (Nodes, Pods,
  Deployments, Services, Namespaces, restarts), a pod‑health bar, and a node‑readiness list.
- **Rich resource detail** — a structured resource overview plus raw **YAML**, live **logs**
  (follow + container selector, **timestamps** toggle, severity colouring, **download**), an
  interactive **shell** (exec), **port‑forward** (Pods **and** Services), and **Events** filtered
  to the resource. ConfigMap / Secret values render as scrollable code blocks, with secrets masked
  behind a per‑key **Show / Hide**.
- **Actions** — Scale, Restart, Rollback (Deployments), Edit YAML / Apply, and Delete — with the
  correct Kubernetes patch strategies under the hood.
- Works identically on the **Electron desktop app** and the **iOS/Android app**.

### Ask AI about your cluster

- An **Ask AI** button on every resource hands the agent the exact resource — and, when the logs
  pane is open, the on‑screen log buffer — so _“what’s wrong in this log?”_ just works.
- The agent is wired to **cluster‑scoped `kubectl` tools** (`kubectl_get` for get/describe/logs/list,
  `kubectl_apply` for changes) that target the exact cluster you connected, even if it isn’t in a
  local kubeconfig.
- Replies stream live (assistant text **and** tool calls) in a chat dock that sits beside the
  resource view — a right‑hand side panel on desktop, a floating chat button on phones.

### Cluster chat history, new chats & project picker

- **History** — every conversation for a cluster, with titles and timestamps; tap to switch back
  to any past chat and its full transcript.
- **New chat** — start a fresh conversation; empty chats get distinct titles (no more duplicate
  “Untitled chat”).
- **Project picker** — choose which project/workspace a cluster chat runs in (the agent’s working
  directory), instead of it silently picking one for you. The picker appears when you have more
  than one project.

For a full walkthrough see **[docs/kubernetes.md](docs/kubernetes.md)**.

### Skills — reusable expertise your agents use and learn

Open **Skills** from the sidebar to build reusable expertise that **agents use** (many at once)
and **learn** from real conversations — not throwaway one‑off agents:

- **Create / edit / delete** a skill with an icon, name, description, an instruction prompt, and
  comma‑separated tags.
- **Attach from the composer** — a **Skills** picker in the composer lets you attach **one or more**
  skills to the current agent; their instructions are injected so the agent actually uses them.
  **Auto‑load** (on by default) matches relevant skills to your message automatically.
- **Learn from the conversation** — no hand‑typed corrections. 👍 a real assistant reply and the
  skill captures that answer as knowledge (+XP); the agent can also **propose a lesson** after a
  turn for you to approve or reject.
- **Level up** — skills earn XP as they learn, running Novice → Expert with an XP bar and a
  **graduation checklist**.
- Available on **desktop and mobile**.

### Plugins — extend the app with local, trusted code

Install local plugins that contribute surfaces, sidebar items, workspace panels, command‑center
items, attachment sources, and themes:

- **Local‑disk only** — `jagentdesk plugin install <dir>`; no marketplace, no network install.
- **Compiled + run on the daemon** — an esbuild pipeline splits client/server code; each plugin
  runs in its own subprocess and reaches the daemon over an internal session.
- **Trusted, off by default** — plugins run unsandboxed with a full daemon session, so
  `pluginsEnabled` defaults to **false**; a reserved `plugin:<id>` identity keeps a tailnet node
  from ever impersonating a plugin. Manage them under **Settings → Plugins** (list / install /
  enable / disable / remove / logs).

### Active‑turn steering

Send a message **into a running turn** without cancelling it. **Settings → Default send** offers
**Steer** (inject into the live turn, falling back to interrupt), **Interrupt**, or **Queue**.

### Agentic browser (desktop)

The agent drives a real Chromium `<webview>` over CDP — no external Playwright to wire up:

- **Cockpit UI** matching the design mock: a live step timeline of `browser_*` actions, an
  “agent driving” badge, and element highlights when the agent clicks.
- **Stealth** _(opt‑in)_ normalises the classic automation tells (`navigator.webdriver`,
  languages/plugins, WebGL vendor, hardware) before any page script runs — for legitimate
  automation of **your own** accounts.
- **Session vault** _(opt‑in)_ captures/restores a domain’s logged‑in cookies, encrypted at rest
  with the OS keychain (`safeStorage`).

### Usage & cost insights

Open **Usage & Cost** for a dashboard of token usage and spend — totals plus per‑model and
per‑agent breakdowns. Empty accounts show the full layout with zeroed metrics rather than a blank
“no data” page.

### Multi‑language UI

The app UI can be switched between languages from **Settings**; strings are fully externalised so
new locales drop in without code changes.

### More polish

- **Mermaid diagrams in chat** — fenced ` ```mermaid ` blocks render as live diagrams inline.
- **Pure‑black theme** — an OLED‑friendly true‑black dark theme in **Settings → Appearance**.
- **MiniMax Code provider** — added to the agent provider catalog (icon + model controls).
- **Nix syntax highlighting** — `.nix` files and fenced Nix code now highlight correctly.
- **Distinct titles everywhere** — new agents, orchestration workspaces, and cluster chats get a
  numeric suffix instead of colliding on the same name.

---

## Quick start

Requires **Node.js 22.20.0** and npm. The repo ships a `.tool-versions` file (use
[mise](https://mise.jdx.dev/) to install the exact toolchain). Local Android builds need the
Android SDK; local iOS builds need Xcode.

```bash
git clone https://github.com/knoobdev/jagentdesk.git
cd jagentdesk
npm install
```

Run the daemon, the mobile/web client, and the desktop app in separate terminals:

```bash
npm run dev:server    # the daemon
npm run dev:app       # Expo client (iOS / Android / web)
npm run dev:desktop   # Electron desktop app
```

Or just grab a prebuilt app from the **[latest release](https://github.com/knoobdev/jagentdesk/releases/latest)**
(macOS Apple Silicon / Intel, Windows x64, Linux x64, Android APK, iOS IPA).

> **macOS:** on Apple Silicon, download the **macOS‑Apple‑Silicon** asset. Do not install the
> Intel x64 asset on Apple Silicon — it runs under Rosetta and is intentionally rejected by the app.

---

## Using the Kubernetes features

1. **Connect a cluster.** Sidebar → **Clusters** → pick a context → **Connect** (green dot = connected).
2. **Browse.** Press **Open workloads**. On desktop you get a three‑column layout (kind nav ·
   resource list · chat dock); on phones the kind menu slides in — tap a kind (e.g. **Pod**).
3. **Inspect a resource.** Tap a row for the detail view: overview, YAML, Logs, Shell,
   Port‑forward, Events, and actions.
4. **Ask AI.** Tap **Ask AI** (or the chat button / side panel) — the agent receives the resource
   (and open logs) as context and answers with live `kubectl` output. First set up a provider
   (**Setup providers**) and add at least one project so the chat has a working directory.
5. **Switch / start chats.** Open the **history** (clock icon) in the chat header to see past
   conversations, start a **New chat**, or pick the **project** new chats run in.

---

## Repository layout

- `packages/server` — the daemon: agent lifecycle, WebSocket API, Kubernetes client, and the
  Tailscale bridge.
- `packages/app` — the Expo client for iOS, Android, and web.
- `packages/desktop` — the Electron app for macOS, Windows, and Linux.
- `packages/client` & `packages/protocol` — the shared client and the wire‑protocol contract.
- `packages/cli` — a CLI to control the daemon (`jagentdesk daemon start|stop|restart|status`).
- `docs/` — architecture, data model, development, and feature guides (including
  [Kubernetes](docs/kubernetes.md)).

See [docs/architecture.md](docs/architecture.md) and [docs/development.md](docs/development.md) to
go deeper.

---

## Building releases

`.github/workflows/release.yml` runs on every semver tag push (`v*.*.*`) and on manual dispatch.
It builds the desktop apps (macOS / Windows / Linux), an Android APK, and an unsigned iOS IPA,
then attaches them to the matching GitHub Release. To cut a release:

```bash
# bump every package.json to the target version first, then:
git tag v0.0.1
git push origin main --tags
```

---

## Contributing

Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

**Contributors**

- **[knoobdev](https://github.com/knoobdev)** — maintainer.
- **Claude** (Anthropic) — feature development & engineering.
- **DeepSeek** — engineering support.

---

## Acknowledgements

Huge thanks to **[Paseo](https://github.com/getpaseo/paseo)** and its contributors — JAgentDesk is
forked from Paseo, and that foundation is what let this project get off the ground so quickly.

## License

JAgentDesk is released under **AGPL‑3.0‑or‑later**. See [LICENSE](LICENSE).
