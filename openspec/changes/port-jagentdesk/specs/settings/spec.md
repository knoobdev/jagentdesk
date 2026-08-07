## ADDED Requirements

### Requirement: Settings exposes the complete application section set
The settings UI MUST expose `general`, `appearance`, `editor` (view-related settings only in JAgentDesk), `diagnostics`, and `about`, and MUST expose desktop-only `shortcuts`, `integrations`, and `permissions` sections according to platform (`scratchpad/reference/packages/app/src/screens/settings-screen.tsx:130-162`).

#### Scenario: Desktop settings list includes desktop sections
- **GIVEN** the settings screen runs in the desktop platform
- **WHEN** the sidebar is built
- **THEN** it includes all eight section IDs and marks shortcuts, integrations, and permissions as desktop-only (`scratchpad/reference/packages/app/src/screens/settings-screen.tsx:143-162`)

### Requirement: Host settings manages paired daemon resources
The settings UI MUST provide host sections for host, projects, connections, pair-device, agents, workspaces, providers, usage, and terminals (`scratchpad/reference/packages/app/src/screens/settings-screen.tsx:164-180`).

#### Scenario: Pair-device is a host-scoped setting
- **GIVEN** the user selects a host settings view
- **WHEN** the selected section is `pair-device`
- **THEN** the screen renders the host pair-device page for that `serverId` (`scratchpad/reference/packages/app/src/screens/settings-screen.tsx:182-205`)

### Requirement: Settings controls send and service-URL behavior
The settings UI MUST offer exactly the send behavior values `interrupt` and `queue`, and exactly the service URL behavior values `ask`, `in-app`, and `external` (`scratchpad/reference/packages/app/src/screens/settings-screen.tsx:228-241`).

#### Scenario: Send behavior choices are bounded
- **GIVEN** the general settings section renders
- **WHEN** it builds send behavior options
- **THEN** the options contain only `interrupt` and `queue` (`scratchpad/reference/packages/app/src/screens/settings-screen.tsx:228-233`)

### Requirement: Settings supports compact and expanded routing
The settings route MUST render the root settings screen on compact layouts and redirect expanded layouts to the `general` section (`scratchpad/reference/packages/app/src/app/settings/index.tsx:1-16`).

#### Scenario: Expanded settings opens general
- **GIVEN** `useIsCompactFormFactor()` returns false
- **WHEN** the settings index route renders
- **THEN** it redirects to the `general` settings route (`scratchpad/reference/packages/app/src/app/settings/index.tsx:8-15`)

### Requirement: JAgentDesk does not expose in-app file editing
The settings model MUST NOT interpret the JAgentDesk `editor` settings section as permission to mutate repository files in the app; JAgentDesk retains only view/editor-display preferences while file editing remains outside product scope.

#### Scenario: Editor settings cannot mutate a file
- **GIVEN** the user changes an editor-view preference
- **WHEN** the preference is saved
- **THEN** it changes presentation behavior only and does not create an in-app file-write operation

