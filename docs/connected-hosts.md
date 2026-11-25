# Connected hosts

A saved host belongs to the daemon that stores it. The app's saved connections remain separate. Use
`registrationId` to manage the saved entry and the destination's pinned `serverId` to route work.
Below, A is the daemon that saves the host and B is the destination.

## Pairing and recovery

In the app, open B's host settings, choose **Pair a device**, and copy the pairing link. On A, run
`jagentdesk host add '<pairing-link>' --label build`. Compare the six-digit verification code and
confirm on B and with `y` in the CLI. Neither side can complete pairing alone. The exchange expires
after two minutes; an incomplete exchange saves no registration. This is the same SAS exchange as
[device pairing](permissions.md#device-pairing); A identifies itself as a `daemon` device.

Each registration has its own Ed25519 device key. Keys live
only in A's `hosts.json`, written atomically with fsync and mode `0600`. Startup repairs its mode.
List and inspect return safe summaries. Keep this file out of diagnostic bundles.

Connections use paired loopback, the daemon's tsnet SOCKS5 egress, or the existing encrypted relay.
There is no password or SSH connector for saved hosts. Tailnet links pin the verified node like any
other paired device. See [relay](relay.md) for the relay path.

Identity changes, duplicate destinations, self connections, and rejected device credentials stay in
`error` until an explicit update, enable, or daemon restart. Replacing a connection repeats pairing;
changing its pinned identity also requires `--replace-identity`. An older destination is `outdated`
and retries with backoff capped at 60 seconds. Disable and remove cancel pending retries.

`host ls`, `inspect`, `update`, `enable`, `disable`, and `rm` require `daemon.manage`, as does adding.
Removing a registration closes A's link and deletes its key. Agents and workspaces on B remain.
Revoking A's paired device on B closes the physical link and its routed sessions.

## Authority and ownership

One registration owns one physical link. Each API scope opens an isolated virtual session on B.
B intersects forwarded session permissions with the authenticated physical link's permissions.
A replaces the routed hello's identity and grants with the admitted caller's values. A network hello
cannot declare itself routed. Legacy sessions with narrower RPC scopes cannot delegate host authority.
A routed session cannot open another route or manage B's saved hosts. Saving B gives B no access to A.

Dispose an SDK API scope to release its sessions and observations. Sibling scopes and the saved link
remain. Losing the physical link rejects submitted requests with `DAEMON_CONNECTION_LOST`,
`outcome: "unknown"`, and the destination `serverId`. Inspect B before retrying a mutation.

The limits are 32 registrations, 64 channels per link, 4 MiB queued per channel, and 32 MiB queued per
link. Channel overflow closes that channel. Forwarding acknowledgments retain output until the final
physical write drains. Binary route headers wrap the original terminal/file bytes without base64;
the header is included in the existing 100 MiB message ceiling.

## Delegation and finish observation

`list_hosts` includes this daemon and saved destinations. `create_workspace`, `list_workspaces`,
`create_agent`, `send_agent_prompt`, `get_agent_status`, `get_agent_activity`, and `list_agents`
accept an optional `serverId`. Omit it for this daemon. Remote creation requires a destination
`workspaceId` and explicit `provider/model`. Caller directories never become remote defaults.
Same-provider remote children inherit the caller's mode unless an explicit mode is supplied.

Agent-originated prompts use the shared delivery queue, including remote sends. A definitely unsent
prompt creates no finish intent. An ambiguous response retains intent because B may have admitted it.
Notifications name the destination host and child. Three failed observations end a watch with an
unknown-status notice. Connecting attempts do not spend that budget. Removing the registration
reports host unavailability. Neither notice says the child finished.

Remote intent is stored in `remote-finish-subscriptions.json` until the parent accepts notification
dispatch. It is separate from the existing local intent file because that format and its startup
reconciliation predate connected hosts. Restart restores remote observations after host links are
available. Delivery failures retain the captured outcome and retry dispatch without re-observing it.

The app discovers routed connection candidates from A and shows qualified children in the parent's
Subagents track with their host label. Opening a child uses the destination's ordinary session and
navigation, choosing a direct connection when available or the discovered route through A.
