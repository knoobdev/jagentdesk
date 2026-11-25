# Product

What JAgentDesk is, who it's for, and where it's going.

## What is JAgentDesk

JAgentDesk is a next-generation development environment built around agents. One interface to run, monitor, and interact with coding agents across desktop, mobile, terminal, and web.

The development workflow is shifting from manually editing files to orchestrating agents that do the editing. JAgentDesk is built for that workflow.

## Core philosophy

Freedom and flexibility. Every design decision follows from this:

- **Multi-provider** — Use any coding agent harness. Pick the right model for each job, switch freely as the landscape shifts. No vendor-lock in.
- **Cross-device** — Desktop, mobile, web, CLI. Start work at your desk, check progress from your phone, script from the terminal.
- **Self-hosted** — The daemon runs on your machine. Your code, your keys, your environment. No inference markup, no cloud dependency.
- **Respectful** - No telemetry, no forced cloud, no forced accounts
- **Open source** — AGPL-3.0. Users can inspect, fork, and contribute.
- **BYOK** — Bring your own keys. Use your subsidized plans and first-party provider pricing. JAgentDesk adds zero cost on top.

## How it works

### Projects and workspaces

Projects are grouped in the sidebar, detected automatically from your filesystem and tagged by git remote when available.

Each project opens as a workspace. For git projects, the default workspace is the main checkout. Users can create additional workspaces, which are isolated copies (git worktrees) where agents work without affecting main.

### Inside a workspace

A workspace is a flexible canvas:

- Launch multiple agents side by side in split panes
- Open terminals alongside agents
- Mix and match providers within the same workspace

### The daemon

JAgentDesk is a client-server system. The daemon (Node.js) runs on your machine, manages agent processes, and streams output in real time over WebSocket. Clients connect to the daemon — locally or remotely.

This architecture means:

- The daemon can run on any machine: laptop, VM, remote server
- Multiple clients can connect simultaneously
- Agents keep running when a client disconnects — the daemon owns them, not the client
- Quitting the desktop app stops the daemon it started, so "restart the app" is a real fix; a daemon you run yourself is unaffected

## Target user

Anyone who builds software:

- Care about owning their tools and their data
- Use multiple AI providers and want to switch freely
- Run agents on real tasks across real projects
- Want to work from multiple devices

## What compounds over time

- **Trust** — Showing up daily, shipping in public, being open source. Earned slowly, lost quickly.
- **Community contributions** — Code, packaging, skills, agent configs. Contributors become advocates.
- **Ecosystem** — Skills, integrations, shared configs. Community-built content that makes the platform more valuable.

## Strategic bets

1. **Models commoditize.** Value moves to the orchestration layer. The best model changes monthly — the workflow layer stays.
2. **Multi-provider wins.** No single provider stays on top. Developers want the best model for each task.
3. **The daemon as infrastructure.** Server/client architecture enables deployment anywhere.
4. **Open source outlasts funding.** Open source communities are resilient. Contributors become advocates.

## Current state (v0.10.0)

- Desktop (Electron), mobile (iOS/Android, Expo 57 / React Native 0.86), web, CLI
- Built-in providers: Claude Code (Agent SDK), Codex (app-server), GitHub Copilot (ACP), OpenCode, Pi, OMP. More ship as bundled provider plugins, plus a one-click ACP catalog and custom ACP or API providers ([providers.md](providers.md), [custom-providers.md](custom-providers.md))
- Gumloop look: one desktop sidebar, a drawer on phones, and Settings grouped into tiles on phones ([themes.md](themes.md))
- Features are built-in plugins that each host turns on or off under Settings → host → Plugins: Docker, Kubernetes, Databases, Argo CD, SSH servers, Remote tasks, Custom API providers, Jira, Forge Hub, Devices & simulators, Workbench, Skills, Spec mode, Insights, and Bots. Autonomous run, Session sharing and Agentic browser start off ([builtin-plugins.md](builtin-plugins.md))
- Remote access over the embedded Tailscale listener or the end-to-end encrypted relay ([relay.md](relay.md)). New devices pair by comparing a six-digit code on both screens ([permissions.md](permissions.md#device-pairing))
- Connected hosts: a daemon can pair with another daemon and run agents there ([connected-hosts.md](connected-hosts.md))
- Bots: long-lived assistants that delegate work and review results, including from Slack ([bots.md](bots.md))
- Usage shows per-account quotas from usage-source plugins; Insights shows usage history and costs
- Idle agent runtimes are released after an hour and resume on demand; agent-to-agent messages queue by default ([agent-lifecycle.md](agent-lifecycle.md))
- Terminals survive daemon restarts and replay their history on reattach ([terminal-worker.md](terminal-worker.md))
- Voice mode: dictate prompts or talk through problems hands-free
- MCP server exposes the daemon to other agents (hosts, workspaces, agents, schedules, heartbeats, terminals)
- Scheduled agents (cron-style triggers) via app, CLI, and MCP
- Key UX: split panes, keybinding customization, workspace model, in-app browser
