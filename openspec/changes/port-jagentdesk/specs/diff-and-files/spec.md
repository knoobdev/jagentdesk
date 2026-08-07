## ADDED Requirements

### Requirement: File explorer listing and scoped reads
JAgentDesk MUST provide a file explorer that lists entries below a workspace root and reads files without escaping that root. Directory entries MUST include name, relative path, kind, size, and ISO modification time; listings MUST sort by newest modification time first, then name (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:44-55,142-190`). File reads MUST classify content as `text`, `image`, or `binary`, and carry encoding, MIME type, size, modification time, and revision (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:57-77,192-232,235-288`).

#### Scenario: Directory listing
- **GIVEN** a client sends `file_explorer_request` with `mode: "list"` and a workspace-relative path (`scratchpad/reference/packages/protocol/src/messages.ts:2177-2208`)
- **WHEN** the daemon resolves the path under the workspace root
- **THEN** it returns a directory payload whose entries contain the required metadata and are ordered by descending modification time with name as the tie-breaker (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:142-190`)

#### Scenario: Path escape rejected
- **GIVEN** a file request contains a path that resolves outside the workspace root (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:125-133`)
- **WHEN** the daemon resolves the scoped path
- **THEN** it rejects the request with the access-outside-workspace error and does not read the target

### Requirement: Read-only file preview
The desktop and mobile clients MUST render text previews, image previews, and binary metadata as view-only surfaces. JAgentDesk MUST NOT expose or route JAgentDesk's `fs.file.write.request`; the protocol write schema is a source reference for the explicitly excluded editor behavior (`scratchpad/reference/packages/protocol/src/messages.ts:2185-2194,2246-2254`).

#### Scenario: Text preview
- **GIVEN** a file is classified as text (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:268-284`)
- **WHEN** the client receives the read result
- **THEN** it displays UTF-8 content and metadata, without an edit/save action

#### Scenario: Image and binary preview
- **GIVEN** a file has a recognized image extension or is detected as binary (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:249-275`)
- **WHEN** the client receives the read result
- **THEN** an image is represented as base64 with its MIME type, while a binary file is represented with `encoding: "none"` and metadata only (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:198-220`)

#### Scenario: Write operation absent
- **GIVEN** a client sends `fs.file.write.request` (`scratchpad/reference/packages/protocol/src/messages.ts:2246-2254`)
- **WHEN** JAgentDesk dispatches session messages
- **THEN** the request is rejected or omitted from the supported dispatch surface, and no file bytes are changed by the app

### Requirement: Live file version observation
The daemon MUST support file version subscriptions that return an initial version and notify subscribers only when the file fingerprint changes. The fingerprint MUST include the file revision when ready; watcher events MUST be debounced by 50 ms, and watcher failure MUST fall back to a 5000 ms polling interval (`scratchpad/reference/packages/server/src/server/file-explorer/observer.ts:25-34,58-102,111-165,168-171`).

#### Scenario: Initial and changed version
- **GIVEN** a client subscribes with `fs.file.subscribe.request` containing `cwd`, relative `path`, `subscriptionId`, and `requestId` (`scratchpad/reference/packages/protocol/src/messages.ts:2232-2238`)
- **WHEN** the subscription is established and the file later changes revision
- **THEN** the daemon returns the initial version and emits an update only for the changed file version (`scratchpad/reference/packages/server/src/server/file-explorer/observer.ts:58-101,144-155`)

#### Scenario: Watcher fallback
- **GIVEN** the filesystem watcher cannot start or reports an error (`scratchpad/reference/packages/server/src/server/file-explorer/observer.ts:111-130`)
- **WHEN** the observer switches to fallback mode
- **THEN** it polls every 5000 ms until the subscription is removed (`scratchpad/reference/packages/server/src/server/file-explorer/observer.ts:127-165`)

### Requirement: File transfer framing
File downloads and uploads MUST use file-transfer binary frames with opcodes `0x10` (begin), `0x11` (chunk), and `0x12` (end). A begin frame MUST carry a non-empty request ID and length-prefixed metadata including MIME, byte size, encoding, modification time, optional revision, and optional filename; request IDs MUST fit in one unsigned byte and metadata MUST fit in one unsigned 16-bit length (`scratchpad/reference/packages/protocol/src/binary-frames/file-transfer.ts:4-19,58-85,88-150`).

#### Scenario: Valid begin frame
- **GIVEN** a transfer has a non-empty request ID and metadata within the encoded size limit (`scratchpad/reference/packages/protocol/src/binary-frames/file-transfer.ts:58-73,142-150`)
- **WHEN** the daemon starts the transfer
- **THEN** it emits opcode `0x10`, the request-ID length and bytes, a uint16 metadata length, and JSON metadata

#### Scenario: Invalid transfer frame
- **GIVEN** a frame has an empty/too-long request ID, invalid opcode, or mismatched metadata length (`scratchpad/reference/packages/protocol/src/binary-frames/file-transfer.ts:88-127,142-150`)
- **WHEN** the receiver decodes it
- **THEN** decoding returns null and the frame is not dispatched as a file operation

### Requirement: Stable streamed file reads
Large file reads MUST stream from one open file handle in chunks of at most 256 KiB and MUST verify the final revision before completing. If the file shrinks, changes during transfer, or its final revision differs, the transfer MUST fail instead of silently returning mixed content (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:79-88,290-331,369-391`).

