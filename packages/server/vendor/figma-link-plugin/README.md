# JAgentDesk Figma Link plugin

The Figma side of the Figma Link bridge (docs/spec/32-figma.md §32.4, ADR-0035).
The plugin dials into the JAgentDesk daemon's loopback WebSocket server
(`ws://localhost:1995/ws`) and executes tool calls in the Figma sandbox, so the
app can read live nodes, export pixels, and apply edits without the REST API.

Vendored from [figma-mcp-forge](https://github.com/gethopp/figma-mcp-forge)
(MIT — see `LICENSE.md`, `FORGE.md`, and `../THIRD_PARTY_NOTICES.md`), with the
React UI replaced by a plain-DOM pairing UI and a JAgentDesk pairing handshake
added on top of the Forge protocol v1.

## Layout

- `manifest.json` — Figma plugin manifest; `dist/` is the committed build.
- `src/main/code.ts` — sandbox: the Forge tool surface plus `get_nodes` (REST
  node format via `src/main/rest-serializer.ts`), document/status pushes, and
  pairing storage in `figma.clientStorage`.
- `src/ui/main.ts` — iframe UI: owns the WebSocket, speaks the bridge protocol
  (hello / pairing_required / pairing_granted / link_blocked / link_rejected),
  relays daemon requests to the sandbox and responses back.
- `src/plugin-version.ts` — must match `EXPECTED_PLUGIN_VERSION` in
  `packages/server/src/server/figma/link/protocol.ts`.
- `build.mjs` — esbuild bundle (the repo's own esbuild; no vite, no React).

## Build

```bash
npm run build        # or: node build.mjs  → dist/code.js + dist/index.html
```

Rebuild and commit `dist/` whenever `src/` changes — the daemon installs the
plugin by copying this directory (checksummed) to
`~/lib/node_modules/@hdc/jagentdesk-plugin-figma-link`.

## Import into Figma desktop

1. Start the JAgentDesk daemon (the bridge listens on 127.0.0.1:1995).
2. In Figma desktop: **Plugins → Development → Import plugin from manifest…**
   and select this directory's `manifest.json`.
3. Open a design file, run **Plugins → Development → JAgentDesk Figma Link**.
4. The window shows a six-digit pairing code; enter it in JAgentDesk
   (Figma connection → pair). The dot turns green when the daemon grants a key.
   The key lives in `figma.clientStorage`, so reconnects skip the prompt.

The plugin refuses to connect (and says so) when the port is taken by a
non-JAgentDesk server, a browser tab opens the socket (Origin), or the plugin
build doesn't match the daemon's expected version.
