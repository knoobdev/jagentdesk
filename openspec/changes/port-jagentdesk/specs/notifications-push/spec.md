## ADDED Requirements

### Requirement: Attention policy chooses focused, present, or push delivery
The daemon MUST treat a client as present only when its clamped activity is no more than 180,000 ms old, suppress notifications when a visible client is focused on the target, route to the most recent present client otherwise, and use push only when no client is present and `pushEligible` is true (`scratchpad/reference/packages/server/src/server/agent-attention-policy.ts:3-27,42-80`).

#### Scenario: Focused client suppresses delivery
- **GIVEN** a visible client is focused on the target agent and its last activity is within 180,000 ms
- **WHEN** the daemon computes the notification plan
- **THEN** it returns `inAppRecipientIndex: null` and `shouldPush: false` (`scratchpad/reference/packages/server/src/server/agent-attention-policy.ts:51-63`)

#### Scenario: Absent clients use eligible push
- **GIVEN** no client has activity within 180,000 ms and the attention reason is eligible for push
- **WHEN** the daemon computes the plan
- **THEN** it returns no in-app recipient and `shouldPush: true` (`scratchpad/reference/packages/server/src/server/agent-attention-policy.ts:71-80`)

### Requirement: Desktop and web notifications route back to the target
The desktop MUST use Electron notifications only when supported, require a non-empty title, focus the originating window on click, and deliver click data to the renderer; web notification routing MUST resolve an agent target before a workspace or host fallback (`scratchpad/reference/packages/desktop/src/features/notifications.ts:80-123`; `scratchpad/reference/packages/app/src/utils/notification-routing.ts:16-41`).

#### Scenario: Notification click focuses and forwards data
- **GIVEN** a supported desktop notification has non-empty `data`
- **WHEN** the user clicks it
- **THEN** the window is shown/restored/focused and the renderer receives `jagentdesk:event:notification-click` with the data (`scratchpad/reference/packages/desktop/src/features/notifications.ts:51-61,107-114`)

### Requirement: Mobile registers and re-registers Expo push tokens
The mobile client MUST request notification permission, obtain an Expo token using the configured project ID, persist it per server, register it only while connected, and clear the sent-token guard on disconnect so the token is sent again after reconnect (`scratchpad/reference/packages/app/src/hooks/use-push-token-registration.ts:25-31,33-46,48-85,97-110`).

#### Scenario: Token is registered after connection
- **GIVEN** permission is granted, an Expo project ID exists, and the daemon client is connected
- **WHEN** `getExpoPushTokenAsync` returns a non-empty token
- **THEN** the client stores the token under the server-specific key and calls `registerPushToken` exactly once for that token (`scratchpad/reference/packages/app/src/hooks/use-push-token-registration.ts:71-85`)

### Requirement: JAgentDesk push payload is content-light and Tailscale-resolved
JAgentDesk MUST send Expo Push Service payload data containing only the attention event type and opaque routing identifiers, excluding prompts, source text, code, and permission details; when the mobile user opens the notification, the app MUST fetch detail over the authenticated Tailscale connection. This is a deliberate delta from JAgentDesk's preview body and full `reason` payload (`scratchpad/reference/packages/protocol/src/agent-attention-notification.ts:196-212`).

#### Scenario: Sensitive content is excluded
- **GIVEN** an agent finishes with assistant text or a permission request
- **WHEN** the daemon builds a JAgentDesk push payload
- **THEN** its push body/data contains no assistant text, prompt, code, or permission description, and contains only an event type plus opaque target IDs

#### Scenario: Notification opens a target for authenticated refresh
- **GIVEN** a content-light notification contains valid `serverId`, `workspaceId`, and `agentId`
- **WHEN** the mobile app receives the notification
- **THEN** it routes to that agent and refreshes its detail through the paired Tailscale daemon connection (`scratchpad/reference/packages/app/src/app/_layout.tsx:151-165`)

