## ADDED Requirements

### Requirement: Top-level WebSocket envelopes
The daemon MUST accept exactly the inbound top-level envelope types `ping`, `hello`, `recording_state`, and `session`, and MUST emit exactly the outbound top-level envelope types `pong` and `session`, matching JAgentDesk's `WSInboundMessageSchema`/`WSOutboundMessageSchema` (`packages/protocol/src/messages.ts:5957-5967`).

#### Scenario: Unknown top-level type rejected
- **WHEN** a client sends a top-level message whose `type` is not one of `ping`, `hello`, `recording_state`, `session` (`packages/protocol/src/messages.ts:5959-5962`)
- **THEN** the daemon rejects it because `WSInboundMessageSchema` is a `z.discriminatedUnion("type", ...)` with no matching variant

#### Scenario: Rich session traffic is wrapped
- **WHEN** the daemon sends any session-level message
- **THEN** it is wrapped as `{ type: "session", message: <SessionOutboundMessageSchema> }` per `WSSessionOutboundSchema` (`packages/protocol/src/messages.ts:5951-5954`), and inbound session traffic uses `{ type: "session", message: <SessionInboundMessageSchema> }` per `WSSessionInboundSchema` (`packages/protocol/src/messages.ts:5946-5949`)

### Requirement: Application ping/pong liveness lease
Clients MUST use the top-level JSON `ping`/`pong` envelopes (not RFC6455 control frames or a session RPC) for liveness, and the daemon SHALL treat the first `ping` as an application-ownership lease that is renewed by later inbound activity (`docs/architecture.md:214`).

#### Scenario: Empty ping and pong bodies
- **WHEN** a client sends `{ type: "ping" }` (`packages/protocol/src/messages.ts:5910-5912`)
- **THEN** the daemon replies `{ type: "pong" }` (`packages/protocol/src/messages.ts:5914-5916`), each carrying no fields beyond `type`

#### Scenario: Ping cadence
- **WHEN** a current client is connected
- **THEN** it sends a ping every 10 seconds beginning one interval after connecting, and the daemon forcibly terminates the socket if the lease expires (`docs/architecture.md:214`)

### Requirement: Hello handshake with JAgentDesk pairing signature
The client MUST open a session with a `hello` envelope carrying `clientId` (non-empty), `clientType` one of `mobile|browser|cli|mcp`, integer `protocolVersion`, optional `appVersion`, and optional `capabilities`, and for JAgentDesk MUST additionally include a `signature` field proving pairing before the daemon accepts control (`packages/protocol/src/messages.ts:5918-5936`; ADR-0002).

#### Scenario: Hello fields validated
- **WHEN** a client sends `hello` with `clientType: "mobile"` and `protocolVersion` as an integer (`packages/protocol/src/messages.ts:5921-5923`)
- **THEN** the daemon accepts it and emits a session `status` message with `payload.status: "server_info"` carrying `serverId`, `hostname`, `version`, and `features` (`docs/architecture.md:208-210`); there is no dedicated welcome message

#### Scenario: JAgentDesk unpaired signature rejected
- **WHEN** a `hello` arrives whose `signature` does not verify against a paired device public key (JAgentDesk delta over JAgentDesk `WSHelloMessageSchema`)
- **THEN** the daemon refuses to grant control even though the node is inside the tailnet; capabilities from an accepted hello are stored and rehydrated on reconnect (`docs/architecture.md:212`)

### Requirement: requestId correlation and rpc_error
Every correlated RPC MUST keep the same `requestId` in both request and response, and failures MUST be reported with an `rpc_error` message carrying `requestId`, optional `requestType`, `error`, and optional `code` (`packages/protocol/src/messages.ts:2951-2960`; `docs/rpc-namespacing.md:59`).

#### Scenario: Failure surfaces as rpc_error
- **WHEN** a session RPC fails
- **THEN** the daemon emits `{ type: "rpc_error", payload: { requestId, requestType?, error, code? } }` (`packages/protocol/src/messages.ts:2951-2958`), and the client matches it to the pending request by `requestId`

### Requirement: Default 60-second RPC wait
Client session RPC waits MUST default to 60 seconds so slow relay or mobile networks do not turn a delayed daemon response into a false operation failure, kept separate from connect timeouts and liveness ping timers (`docs/architecture.md:221`).

#### Scenario: Slow response not treated as socket death
- **WHEN** a daemon response is delayed but the socket is live
- **THEN** the client waits up to the 60s RPC default and does not treat the RPC timeout as proof the socket is dead (`docs/architecture.md:214,221`)

### Requirement: Dotted RPC naming convention
New session RPCs MUST use dotted names `domain.namespace.verb.request` / `.response` with the direction as the final segment, request parameters at the top level and correlated result data under `payload`, using dots (not slashes) (`docs/rpc-namespacing.md:3-17,32-59`).

