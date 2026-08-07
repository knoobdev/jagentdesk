## ADDED Requirements

### Requirement: Workspace-scoped PTY lifecycle
JAgentDesk MUST create each terminal as a PTY session with a terminal ID, absolute `cwd`, workspace ID, name/title, environment, optional command and arguments, and activity metadata. A terminal MUST default to 24 rows, 80 columns, and 1000 scrollback lines when no size is supplied (`scratchpad/reference/packages/server/src/terminal/terminal-manager.ts:52-94,311-370`; `scratchpad/reference/packages/server/src/terminal/terminal.ts:799-871`).

#### Scenario: Create terminal with defaults
- **GIVEN** a client sends `create_terminal_request` without `size` (`scratchpad/reference/packages/protocol/src/messages.ts:2357-2376`)
- **WHEN** the daemon creates the PTY
- **THEN** it starts the terminal at 24 rows by 80 columns with a 1000-line scrollback buffer and associates it with the supplied workspace (`scratchpad/reference/packages/server/src/terminal/terminal.ts:799-871`)

#### Scenario: Workspace filtering
- **GIVEN** two workspaces share a path and a terminal list request includes one `workspaceId` (`scratchpad/reference/packages/server/src/terminal/terminal-manager.ts:285-309`)
- **WHEN** the daemon lists terminals
- **THEN** it returns only terminals whose `workspaceId` exactly matches the request, including terminals created in descendant directories when the queried path is their ancestor

### Requirement: Terminal RPC contract
The daemon MUST support list, directory subscription, create, stream subscription, stream unsubscription, input, resize, rename, kill, and capture operations using the protocol message types and correlated response schemas (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:181-213`; `scratchpad/reference/packages/protocol/src/messages.ts:2338-2471,5111-5179`).

#### Scenario: Correlated terminal creation
- **GIVEN** a valid `create_terminal_request` contains `cwd` and `requestId` (`scratchpad/reference/packages/protocol/src/messages.ts:2357-2376`)
- **WHEN** creation succeeds or fails
- **THEN** the daemon emits `create_terminal_response` with the same `requestId`, a nullable terminal record, and a nullable error (`scratchpad/reference/packages/protocol/src/messages.ts:5128-5135`)

#### Scenario: Terminal list subscription
- **GIVEN** a client sends `subscribe_terminals_request` for a workspace root (`scratchpad/reference/packages/protocol/src/messages.ts:2345-2355`)
- **WHEN** a terminal is created, renamed, or its activity changes
- **THEN** the daemon emits `terminals_changed` containing the subscribed `cwd` and the current filtered terminal list (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:347-365`; `scratchpad/reference/packages/protocol/src/messages.ts:5120-5126`)

### Requirement: Binary terminal multiplexing
Terminal I/O MUST use binary frames with a one-byte opcode, one-byte stream slot, and payload. The daemon MUST support output `0x01`, input `0x02`, resize `0x03`, snapshot `0x04`, and restore `0x05`; malformed frames shorter than 2 bytes or with an unknown terminal opcode MUST be ignored (`scratchpad/reference/packages/protocol/src/binary-frames/terminal.ts:10-16,65-90`). A connection MUST allocate no more than 256 active terminal stream slots (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:40,1050-1060`).

#### Scenario: Subscribe assigns a slot
- **GIVEN** a binary-capable client subscribes to a terminal (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:809-831`)
- **WHEN** fewer than 256 terminal streams are active
- **THEN** the daemon returns a slot from 0 through 255 and emits output frames using that slot (`scratchpad/reference/packages/protocol/src/messages.ts:5146-5160`; `scratchpad/reference/packages/protocol/src/binary-frames/terminal.ts:65-75`)

#### Scenario: Slot exhaustion
- **GIVEN** all 256 stream slots are active (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:1050-1059`)
- **WHEN** another stream subscription arrives
- **THEN** the daemon returns a subscription response with a non-null error and does not bind another stream (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:671-699`)