#### Scenario: Chunked download
- **GIVEN** a client requests a file transfer for a readable file (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:290-327`)
- **WHEN** the daemon streams its contents
- **THEN** it advertises the file metadata once and yields chunks no larger than 256 KiB from the same open handle (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:303-327,369-384`)

#### Scenario: File changes during transfer
- **GIVEN** the file's size or revision changes before all advertised bytes are read (`scratchpad/reference/packages/server/src/server/file-explorer/service.ts:374-390`)
- **WHEN** the daemon detects the short read or final revision mismatch
- **THEN** it fails the transfer with a file-changed error and does not report a successful complete read

### Requirement: Structured diff viewing and oversized states
JAgentDesk MUST expose structured diff files with path, new/deleted flags, additions, deletions, hunks, and status `ok`, `too_large`, or `binary` (`scratchpad/reference/packages/protocol/src/messages.ts:2153-2175`). The client MUST render a dedicated too-large state when the daemon reports `diffTooLarge`, and MUST preserve binary/too-large file placeholders instead of truncating them as valid patches (`scratchpad/reference/packages/protocol/src/messages.ts:4252-4271`; `scratchpad/reference/packages/app/src/git/diff-too-large-state.tsx:10-21`).

#### Scenario: Structured diff result
- **GIVEN** a client subscribes to a checkout diff with `includeStructured` semantics (`scratchpad/reference/packages/protocol/src/messages.ts:1686-1692,4252-4271`)
- **WHEN** the daemon returns a diff within its budget
- **THEN** each returned file has typed hunks and additions/deletions, and the client can group files into a collapsible directory tree while preserving full directory paths (`scratchpad/reference/packages/app/src/git/diff-tree.ts:68-96,157-191`)

#### Scenario: Diff exceeds aggregate budget
- **GIVEN** structured diff content cannot fit the daemon's aggregate structured-diff budget (`scratchpad/reference/packages/server/src/utils/checkout-git.ts:1941-1970,3078-3115`)
- **WHEN** the daemon completes computation
- **THEN** it returns `diffTooLarge: true` with an empty structured file list, and the client shows the too-large state rather than treating the result as a complete patch (`scratchpad/reference/packages/protocol/src/messages.ts:4252-4259`; `scratchpad/reference/packages/app/src/git/diff-too-large-state.tsx:10-21`)

#### Scenario: Binary or per-file oversized diff
- **GIVEN** a changed file is binary or exceeds the 1 MiB per-file budget (`scratchpad/reference/packages/server/src/utils/checkout-git.ts:1941-1944,2006-2037`)
- **WHEN** the daemon builds plain and structured diff output
- **THEN** it emits a `binary` or `too_large` placeholder and the plain diff contains an omission marker, not an invented textual patch (`scratchpad/reference/packages/server/src/utils/checkout-git.ts:2841-2877,3067-3076`)

### Requirement: Commit and working-tree diff modes
The diff viewer MUST support both uncommitted changes and comparison against a selected base reference, with optional whitespace ignoring, and MUST receive live updates through a subscription ID (`scratchpad/reference/packages/protocol/src/messages.ts:1674-1697,4252-4271`). Viewing a diff MUST not imply permission to edit files; git mutation remains a separate explicit protocol operation.

#### Scenario: Compare modes
- **GIVEN** a diff request selects `mode: "uncommitted"` or `mode: "base"` and optionally supplies `baseRef` or `ignoreWhitespace` (`scratchpad/reference/packages/protocol/src/messages.ts:1674-1678`)
- **WHEN** the daemon computes the checkout diff
- **THEN** it compares exactly the requested mode and returns the result under the matching subscription, without modifying the checkout

#### Scenario: Live diff update
- **GIVEN** an active checkout diff subscription exists (`scratchpad/reference/packages/protocol/src/messages.ts:1686-1697`)
- **WHEN** the working tree status or diff changes
- **THEN** the daemon emits `checkout_diff_update` with the same `subscriptionId`, `cwd`, file list, and nullable error (`scratchpad/reference/packages/protocol/src/messages.ts:4252-4271`)
