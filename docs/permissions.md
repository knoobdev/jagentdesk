# Daemon permissions

The daemon authorizes principals with semantic permissions. RPC names and protocol namespaces are not authority.

## Model

```text
principal -> grants
    |
    +-- authenticated by a device or service credential
    `-- opens a session with equal or narrower authority
```

A principal is the durable identity the daemon authorizes. A credential proves that a device or service represents it. Keep them separate so you can rotate credentials, attach more than one device, and revoke a Hub user without inventing daemon user accounts.

A pairing invitation is neither. It is an expiring, single-use exchange that creates a principal and credential with the permissions selected by its issuer.

Sessions still carry an RPC scope list for session-share guests and the legacy Hub bridge
(`packages/server/src/server/authorization/guest-scopes.ts`). An inbound message must pass both the
scope list and the permission check (`allowsInbound` in `packages/server/src/server/session.ts`).
Do not add new scope-based gates; classify the operation in
`packages/server/src/server/authorization/operation-permissions.ts`.

## Permissions

| Permission          | Authority                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| `daemon.read`       | Daemon status, diagnostics, configuration, and provider information        |
| `daemon.manage`     | Restart, update, configuration changes, providers, skills, and plugins     |
| `tunnel.manage`     | Relay, Hub, service tunnel, and public endpoint relationships              |
| `access.manage`     | Pairing invitations, principals, credentials, grants, and revocation       |
| `workspace.read`    | Projects, workspaces, agents, timelines, files, diffs, and terminal output |
| `workspace.write`   | Prompts, agent control, files, terminals, git operations, and scripts      |
| `workspace.manage`  | Create, rename, archive, and remove projects and workspaces                |
| `automation.manage` | Schedules, heartbeats, and loops                                           |
| `hub.execute`       | The Hub-owned execution lifecycle                                          |

Agents and terminals use workspace authority. Both can execute code and mutate the workspace, so separate write permissions would claim an isolation boundary the daemon cannot enforce.

Role names such as owner or viewer are UI presets at most. Expand them into explicit permissions and do not persist them as roles. Adding a permission must not silently widen an existing principal.

Permissions are additive allows. Missing authority denies the operation. Do not add deny precedence.

## Resources

Permissions are daemon-wide today. Future grants may select workspaces or agents, but operation classification remains inside the authorization module:

```ts
type Grant = {
  permission: Permission;
  resource: { kind: "daemon" } | { kind: "workspace"; ids: string[] };
};
```

A delegating principal can grant only authority it already possesses. A session may attenuate its principal's grants but cannot widen them.

Workspace-scoped grants require every resource-bearing operation and outbound observation to enforce the same workspace boundary. File preview currently accepts any daemon-readable regular file, so it must gain resource enforcement before workspace-specific access ships.

[Connected hosts](connected-hosts.md#authority-and-ownership) carry the intersection of the caller
session and paired link permissions. Host management requires `daemon.manage`.

## Device pairing

New desktop, mobile and daemon devices use the same two-sided SAS exchange. Open a
session from an authenticated host, compare the derived six digits, and approve on
both screens. The exchange expires after two minutes. The former host-code entry
path cannot enroll a new device, so apps older than v0.10.0 cannot pair a new device
with a v0.10.0 daemon; update the app and generate a new link. Existing paired keys
keep working.

The daemon holds one attempt at a time. A new link replaces the open one, and the
first device to send `pair_hello` owns it until it ends. If that device's socket drops,
the attempt ends; reconnecting cannot resume it, so the device needs a new link. Every
refusal and every host-side end reaches the device as `pair_error` with a `reason`
(`replaced`, `expired`, `in_use`, `connection_lost`, …) before the socket closes, and
the daemon logs each step as `pairing_sas_*` without keys, nonces or codes. Relays
replace the daemon's close code, so the close alone cannot tell the device why.

The device pings every 10 seconds while the user compares codes. Mobile networks and
suspended apps drop a silent socket in well under the two-minute window. Anything
that starts an exchange must start it once per link: the desktop "Pair a device"
panel begins an attempt only when it opens or the user asks for a new code, never
when the host runtime swaps its client, and a phone opens one exchange per link.

A tailnet enrollment pins the verified connection's node identity for every device
kind. The Go tsnet bridge looks up the peer with WhoIs before it reads any
application bytes (`packages/server/go/tsnet-bridge/main.go`). A missing bridge
identity fails closed. Reconnecting must never replace a
stored pin; removing a Tailscale node requires pairing again. A tag on only one side
can make WhoIs report different accounts even within the same tailnet.

## Hub

The Hub authenticates as a service principal. Its locally selected grants decide whether it may execute agents, manage the daemon, manage tunnels, or manage access.

Hub user and role identifiers remain opaque external subjects. The Hub may create and revoke linked daemon principals when granted `access.manage`; the daemon does not interpret accounts, organizations, or roles.

Hub enrollment and permission updates exchange these semantic permissions directly. Legacy persisted Hub relationships that contain `hub.execution.*` migrate once to `hub.execute` when the daemon loads them; new relationships never persist or emit transport scopes as authority.
