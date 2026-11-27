# JAgentDesk docs

Docs for people working on JAgentDesk. User-facing guides live in [`public-docs/`](../public-docs/index.md);
release notes live in [`releases/`](releases/v0.11.1.md).

## Product

- [product.md](product.md) — what JAgentDesk is, who it is for, what ships in this version.
- [glossary.md](glossary.md) — the terms to use; the UI label wins.
- [releases/v0.11.1.md](releases/v0.11.1.md) — release notes for v0.11.1.
- [releases/v0.11.0.md](releases/v0.11.0.md) — release notes for v0.11.0.
- [releases/v0.10.1.md](releases/v0.10.1.md) — release notes for v0.10.1.
- [releases/v0.10.0.md](releases/v0.10.0.md) — release notes for v0.10.0.

## Architecture

- [architecture.md](architecture.md) — packages, daemon, clients, WebSocket API and data flow.
- [data-model.md](data-model.md) — files under `$JAGENTDESK_HOME`, schemas, atomic writes, config keys.
- [agent-lifecycle.md](agent-lifecycle.md) — agent states, parents and children, archive, idle release, background work.
- [orchestration.md](orchestration.md) — Supervisor → Lead → Peer (ORC).
- [cross-provider-continuity.md](cross-provider-continuity.md) — session ledger, provider switches, usage-limit failover, children on other providers.
- [durable-context.md](durable-context.md) — compaction signals, re-grounding after compaction, recitation, ledger nudge, rollover, capture lessons.
- [bots.md](bots.md) — Bots: daemon lifecycle, storage, permissions, triggers, Slack.
- [timeline-sync.md](timeline-sync.md) — how chat reaches clients and the replica cache.
- [terminal-worker.md](terminal-worker.md) — the persistent terminal worker.
- [terminal-performance.md](terminal-performance.md) — terminal latency, coalescing and backpressure.
- [terminal-activity.md](terminal-activity.md) — terminal activity indicators and hook providers.
- [agent-stream-performance.md](agent-stream-performance.md) — assistant text coalescing and paced reveal.
- [markdown-renderer.md](markdown-renderer.md) — the vendored Markdown engine fork, its layout and backports.
- [notifications.md](notifications.md) — OS notifications, startup readiness, deferred targets.

## Protocol and security

- [rpc-namespacing.md](rpc-namespacing.md) — naming for WebSocket RPCs.
- [protocol-compatibility.md](protocol-compatibility.md) — app/daemon version drift, feature gates, COMPAT tags.
- [protocol-validation.md](protocol-validation.md) — generated inbound validation and schema rules.
- [permissions.md](permissions.md) — daemon permissions, principals, pairing (SAS) and admission.
- [relay.md](relay.md) — the encrypted relay next to Tailscale.
- [connected-hosts.md](connected-hosts.md) — daemon-to-daemon pairing and routed agents.
- [service-proxy.md](service-proxy.md) — exposing workspace services at public URLs.
- [../SECURITY.md](../SECURITY.md) — threat model.

## Features

- [builtin-plugins.md](builtin-plugins.md) — the 18 built-in features in `plugins/<id>/`, switches and host APIs.
- [plugins.md](plugins.md) — local and bundled plugins: manifest, sources, RPCs, surfaces.
- [providers.md](providers.md) — adding an agent provider end to end.
- [custom-providers.md](custom-providers.md) — custom provider config, API providers, profiles, ACP agents.
- [forge-providers.md](forge-providers.md) — adding a git forge.
- [skills.md](skills.md) — the skills hub.
- [memory.md](memory.md) — the Memory built-in: storage, auto-inject and its threshold, tools, chip.
- [docker.md](docker.md) — running the daemon and web UI in Docker.
- [kubernetes.md](kubernetes.md) — the Clusters built-in.
- [databases.md](databases.md) — the Databases built-in.
- [ssh.md](ssh.md) — the SSH servers built-in.
- [remote-tasks.md](remote-tasks.md) — the Remote tasks built-in.
- [simulators.md](simulators.md) — the Devices & simulators built-in.
- [host-tools.md](host-tools.md) — host capabilities and the tool installer.
- [agentic-browser.md](agentic-browser.md) — the Agentic browser built-in.

## App UI

- [design.md](design.md) — design system: tokens, buttons, hierarchy, density, states.
- [themes.md](themes.md) — Gumloop and classic shells, sidebar and drawer.
- [unistyles.md](unistyles.md) — Unistyles rules and gotchas.
- [hover.md](hover.md) — the hover pattern.
- [menus.md](menus.md) — the menu engine.
- [drag-reorder.md](drag-reorder.md) — reorderable lists, the scroll view that hosts the drag, grips.
- [floating-panels.md](floating-panels.md) — anchored popovers.
- [forms.md](forms.md) — form architecture.
- [mobile-panels.md](mobile-panels.md) — compact panels, gestures and sheets.
- [expo-router.md](expo-router.md) — routes, startup restore, blank-screen gotchas.
- [file-icons.md](file-icons.md) — file explorer icons.
- [i18n.md](i18n.md) — translations.
- [coding-standards.md](coding-standards.md) — types, errors, state, React patterns.

## Development and testing

- [development.md](development.md) — dev servers, build order, CLI, debugging.
- [testing.md](testing.md) — how to write and run tests.
- [qa.md](qa.md) — the evidence bar for pull requests.
- [mobile-testing.md](mobile-testing.md) — Maestro and mobile test workflows.
- [ad-hoc-daemon-testing.md](ad-hoc-daemon-testing.md) — an isolated in-process daemon for tests.
- [browser-capture-harness.md](browser-capture-harness.md) — the Electron browser screenshot harness.
- [android.md](android.md) — app variants, builds, version codes, F-Droid.
