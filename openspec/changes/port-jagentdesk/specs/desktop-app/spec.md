## ADDED Requirements

### Requirement: Desktop app is an Electron host for the shared client
The desktop MUST bootstrap through Electron, register daemon, window, notification, updater, and browser-automation handlers, and host the shared app renderer rather than introducing a separate desktop UI implementation (`scratchpad/reference/packages/desktop/src/main.ts:12-47,78-92`).

#### Scenario: GUI startup performs the complete bootstrap
- **GIVEN** no CLI passthrough launch is pending
- **WHEN** desktop startup runs
- **THEN** it inherits the login-shell environment, awaits GUI bootstrap, and runs optional installed-skill updates (`scratchpad/reference/packages/desktop/src/desktop-startup.ts:9-16`)

### Requirement: Desktop manages a local daemon lifecycle
The desktop MUST expose daemon status with server ID, state, listen target, hostname, PID, home, version, ownership, and error fields, and MUST support controlled stop reasons including manual IPC, settings, quit, update, version mismatch, and restart (`scratchpad/reference/packages/desktop/src/daemon/daemon-manager.ts:44-74`).

#### Scenario: Desktop reports daemon state
- **GIVEN** the managed daemon is starting, running, stopped, or errored
- **WHEN** the renderer requests daemon status
- **THEN** the response contains the state and the nullable listen, hostname, PID, version, and error fields (`scratchpad/reference/packages/desktop/src/daemon/daemon-manager.ts:49-74`)

#### Scenario: Quit stops only a desktop-managed daemon
- **GIVEN** a daemon lock does not identify a desktop-managed running process
- **WHEN** the desktop checks whether it owns a running daemon
- **THEN** it returns false and does not stop that process (`scratchpad/reference/packages/desktop/src/daemon/daemon-manager.ts:121-129`)

### Requirement: Desktop supports local and remote daemon connections
The desktop MUST retain JAgentDesk's local transport session seam for a co-located daemon and use the JAgentDesk Tailscale direct WebSocket transport for remote paired daemons; it MUST not use JAgentDesk's relay transport. JAgentDesk's local session handlers are registered by the daemon manager (`scratchpad/reference/packages/desktop/src/daemon/daemon-manager.ts:28-33`; `scratchpad/reference/packages/desktop/src/main.ts:27-30`).

#### Scenario: Local desktop daemon is controlled through local transport
- **GIVEN** the desktop manages a co-located daemon
- **WHEN** the renderer sends a local daemon request
- **THEN** the desktop opens or reuses a local transport session and can send and close messages through the local transport module (`scratchpad/reference/packages/desktop/src/daemon/daemon-manager.ts:28-31`)

### Requirement: Desktop embeds browser automation but not an in-app file editor
The desktop MUST retain JAgentDesk's browser webview and browser-automation registration surfaces (`scratchpad/reference/packages/desktop/src/main.ts:51-66,89-91`), while JAgentDesk MUST omit the in-app file editor and expose file and diff views as read-only.

#### Scenario: Editor mutation is unavailable
- **GIVEN** the user opens a file or diff view in the desktop
- **WHEN** the user attempts to edit file contents
- **THEN** no editor mutation operation is exposed and the view remains read-only; browser automation remains available through its separate webview surface

