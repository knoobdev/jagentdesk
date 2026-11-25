# Protocol Compatibility

The app and the daemon are separate products that ship separately. A user updates the app from an app store or a desktop auto-update; they update the daemon when they feel like it. Every combination happens in the wild: new app against an old daemon, old app against a new daemon, and both sides months apart.

In development both sides are always the same version, which is why this is the constraint contributors miss most often.

Two contracts follow from it.

## The protocol contract: always compatible

A schema change must not break parsing in either direction. An old app still parses messages from a new daemon. A new daemon still parses messages from an old app.

- New fields are `.optional()` with a sensible default.
- Never flip optional to required, remove a field, or narrow a type. `string` to `enum` and nullable to non-null are both narrowing.
- A field you stop sending stays accepted. You stop writing it, you don't stop reading it.
- Wire schemas are pure structural declarations. No `.transform()`, `.catch()`, or `.preprocess()` on WebSocket message schemas — normalization happens in an explicit pass after validation. The reason is in [protocol-validation.md](protocol-validation.md): inbound validators are generated, and the generator only compiles pure schemas.
- Plain `z.union()` is forbidden when every branch shares a literal tag. Use `z.discriminatedUnion()`.
- `.default()` belongs on primitive leaves only, never on item schemas inside large arrays or big inbound containers.

Two questions to ask before you commit a schema change:

1. Does a six-month-old app still parse this message?
2. Does a six-month-old daemon still send something this app accepts?

If you can't answer both with yes, the change isn't done.

Schemas live in `packages/protocol/src/messages.ts`. New RPC names follow [rpc-namespacing.md](rpc-namespacing.md).

## The feature contract: per feature, gated once

Features don't have to work across versions. A new feature usually needs a new daemon capability, and old daemons don't have it.

The app checks for the capability and either runs the feature or tells the user to update the host.

- **No fallback paths.** Don't build a degraded version of the feature for old daemons. Don't fan out across legacy RPCs to simulate a capability that isn't there. The user updates or doesn't get the feature.
- **No defensive branches spread through the feature.** Detection happens in one place, and everything downstream reads a clean shape.
- Capability flags live in `features` on the `server_info` message (`packages/protocol/src/messages.ts`, the `server_info` schema).

Existing functionality keeps working across versions because of the protocol contract. Gating a new feature never substitutes for that.

## Large transport messages

Chunked transport is negotiated per physical connection: the client advertises
`binary_chunking_v1` in hello, and the daemon advertises optional
`features.binaryChunkingV1` in the ordinary server-info response. Both sides must
advertise support before sending chunks. Older peers keep ordinary frames and
their existing size limits. Framing sits outside serialization and inside relay
encryption, so each encrypted relay frame fits the Worker's 32 MiB limit while
the logical message remains bounded at 100 MiB. React Native sockets cannot report
write drain; their outbound messages retain the physical frame limit.

## Terminal ANSI replay

ADR-0051 in the spec repo defines terminal history compatibility. Keep advertising
`features["terminal-restore-modes"]` forever: released v0.9.x apps use it to request
ANSI restore. Without `terminal_chunked_replay`, send one Restore frame with 200
history rows by default, clamped to 0–500. Capable clients receive bounded ANSI
chunks and request their configured history, clamped to 0–10,000. JSON snapshot
opcodes remain parseable but are no longer sent or rendered. Omitting `restore`
requests subsequent live output only. The SDK supplies an explicit full replay
when `subscribeTerminal` has no restore options.

## Every shim is tagged and dated

A shim that exists for old-app or old-daemon support carries a comment naming it, the version it arrived in, and when it can go:

```ts
// COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
```

`rg "COMPAT\("` is the full cleanup backlog, so:

- One tag per shim, at the site that has to be deleted.
- Give it a name, a version, and a removal condition or date. Six months out is the usual default.
- Never bury compatibility in an untagged `??` fallback or an optional-chain tunnel. Untagged back-compat never gets removed, because nobody can find it.

When a tag's condition is met, delete the shim and the tag in the same change.

## Removed features

A spec-repo ADR can retire a feature together with its message schemas. This is an explicit
exception to retaining retired message schemas. Older clients calling the removed RPCs receive
the normal `rpc_error` with `code: "unknown_schema"` (unknown request), and `server_info.features`
stops advertising the feature, so older apps hide it.

| ADR      | Feature                | Removed                                                                                                                           | Kept                                                                                                                                                                                            |
| -------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0050 | Team mode, agent forum | `forum.*` agent tools, `forum/*` and `forum.diagram.html.request` RPCs, stream, capability flag                                   | `$JAGENTDESK_HOME/forums/` stays on disk, unread. ORC keeps its contract.                                                                                                                       |
| ADR-0055 | Figma, Activity graph  | `figma.*` and `agent.activity_graph.*` RPCs and pushes, `figma_*` tools, `figma*`/`activityGraph` flags, both client capabilities | Built-in list items still accept the `figma` and `activity-graph` ids from older daemons (`COMPAT(adr0055)` in `builtin-plugins.ts`). Stale `builtinPlugins` keys in `config.json` are ignored. |

ADR-0055 also deletes the stored Figma credentials and the Figma cache once at daemon start
(`packages/server/src/server/retired-figma-data.ts`): nothing reads them any more, and credentials
should not outlive the code that used them. The saved connection and file lists stay on disk.

## Recent additive changes

- v0.9.57: `remote_exec.*` RPCs and the `remote_exec.job_updated` push (spec 33 / ADR-0044). `SshServer` gained optional `via` and `remoteExec` fields. Old clients ignore the new fields and never send the new types; old daemons never send them.
- v0.9.58: `RemoteJob` gained optional `noCode` and `sources` fields (spec 33.4 / ADR-0045). Old clients parse jobs without them; old daemons never send them.
- v0.9.59: `providers.custom.list|save|delete|test` requests and responses (spec 34 / ADR-0047); provider config entries gained an optional `api` block. Old clients never send the new requests and the settings section shows the daemon's error on old daemons.

## QA

Tests don't fully cover compatibility. If you touched `packages/protocol`, say in the pull request why an older app still parses your message and why an older daemon still satisfies your app. See [qa.md](qa.md).