### Requirement: Terminal input, resize, capture, and termination
The daemon MUST route text input to the PTY, apply positive row/column resize requests, return captured lines with `totalLines`, and terminate streams and processes on kill or PTY exit (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:215-250,711-806`; `scratchpad/reference/packages/server/src/terminal/terminal.ts:1182-1239,1363-1440`).

#### Scenario: Input and resize
- **GIVEN** a subscribed terminal receives a non-empty binary input frame or a valid resize payload (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:215-245`; `scratchpad/reference/packages/protocol/src/binary-frames/terminal.ts:4-8`)
- **WHEN** the controller handles the frame
- **THEN** input is written to the matching PTY and resize updates both the terminal emulator and PTY dimensions (`scratchpad/reference/packages/server/src/terminal/terminal.ts:1220-1234`)

#### Scenario: Capture response
- **GIVEN** a client sends `capture_terminal_request` with optional `start`, `end`, and `stripAnsi` (`scratchpad/reference/packages/protocol/src/messages.ts:2464-2471`)
- **WHEN** the terminal exists
- **THEN** the daemon returns the requested capture as `lines`, its `totalLines`, the terminal ID, and the same `requestId` (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:747-790`; `scratchpad/reference/packages/protocol/src/messages.ts:5172-5179`)

#### Scenario: PTY exit
- **GIVEN** the PTY exits or the terminal is killed (`scratchpad/reference/packages/server/src/terminal/terminal.ts:1118-1130,1363-1375`)
- **WHEN** the controller observes the exit
- **THEN** it detaches the stream and emits `terminal_stream_exit` for the terminal (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:289-306`; `scratchpad/reference/packages/protocol/src/messages.ts:5182-5187`)

### Requirement: Backpressure and snapshot recovery
The daemon MUST coalesce terminal output into frames no larger than 256 KiB and switch a stream to snapshot recovery only when output accumulated since the last snapshot exceeds 256 KiB and the client transport reports more than 4 MiB buffered, or when no backpressure signal is available. After a snapshot or restore frame, it MUST replay only output newer than the snapshot revision (`scratchpad/reference/packages/server/src/terminal/terminal-restore.ts:10-17`; `scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:843-877,916-961,1024-1047`).

#### Scenario: Slow client recovery
- **GIVEN** a stream has accumulated more than 256 KiB and its transport buffered amount is greater than 4 MiB (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:849-867`)
- **WHEN** the next coalesced output flush occurs
- **THEN** the daemon sends a snapshot/restore frame, resets the accumulated output counter after success, and does not continue unbounded output streaming (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:939-961`)

#### Scenario: Keeping-up client
- **GIVEN** output has exceeded 256 KiB but the transport buffered amount is at or below 4 MiB (`scratchpad/reference/packages/server/src/terminal/terminal-session-controller.ts:850-864`)
- **WHEN** output is flushed
- **THEN** the daemon continues emitting binary output frames instead of forcing a snapshot

### Requirement: Terminal activity and attention
Each terminal MUST expose nullable activity state in list/change payloads and MUST emit attention information with reason `finished` or `needs_input`, title, body, workspace context, and `shouldNotify` (`scratchpad/reference/packages/server/src/terminal/terminal-manager.ts:15-40,197-224`; `scratchpad/reference/packages/protocol/src/messages.ts:5062-5069,5189-5200`). Activity state changes MUST be observable by subscribers.

#### Scenario: Activity transition
- **GIVEN** a terminal's activity changes (`scratchpad/reference/packages/server/src/terminal/terminal-manager.ts:197-208`)
- **WHEN** the manager publishes the transition
- **THEN** terminal list subscribers receive the updated nullable activity and workspace contribution listeners receive the transition when its status bucket changes

#### Scenario: Attention payload
- **GIVEN** a terminal finishes or needs input (`scratchpad/reference/packages/protocol/src/messages.ts:5189-5200`)
- **WHEN** the daemon emits terminal attention
- **THEN** the event contains a reason from the two-value enum, terminal ID, title, body, and a boolean `shouldNotify`
