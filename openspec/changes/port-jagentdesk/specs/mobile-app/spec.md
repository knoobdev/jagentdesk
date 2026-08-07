## ADDED Requirements

### Requirement: Mobile app uses Expo Router and shared providers

The mobile client MUST use Expo Router routes, React Native providers for safe area, gestures, keyboard, query state, session state, voice, and i18n, and the same shared client surface must remain usable on web/Electron (`scratchpad/reference/packages/app/src/app/_layout.tsx:1-24,57-63,90-110`).

#### Scenario: Mobile root initializes platform providers

- **GIVEN** the app starts on a native platform
- **WHEN** the root layout mounts
- **THEN** it initializes the gesture root, keyboard provider, safe-area provider, query provider, session provider, voice provider, and i18n provider before rendering app routes (`scratchpad/reference/packages/app/src/app/_layout.tsx:1-24,57-63,90-96`)

### Requirement: Mobile startup resolves host and workspace routes

After the JAgentDesk-specific Tailscale-login gate and pairing gate have completed, the app MUST resolve its startup route from host registry, online-host, and last-workspace state, redirect when a route is ready, and otherwise show the startup splash (`scratchpad/reference/packages/app/src/app/index.tsx:19-54`).

#### Scenario: Startup waits for host bootstrap

- **GIVEN** host registry or workspace selection is not ready
- **WHEN** the index route renders
- **THEN** it renders `StartupSplashScreen` and does not navigate into a workspace (`scratchpad/reference/packages/app/src/app/index.tsx:35-54`)

#### Scenario: Ready startup redirects

- **GIVEN** the startup resolver returns a redirect route
- **WHEN** the index route renders
- **THEN** it returns an Expo Router `Redirect` with the resolver's target (`scratchpad/reference/packages/app/src/app/index.tsx:50-52`)

### Requirement: Mobile provides workspace, session, settings, and pairing routes

The mobile route tree MUST provide host home, agent, sessions, workspace, open-project, schedules, settings, welcome, and pair-scan routes, preserving the observable JAgentDesk route families (`scratchpad/reference/packages/app/src/app/h/[serverId]/index.tsx:1-39`, `scratchpad/reference/packages/app/src/app/h/[serverId]/agent/[agentId].tsx:1-151`, `scratchpad/reference/packages/app/src/app/h/[serverId]/sessions.tsx:1-7`, `scratchpad/reference/packages/app/src/app/h/[serverId]/workspace/[workspaceId]/index.tsx:1-306`, `scratchpad/reference/packages/app/src/app/open-project.tsx:1-10`, `scratchpad/reference/packages/app/src/app/schedules.tsx:1-10`, `scratchpad/reference/packages/app/src/app/settings/index.tsx:1-16`, `scratchpad/reference/packages/app/src/app/welcome.tsx:1-5`, `scratchpad/reference/packages/app/src/app/pair-scan.tsx:1-274`).

#### Scenario: Notification opens the mobile agent panel

- **GIVEN** a notification contains non-empty `serverId`, `workspaceId`, and `agentId`
- **WHEN** the mobile notification router handles it
- **THEN** it navigates to that agent and pins the target (`scratchpad/reference/packages/app/src/app/_layout.tsx:151-165`)

### Requirement: Mobile pairing starts with the desktop offer

JAgentDesk MUST render the pairing entry surface first when there is no saved host or pending offer. Scan, deep-link, and paste MUST persist a valid v3 offer before routing to Tailscale login; after login the app MUST return to verification and require the six-digit code. Local pairing MUST be an explicit alternative.

#### Scenario: Fresh install shows pairing entry

- **GIVEN** the mobile device has no saved host or pending pairing offer
- **WHEN** the app launches
- **THEN** it renders the pairing entry surface with QR, paste-link, and explicit Local actions

#### Scenario: Pairing offer gates Tailscale login

- **GIVEN** the mobile device has received a valid JAgentDesk v3 offer but is not connected to Tailscale
- **WHEN** the app advances from offer entry
- **THEN** it routes to Tailscale login and returns to the persisted verification screen after login

### Requirement: Mobile notification handling is target-specific

The mobile client MUST resolve notification data into server, workspace, agent, and terminal IDs, route to an agent before a terminal, then fall back to workspace/host/root routes (`scratchpad/reference/packages/app/src/utils/notification-routing.ts:16-41`; `scratchpad/reference/packages/app/src/app/_layout.tsx:151-165`).

#### Scenario: Agent target has priority

- **GIVEN** notification data contains `serverId`, `workspaceId`, and `agentId`
- **WHEN** the notification opens
- **THEN** the client calls agent navigation with `pin: true` rather than opening only the host root (`scratchpad/reference/packages/app/src/app/_layout.tsx:154-164`)
