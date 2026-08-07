## ADDED Requirements

### Requirement: Daemon serves the WebSocket endpoint on the tailnet
The daemon MUST accept application WebSocket connections on the `/ws` path over its Tailscale (tsnet) listener, using the same in-process WebSocket server that already handles loopback connections (jagentdesk websocket-server.ts:762 `wss.on("connection", ...)`, jagentdesk daemon-endpoints.ts:169 `buildDaemonWebSocketUrl` → `/ws`).

#### Scenario: Client reaches /ws over the tailnet
- **WHEN** a paired client on the same tailnet opens a WebSocket to `ws://<daemon-tailnet-host>:6768/ws`
- **THEN** the daemon accepts the upgrade and drives it through the same `attachSocket` path used for local connections, and no relay endpoint is contacted

#### Scenario: Non-/ws paths are not upgraded as application sockets
- **WHEN** a WebSocket upgrade requests a path other than `/ws`
- **THEN** the daemon does not attach it as an application session

### Requirement: Client dials the daemon tailnet address directly
The client MUST construct its transport URL from the daemon's tailnet host and port via `buildDaemonWebSocketUrl(endpoint, { useTls })` and connect directly, and MUST NOT perform a relay outbound dial or attach a relay-role query (jagentdesk daemon-client.ts:1256-1262, jagentdesk daemon-endpoints.ts:169-174).

#### Scenario: Direct dial URL shape
- **WHEN** the client connects to a daemon whose endpoint is `<daemon-tailnet-host>:6768`
- **THEN** the transport URL is `ws://<daemon-tailnet-host>:6768/ws` with no `serverId`, `role`, or `connectionId` query parameters (contrast jagentdesk daemon-endpoints.ts:176-199 `buildRelayWebSocketUrl`)

#### Scenario: Loopback dial for desktop-local remains available
- **WHEN** the desktop app connects to a co-located daemon at the default `127.0.0.1:6768`
- **THEN** the client dials `ws://localhost:6768/ws` directly with no tailnet or relay hop

### Requirement: The attachSocket(ws, ExternalSocketMetadata) contract is preserved
The tsnet transport MUST hand accepted sockets to the daemon through the existing `attachExternalSocket(ws, metadata?: ExternalSocketMetadata)` entry point, preserving the `RelaySocketLike`/`WebSocketLike` shape (`readyState`, `bufferedAmount`, `send`, `close`, `terminate`, `on`, `once`) (jagentdesk websocket-server.ts:902-910, jagentdesk relay-transport.ts:28-36).

#### Scenario: Metadata transport tag reflects tailnet
- **WHEN** a socket is attached from the tsnet listener
- **THEN** it is passed to `attachExternalSocket` with metadata whose `transport` value identifies the tailnet transport (replacing the `"relay"` tag counted at jagentdesk websocket-server.ts:906-908)

#### Scenario: Socket object satisfies the required surface
- **WHEN** the daemon receives a socket from the tsnet transport
- **THEN** the object exposes `readyState`, `send`, `close`, `terminate`, `on`, and `once` so the daemon's send/backpressure/close logic operates unchanged

### Requirement: Relay outbound-dial and E2EE box are removed
The daemon MUST NOT start the relay transport (jagentdesk relay-transport.ts:109 `startRelayTransport`) nor wrap sockets in the relay end-to-end encrypted channel (jagentdesk relay-transport.ts:416 `attachEncryptedSocket`, jagentdesk encrypted-channel.ts), because WireGuard already provides transport encryption; the relay control-protocol (`sync`/`connected`/`disconnected`) MUST NOT be used.

#### Scenario: No relay runtime is constructed
- **WHEN** the daemon boots (replacing jagentdesk bootstrap.ts:1568-1583 `createRelayRuntime`)
- **THEN** it starts only the tsnet listener plus the loopback listener and never opens an outbound relay WebSocket

#### Scenario: No application-layer E2EE handshake
- **WHEN** a client connects over the tailnet
- **THEN** no `e2ee_hello`/`e2ee_ready` exchange occurs and frames are sent as plaintext WebSocket frames inside the WireGuard tunnel

### Requirement: Hello / server_info handshake is preserved
The daemon MUST retain the application `hello` → `server_info` handshake: it validates `protocolVersion` against `WS_PROTOCOL_VERSION` and a non-empty `clientId`, then replies with a `server_info` message carrying `serverId`, `hostname`, and `version` (jagentdesk websocket-server.ts:1401-1504, buildServerInfoStatusPayload jagentdesk websocket-server.ts:1506-1511).

#### Scenario: Protocol version mismatch is rejected
- **WHEN** a client sends a `hello` whose `protocolVersion` differs from the daemon's `WS_PROTOCOL_VERSION`
- **THEN** the daemon closes the socket with code `4003` and reason `"Incompatible protocol version"` (jagentdesk websocket-server.ts:1418)

#### Scenario: Empty clientId is rejected
- **WHEN** a client sends a `hello` with an empty `clientId`
- **THEN** the daemon closes the socket with code `4002` and reason `"Invalid hello"` (jagentdesk websocket-server.ts:1430)

#### Scenario: Valid hello receives server_info
- **WHEN** a client sends a valid `hello`
- **THEN** the daemon registers the session and sends a `server_info` message containing `serverId`, `hostname`, and `version` (jagentdesk websocket-server.ts:1470, 1495)

### Requirement: Liveness ping and application-socket lease force-terminate stale sockets
The daemon MUST bound abandoned sockets with the existing application-socket lease: current clients ping every 10 seconds, the lease is `APPLICATION_SOCKET_LEASE_MS = 45_000` ms, and the daemon sweeps expired leases every `APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS = 10_000` ms and force-terminates via `terminate()` (jagentdesk physical-socket.ts:5-8, jagentdesk websocket-server.ts:778-789, 1140-1144).

#### Scenario: Expired lease force-terminates the socket
- **WHEN** a socket's application lease deadline passes without renewal
- **THEN** the sweep (running every 10_000 ms) closes it via `terminate()` rather than a queued close frame

#### Scenario: Renewed lease keeps the socket alive
- **WHEN** a client's periodic ping renews the lease before the 45_000 ms deadline
- **THEN** the socket is not terminated

### Requirement: Outbound high-water backstop bounds buffered bytes
The daemon MUST cap per-socket buffered outbound bytes at `MAX_PHYSICAL_SOCKET_BUFFERED_BYTES = 64 * 1024 * 1024` (64 MiB) and terminate a socket that exceeds it (jagentdesk physical-socket.ts:4, jagentdesk websocket-server.ts:1115-1123 `closeAtOutboundHighWater`).

#### Scenario: Backpressure overflow terminates the socket
- **WHEN** a socket's `bufferedAmount` plus the next frame would exceed `64 * 1024 * 1024` bytes
- **THEN** the daemon invokes the high-water handler and terminates the physical socket (jagentdesk physical-socket.ts:89-95)

#### Scenario: Frames within budget are sent
- **WHEN** a frame fits within the remaining 64 MiB budget
- **THEN** the daemon sends it without terminating the socket