#### Scenario: Request/response shape
- **WHEN** a client sends `{ type: "checkout.forge.set_auto_merge.request", cwd, enabled, mergeMethod, requestId }` (`docs/rpc-namespacing.md:34-42`)
- **THEN** the daemon replies `{ type: "checkout.forge.set_auto_merge.response", payload: { ..., requestId } }` with `requestId` preserved as the correlation key (`docs/rpc-namespacing.md:44-59`)

#### Scenario: No new flat names
- **WHEN** a new RPC is added
- **THEN** it uses the dotted form; existing flat names (e.g. `checkout_pr_merge_request`/`_response`) remain accepted for compatibility but no new flat names are added (`docs/rpc-namespacing.md:74-86`)

### Requirement: Daemon and diagnostics RPC surface
The daemon MUST support the daemon-lifecycle and diagnostics RPCs from JAgentDesk: dotted `daemon.get_status`, `daemon.get_pairing_offer`, `daemon.update`, `diagnostics`; and flat `get_daemon_config`, `set_daemon_config`, `read_project_config`, `write_project_config`, `restart_server_request`, `shutdown_server_request`, `provider_diagnostic_request` (`packages/protocol/src/messages.ts:1168-1194,1199-1216,1340,1382-1393`).

#### Scenario: Status and pairing offer
- **WHEN** a client sends `daemon.get_status.request` or `daemon.get_pairing_offer.request` (`packages/protocol/src/messages.ts:1168,1173`)
- **THEN** the daemon replies `daemon.get_status.response` (`:3864`) / `daemon.get_pairing_offer.response` (`:3928`) with matching `requestId`; a pairing-offer request MAY set optional `forceRefresh`, and a current response MAY include optional `pairingCodeExpiresAtMs` so older clients remain wire-compatible

### Requirement: Agent RPC surface
The daemon MUST support the agent RPCs: dotted `agent.timeline.list_prompts`, `agent.provider_subagents.list`, `agent.provider_subagents.timeline.get`, `agent.timeline.set_subscription`, `agent.fork_context`, `agent.detach`, `agent.rewind`; and flat `create_agent_request`, `fetch_agents_request`, `fetch_agent_request`, `fetch_agent_history_request`, `fetch_agent_timeline_request`, `fetch_recent_provider_sessions_request`, `send_agent_message_request`, `wait_for_finish_request`, `abort_request`, `cancel_agent_request`, `refresh_agent_request`, `resume_agent_request`, `import_agent_request`, `delete_agent_request`, `archive_agent_request`, `update_agent_request`, `close_items_request`, `set_agent_mode_request`, `set_agent_model_request`, `set_agent_thinking_request`, `set_agent_feature_request`, `clear_agent_attention`, and the `agent_permission_request`/`agent_permission_response`/`agent_permission_resolved` permission flow (`packages/protocol/src/messages.ts:1287-1531,790,808-827,1042-1160,1370-1376,1453-1505,3794,1656,4002-4010`).

#### Scenario: Agent creation correlated
- **WHEN** a client sends `create_agent_request` (`packages/protocol/src/messages.ts:1287`)
- **THEN** the daemon returns the correlated agent record and streams subsequent `agent_update`/`agent_stream`/`agent_status` events for that agent

#### Scenario: Permission round-trip
- **WHEN** the daemon emits `agent_permission_request` (`packages/protocol/src/messages.ts:4002`)
- **THEN** the client replies `agent_permission_response` (`:1656`) and the daemon confirms with `agent_permission_resolved` (`:4010`)

### Requirement: Provider RPC surface
The daemon MUST support provider RPCs: flat `list_provider_models_request`, `list_provider_modes_request`, `list_provider_features_request`, `list_available_providers_request`, `get_providers_snapshot_request`, `refresh_providers_snapshot_request`, `provider_diagnostic_request`, `list_commands_request`; and dotted `provider.usage.list` (`packages/protocol/src/messages.ts:1308-1340,2317-2323,1346`).

#### Scenario: Providers snapshot fetch and refresh
- **WHEN** a client sends `get_providers_snapshot_request` (`packages/protocol/src/messages.ts:1327`) or `refresh_providers_snapshot_request` (`:1333`)
- **THEN** the daemon replies with the corresponding `_response` (`:4949`,`:4969`) and may emit `providers_snapshot_update` events (`:4959`)

