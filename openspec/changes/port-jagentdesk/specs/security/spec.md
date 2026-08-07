## ADDED Requirements

### Requirement: Threat model is addressed by layered defenses
The system MUST defend against an untrusted tailnet node, a lost/stolen device, and a replayed connection through three independent layers — Tailscale ACL (node identity + membership), app-layer pairing (per-device registered keys), and per-connection signature verification — such that no single layer alone grants daemon control.

#### Scenario: Untrusted tailnet node cannot control the daemon
- **WHEN** a node that is on the tailnet but never paired attempts to control the daemon
- **THEN** it is rejected at the pairing/signature layer even though it passed the Tailscale membership layer

#### Scenario: Lost device is contained by revocation
- **WHEN** a device is lost and the operator revokes its paired key
- **THEN** that device's subsequent signed hello fails and it can no longer control the daemon

#### Scenario: Replayed connection is rejected
- **WHEN** a captured prior connection handshake is replayed
- **THEN** the single-use daemon-issued nonce challenge no longer verifies and the session is not upgraded

### Requirement: Removing the relay E2EE box is safe under WireGuard
The design MUST rely on WireGuard (via Tailscale) for transport encryption and cryptographic node identity, and MUST document that pairing plus per-connection signing supply the application-layer authorization that tailnet membership alone does not; the JAgentDesk relay end-to-end box (jagentdesk encrypted-channel.ts, jagentdesk relay-transport.ts:416) is therefore removed rather than reimplemented.

#### Scenario: Confidentiality without the app-layer box
- **WHEN** traffic flows between a paired client and the daemon over the tailnet
- **THEN** it is encrypted by WireGuard and no additional application-layer E2EE handshake is required

#### Scenario: Membership is necessary but not sufficient
- **WHEN** a node is a valid tailnet member but not a paired device
- **THEN** it cannot control the daemon, because authorization requires a registered device key and a valid per-connection signature

### Requirement: Tool-call permission policy gates agent actions
The daemon MUST enforce a permission policy for agent tool calls so that gated actions require an explicit decision rather than executing implicitly.

#### Scenario: Gated tool call requires a decision
- **WHEN** an agent requests a tool call subject to the permission policy
- **THEN** the daemon withholds execution until an allow decision is recorded

### Requirement: BYOK with no provider key custody
The daemon MUST operate under bring-your-own-key: provider API keys are supplied by the operator and used to reach providers directly, and the daemon MUST NOT act as a custodial key escrow for a third party.

#### Scenario: Keys are not escrowed off-box
- **WHEN** an operator configures a provider key
- **THEN** the key is used locally by the daemon and is not transmitted to any relay or hosted key-custody service

### Requirement: Capability-token bypass routes stay narrowly scoped
The daemon MUST keep exactly the bypass paths `/api/health`, `/api/files/download`, and `/mcp/agents` exempt from the global bearer middleware, each authenticated by its own capability (health = unauthenticated liveness; download = single-use token; `/mcp/agents` = per-daemon-run capability token), and MUST reject `/api/files/download` and `/mcp/agents` callers presenting neither their capability token nor a valid credential (jagentdesk auth.ts:124-152, 163-182).

#### Scenario: Bypass set is exactly three paths
- **WHEN** any request other than `OPTIONS` targets a path not in `{ "/api/health", "/api/files/download", "/mcp/agents" }`
- **THEN** the global bearer middleware applies (jagentdesk auth.ts:148-153)

#### Scenario: Download without a token is rejected
- **WHEN** a request hits `/api/files/download` without a valid single-use download token
- **THEN** it is rejected (400/403) even though the global bearer is bypassed (jagentdesk auth.ts:130-135)

#### Scenario: MCP agents endpoint accepts only its capability token or a valid credential
- **WHEN** a request hits `/mcp/agents`
- **THEN** it is authorized only via the per-daemon-run capability token (constant-time compared, jagentdesk auth.ts:172-179) or an otherwise valid credential, and rejected otherwise

### Requirement: Credential comparisons are constant-time and non-token schemes are rejected
The daemon MUST compare the daemon-password bearer with bcrypt (cost `DAEMON_PASSWORD_BCRYPT_COST = 12`) and compare capability tokens with `timingSafeEqual` after a length guard, and MUST accept the WebSocket bearer only via the `jagentdesk.bearer.<token>` subprotocol and the HTTP bearer only via the `Bearer <token>` scheme (jagentdesk auth.ts:5, 48-49, 52-88, 172-181).

#### Scenario: Malformed HTTP bearer is treated as no token
- **WHEN** an `Authorization` header does not match exactly `Bearer <token>`
- **THEN** it is parsed as no token and the request is unauthorized when a password is configured (jagentdesk auth.ts:52-61, 41-43)

#### Scenario: WebSocket bearer requires the jagentdesk.bearer subprotocol
- **WHEN** a WebSocket upgrade omits a `jagentdesk.bearer.<token>` subprotocol while a password is configured
- **THEN** the daemon closes the socket with code `4401` (jagentdesk websocket-server.ts:858, jagentdesk auth.ts:63-88)

#### Scenario: Capability token compare is length-guarded
- **WHEN** a presented capability token differs in length from the expected token
- **THEN** the daemon does not call `timingSafeEqual` on mismatched lengths and treats it as not matching (jagentdesk auth.ts:175-178)

### Requirement: Secret files are hardened with 0600 permissions and atomic writes
The daemon MUST store secret material (e.g. the daemon keypair) with owner-only `0600` permissions and MUST write it atomically, verifying/repairing permissions on load (jagentdesk daemon-keypair.ts:40, 65 via `ensurePrivateFile` / `writePrivateFileAtomicSync`).

#### Scenario: Keypair written atomically at 0600
- **WHEN** the daemon creates its keypair file
- **THEN** it is written via an atomic private-file write with `0600` permissions (jagentdesk daemon-keypair.ts:65)

#### Scenario: Permissions enforced on load
- **WHEN** the daemon loads an existing keypair file
- **THEN** it enforces the private-file permission before reading (jagentdesk daemon-keypair.ts:40)
