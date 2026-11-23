# Relay

The hosted endpoint is `wss://desk-relay.jagents.workers.dev`. The relay runs
alongside the embedded Tailscale listener, so a daemon can accept either path.
The Worker forwards encrypted frames; it has no daemon or device private keys.

## Configuration

Relay is enabled by default. Set `daemon.relay.enabled`, `daemon.relay.endpoint`,
and `daemon.relay.useTls` in `$JAGENTDESK_HOME/config.json`. Endpoints are bare
hostnames or `host:port`; a bare hostname uses port 443. TLS defaults to true.
`JAGENTDESK_RELAY_ENABLED`, `JAGENTDESK_RELAY_ENDPOINT`, and
`JAGENTDESK_RELAY_USE_TLS` override persisted values at startup.

Change `relay.enabled` through the daemon config RPC to start or stop the relay
without restarting the daemon. An explicit enabled override from the environment
or a launch flag pins that setting for the run. Endpoint and TLS changes take
effect at the next daemon launch.

## Trust boundaries

Keep `daemon-keypair.json` private (0600) and preserve it with `server-id` when
moving daemon state. It contains the X25519 Noise key and a separate Ed25519 relay
ownership key. The ownership key is generated on first relay enable. The Worker
binds `serverId` to that key on first registration; losing it requires a new
server identity unless you still have the old key to authorize a reset. Before replacing that
key, run `jagentdesk relay reset --home <old-home>`. The command reads the
existing `server-id` and ownership key without generating new ones. The Worker
clears its pin only after the current pinned key signs a fresh challenge; a
missing or different key cannot reset ownership. Keep the old home until the
command succeeds. The Worker reset endpoint must be deployed before using the
command.

Ownership authentication runs before routing on both daemon control and data
sockets. Noise authenticates the daemon to the client. Inside Noise, the client
still completes device pairing and signs the daemon challenge. Revoke closes
that device's connections across relay, tailnet, and direct transports. Admission
is removed immediately; a stalled close is forcibly terminated after five seconds.

Pairing offers include the relay route when enabled and can be issued with
Tailscale offline. Authenticated `server_info` also advertises the relay route
and Noise public key for hosts paired earlier. The client SDK requires explicit
E2EE configuration for relay URLs and keeps credentials inside the encrypted
session rather than the WebSocket upgrade.

## App connections

Pairing saves every route in the offer, including relay-only offers. Relay uses
the same trusted device identity as Tailscale; browser clients persist a
non-exportable signing key in IndexedDB. Clearing browser site data removes that
identity and requires pairing again.

Connections are tried in order: your preferred route, the last successful route,
local socket or pipe, direct TCP, Tailscale, then relay. A dropped route gets one
15-second reconnect attempt before the next route is tried. A live route is kept
until it fails or you choose **Use this connection** in host Connections settings.
Authenticated daemon metadata adds relay to hosts paired before relay existed.

## Local verification

Build relay and client declarations before building the server. Build the server
supervisor scripts too when booting a separate process: they carry their own
compiled configuration reader. Use an isolated `JAGENTDESK_HOME` and an OS-assigned
loopback port; never borrow the production daemon's port or state.