### Requirement: Workspace and project RPC surface
The daemon MUST support the workspace/project RPCs: dotted `project.list`, `project.add`, `project.rename`, `project.remove`, `project.create_directory`, `project.icon.set`, `project.icon.get`, `project.github.clone`, `workspace.create`, `workspace.title.set`, `workspace.pin.set`, `workspace.clear_attention`, `workspace.recovery.inspect`, `workspace.recovery.restore`, `workspace.github.search_repositories`; and flat `open_project_request`, `archive_workspace_request`, `workspace_setup_status_request`, `list_available_editors_request`, `open_in_editor_request`, `directory_suggestions_request`, `github_search_request` (`packages/protocol/src/messages.ts:842-884,1108,2048-2141,2263,2027-2048,1963,1954`).

#### Scenario: Project list correlated
- **WHEN** a client sends `project.list.request` (`packages/protocol/src/messages.ts:1108`)
- **THEN** the daemon replies `project.list.response` (`:3389`) with matching `requestId`

### Requirement: Legacy worktree RPC surface
The daemon MUST support the legacy JAgentDesk-worktree RPCs: `jagentdesk_worktree_list_request`, `jagentdesk_worktree_archive_request`, `create_jagentdesk_worktree_request` (`packages/protocol/src/messages.ts:1974-2010`).

#### Scenario: Worktree create correlated
- **WHEN** a client sends `create_jagentdesk_worktree_request` (`packages/protocol/src/messages.ts:2010`)
- **THEN** the daemon replies `create_jagentdesk_worktree_response` (`:4783`) with matching `requestId`

### Requirement: Checkout, git, and forge RPC surface
The daemon MUST support the checkout/git/forge RPCs: dotted `checkout.refresh`, `checkout.forge.set_auto_merge`, `checkout.github.set_auto_merge`, `checkout.commits.list`, `checkout.commits.file_diff`, `checkout.forge.get_check_details`, `checkout.github.get_check_details`, `checkout.rename_branch`, `forge.search`; and flat `checkout_status_request`, `subscribe_checkout_diff_request`, `unsubscribe_checkout_diff_request`, `checkout_commit_request`, `checkout_merge_request`, `checkout_merge_from_base_request`, `checkout_pull_request`, `checkout_push_request`, `checkout_pr_create_request`, `checkout_pr_merge_request`, `checkout_pr_status_request`, `pull_request_timeline_request`, `validate_branch_request`, `checkout_switch_branch_request`, `stash_save_request`, `stash_pop_request`, `stash_list_request`, `branch_suggestions_request` (`packages/protocol/src/messages.ts:1737-1943,1681-1908`).

#### Scenario: Diff subscription streams updates
- **WHEN** a client sends `subscribe_checkout_diff_request` (`packages/protocol/src/messages.ts:1687`)
- **THEN** the daemon replies `subscribe_checkout_diff_response` (`:4262`) and streams `checkout_status_update` (`:4242`) and `checkout_diff_update` (`:4269`) events

### Requirement: Terminal RPC surface
The daemon MUST support the terminal RPCs: `list_terminals_request`, `subscribe_terminals_request`, `unsubscribe_terminals_request`, `create_terminal_request`, `subscribe_terminal_request`, `unsubscribe_terminal_request`, `kill_terminal_request`, `capture_terminal_request`, and dotted `terminal.rename`; the `terminal_input` inbound event; and `terminal_stream_exit`/`terminal_attention_required` outbound events (`packages/protocol/src/messages.ts:2339-2465,2379,2453,5183-5190`).

#### Scenario: Terminal list correlated
- **WHEN** a client sends `list_terminals_request` (`packages/protocol/src/messages.ts:2339`)
- **THEN** the daemon replies `list_terminals_response` (`:5112`) with matching `requestId`

### Requirement: File and filesystem RPC surface is view-only
The daemon MUST support the read/subscribe file RPCs `fs.file.subscribe`, `fs.file.unsubscribe`, `file_explorer_request`, `file_download_token_request`, `file.upload`, `project_icon_request`, and MUST NOT expose the client-facing `fs.file.write` RPC that JAgentDesk defines at `packages/protocol/src/messages.ts:2247` (JAgentDesk has no in-app editor) (`packages/protocol/src/messages.ts:2233-2276,2202,2257`; AGENTS.md view-only delta).

#### Scenario: File subscription streams content
- **WHEN** a client sends `fs.file.subscribe.request` (`packages/protocol/src/messages.ts:2233`)
- **THEN** the daemon replies `fs.file.subscribe.response` (`:4807`) and streams `fs.file.update` events (`:4843`)

#### Scenario: Write RPC absent
- **WHEN** a client sends `fs.file.write.request` (JAgentDesk `packages/protocol/src/messages.ts:2247`)
- **THEN** the JAgentDesk daemon does not accept it; the write RPC is excluded from the supported surface

### Requirement: Script RPC surface
The daemon MUST support the workspace-script RPCs: dotted `workspace.script.list`, `workspace.script.start`, `workspace.script.stop`; and flat `start_workspace_script_request` (`packages/protocol/src/messages.ts:2393-2406,2386`).

