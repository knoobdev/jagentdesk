# JAgentDesk

JAgentDesk is a self-hosted desktop and mobile application for controlling coding agents that
run on your own computer. The daemon manages the agent processes; desktop and mobile clients
connect to it through Tailscale and require application-level pairing before control is granted.

## Project boundaries

- Tailscale is the only remote transport. There is no hosted relay or public web-app endpoint.
- Pairing uses a QR code or pairing link followed by a six-digit device-signing step.
- The app can view files and diffs, but it does not edit files in place.
- Provider credentials remain with the local agent CLIs and are not collected by JAgentDesk.

## Workspace map

- `packages/server` — daemon, agent lifecycle, WebSocket API, MCP server, and Tailscale bridge
- `packages/app` — Expo client for iOS, Android, and web
- `packages/desktop` — Electron desktop application
- `packages/cli` — command-line client and daemon commands
- `packages/protocol` — shared protocol schemas and connection contracts
- `packages/website` — local documentation and build instructions

## Development

```bash
npm install
npm run dev:server
npm run dev:app
npm run dev:desktop
```

Build and validate the two application surfaces:

```bash
npm run build:desktop
npm run typecheck
cd packages/app && eas build --platform ios
```

The detailed local runbooks are in [`docs/`](docs/) and [`public-docs/`](public-docs/).

## License

AGPL-3.0
