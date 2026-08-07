## ADDED Requirements

### Requirement: Composer validates and submits agent input
The client MUST trim composer text, preserve attachments, reject an empty submission when there is no external content and `allowEmptySubmit` is false, and return `noop` when submission is not allowed (`scratchpad/reference/packages/app/src/composer/submit.ts:25-43`).

#### Scenario: Empty composer is ignored
- **GIVEN** the composer text is whitespace-only, has zero attachments, has no external content, and `allowEmptySubmit` is false
- **WHEN** the user submits the composer
- **THEN** the client returns `noop` and does not call `submitMessage` or `queueMessage` (`scratchpad/reference/packages/app/src/composer/submit.ts:28-39`)

#### Scenario: Submitted text is trimmed
- **GIVEN** submission is allowed and the text is `  inspect status  `
- **WHEN** the client calls the daemon submission function
- **THEN** it passes `inspect status` and preserves the supplied attachment array (`scratchpad/reference/packages/app/src/composer/submit.ts:28-30,62-66`)

### Requirement: Running agents use queue-or-interrupt semantics
The client MUST queue a message while an agent is running unless `forceSend` is true, clear the draft after a queued send when the submit behavior is `clear`, and expose the queued result as `queued` (`scratchpad/reference/packages/app/src/composer/submit.ts:45-51`).

#### Scenario: Message is queued during an active run
- **GIVEN** `isAgentRunning` is true and `forceSend` is false
- **WHEN** the user submits non-empty text
- **THEN** exactly one `queueMessage` call is made, `submitMessage` is not called, and the result is `queued` (`scratchpad/reference/packages/app/src/composer/submit.ts:45-51`)

#### Scenario: Force send bypasses the queue
- **GIVEN** `isAgentRunning` is true and `forceSend` is true
- **WHEN** the user submits text
- **THEN** the client proceeds to `submitMessage`, sets processing before the await, and returns `submitted` after success (`scratchpad/reference/packages/app/src/composer/submit.ts:54-66`)

### Requirement: Composer attachments are persisted and sent through the daemon
The client MUST persist picked blob, data-URL, or file-URI images, upload file attachments through `uploadFile`, reject an upload with an error or missing file, and include a generated message ID plus encoded images and attachments in `sendAgentMessage` (`scratchpad/reference/packages/app/src/composer/actions.ts:26-67,86-136,181-208`).

#### Scenario: Failed upload does not create a file attachment
- **GIVEN** an upload response contains either `error` or a null `file`
- **WHEN** the client processes the file attachment
- **THEN** it throws the returned error or `Upload failed.` and returns no successfully appended file attachment (`scratchpad/reference/packages/app/src/composer/actions.ts:122-136`)

#### Scenario: Message submission is tracked atomically
- **GIVEN** images and file attachments have been prepared
- **WHEN** the client dispatches the message
- **THEN** it calls `submission.begin` before `sendAgentMessage`, passes a generated `messageId`, and calls `submission.accept` only after the daemon call succeeds (`scratchpad/reference/packages/app/src/composer/actions.ts:181-208`)

### Requirement: Permission, plan, and question requests are actionable
The protocol MUST represent permission requests as one of `tool`, `plan`, `question`, `mode`, or `other`, expose request metadata and optional actions, and accept either an allow response with optional updates or a deny response with an optional message and interrupt flag (`scratchpad/reference/packages/protocol/src/agent-types.ts:406-444`).

#### Scenario: Permission response starts a required follow-up
- **GIVEN** the daemon receives a valid permission response and the agent manager returns a `followUpPrompt`
- **WHEN** `respondToAgentPermission` forwards the response
- **THEN** it starts exactly one replacement agent run with that prompt (`scratchpad/reference/packages/server/src/server/agent/permission-response.ts:22-38`)

#### Scenario: Question denial can interrupt
- **GIVEN** a `question` request is pending
- **WHEN** the client sends `{ behavior: "deny", interrupt: true }`
- **THEN** the response validates as a denial and carries the interrupt decision to the daemon (`scratchpad/reference/packages/protocol/src/agent-types.ts:432-444`)