#### Scenario: Script start emits status
- **WHEN** a client sends `workspace.script.start.request` (`packages/protocol/src/messages.ts:2399`)
- **THEN** the daemon replies `workspace.script.start.response` (`:3544`) and streams `script_status_update` events (`:3397`)

### Requirement: Hub RPC surface
The daemon MUST support the hub RPCs: `hub.management.daemon.connect`, `hub.management.daemon.get_status`, `hub.management.daemon.disconnect`, `hub.execution.agent.create`, `hub.execution.control` (`packages/protocol/src/messages.ts:1178-1194,2474-2496`).

#### Scenario: Hub execution streams
- **WHEN** a client sends `hub.execution.agent.create.request` (`packages/protocol/src/messages.ts:2474`)
- **THEN** the daemon replies `hub.execution.agent.create.response` (`:5225`) and streams `hub.execution.agent.update` (`:5248`) and `hub.execution.agent.stream` (`:5257`) events

### Requirement: Streaming event surface
The daemon MUST emit the streaming (non-correlated) events: `agent_update`, `agent_stream`, `agent_status`, `agent.provider_subagents.update`, `workspace_update`, `project.update`, `script_status_update`, `checkout_status_update`, `checkout_diff_update`, `fs.file.update`, `providers_snapshot_update`, `daemon.update.progress`, and the voice/dictation events `dictation_stream_partial`, `dictation_stream_final`, `dictation_stream_error`, `dictation_stream_ack`, `dictation_stream_finish_accepted`, `assistant_chunk`, `audio_output`, `transcription_result`, `voice_input_state` (`packages/protocol/src/messages.ts:3241-3268,3716,3357,3381,3397,4242-4269,4843,4959,5217,2729-2762,2687-2722`).

#### Scenario: Agent activity streams
- **WHEN** a running agent changes state or produces a timeline event
- **THEN** the daemon emits `agent_update` (`packages/protocol/src/messages.ts:3241`) and `agent_stream` (`:3256`) respectively, and `agent_status` (`:3268`) for status transitions

### Requirement: Terminal binary frame protocol
Terminal I/O MUST be carried as binary WebSocket frames of layout `[1-byte opcode][1-byte slot][payload]` with opcodes `Output 0x01`, `Input 0x02`, `Resize 0x03`, `Snapshot 0x04` (and `Restore 0x05`), resize payload being JSON `{ rows, cols }` and snapshot payload being the JSON terminal state (`packages/protocol/src/binary-frames/terminal.ts:10-16,65-76,93-119`; `docs/architecture.md:258-260`).

#### Scenario: Frame encoding
- **WHEN** the daemon sends terminal output for slot `n`
- **THEN** the frame is `bytes[0]=0x01`, `bytes[1]=n & 0xff`, followed by the raw output bytes (`packages/protocol/src/binary-frames/terminal.ts:70-75`); frames shorter than 2 bytes or with an unknown opcode decode to `null` (`:78-91`)

#### Scenario: Demux by opcode
- **WHEN** a binary frame arrives with first byte in `{0x01,0x02,0x03,0x04,0x05}`
- **THEN** it is decoded as a terminal frame; first byte in `{0x10,0x11,0x12}` decodes as a file-transfer frame; any other first byte yields `null` (`packages/protocol/src/binary-frames/demux.ts:16-34`)

### Requirement: File-transfer binary frame protocol
File download/upload streams MUST use binary frames with opcodes `FileBegin 0x10`, `FileChunk 0x11`, `FileEnd 0x12`, each carrying a length-prefixed `requestId`, with `FileBegin` carrying a Uint16-length-prefixed JSON metadata `{ mime, size, encoding, modifiedAt, revision?, fileName? }` and downloads streaming 256 KiB chunks from one stable handle awaiting each physical send (`packages/protocol/src/binary-frames/file-transfer.ts:4-19,58-86`; `docs/architecture.md:264-268`).

#### Scenario: FileBegin layout
- **WHEN** the daemon starts a transfer
- **THEN** it sends `bytes[0]=0x10`, `bytes[1]=requestId byte length`, the `requestId` bytes, a Uint16 `metadata` length, then the JSON metadata; a metadata payload larger than `0xffff` bytes throws (`packages/protocol/src/binary-frames/file-transfer.ts:61-73`)

#### Scenario: Chunk sizing and back-to-back sends
- **WHEN** a download proceeds
- **THEN** each `FileChunk (0x11)` carries up to 256 KiB and the transfer awaits completion of its own physical WebSocket send before reading the next chunk, scoped to the requesting socket (`docs/architecture.md:264-268`)
