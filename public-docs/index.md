---
title: Getting started
description: Install JAgentDesk and start running coding agents from anywhere.
nav: Getting started
order: 1
category: Getting started
---

# Getting started

JAgentDesk runs your coding agents on your machine and gives you a mobile, desktop, web, and CLI client to drive them from anywhere. Three common ways to install.

## Desktop app (recommended)

Build the desktop app locally with `npm run build:desktop`, then open the generated application.

The desktop app bundles its own daemon and starts it automatically, no separate install required. On first launch you'll see a brief startup screen, then connect from your phone using **Settings → your host → Pair Device**.

## Server / CLI

For headless machines, dev boxes, or any setup where you want the daemon running without the desktop UI:

```bash
npm install -g @jagentdesk/cli
jagentdesk
```

JAgentDesk starts the daemon locally. For mobile access, connect the machine and phone to the same
Tailscale network and complete the pairing plus six-digit signing flow.

The daemon can also serve the browser web app itself, so you can use the full UI without the hosted app. See [Self-hosting the web UI](/docs/web-ui).

Configuration and local state live under `JAGENTDESK_HOME` (defaults to `~/.jagentdesk`).

## Docker

For servers, dev boxes, NAS devices, or homelab hosts, run the official image:

```bash
docker run -d --name jagentdesk \
  -p 6767:6767 \
  -e JAGENTDESK_PASSWORD=change-me \
  -v "$PWD/jagentdesk-home:/home/jagentdesk" \
  -v "$PWD:/workspace" \
  jagentdesk:local
```

Then open `http://localhost:6767`.

The image runs the daemon and serves the bundled web UI. It does not bundle agent CLIs, so extend it with the agents you use. See [Docker](/docs/docker) for Compose, reverse proxy, agent install, and security examples.

## Where next

- [Docker](/docs/docker), run the daemon and bundled web UI in a container.
- [Workspaces](/docs/workspaces), the project, workspace, and session model JAgentDesk is built around.
- [Providers](/docs/providers), what a provider is and how JAgentDesk wraps existing CLIs.
- [Orchestration](/docs/orchestration), let one agent delegate work to other providers and models.
- [CLI reference](/docs/cli), every command.
- [Self-hosting the web UI](/docs/web-ui), serve the browser app from your own daemon.

## Prerequisites

JAgentDesk manages other agents, it doesn't ship one. Before it's useful, install at least one provider CLI yourself and make sure it works with your credentials. See [Supported providers](/docs/supported-providers) for the full list.

Forge integrations are optional. Install and authenticate the CLI for the forge you use if you
want PR/MR-aware worktrees and review features.
