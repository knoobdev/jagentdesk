# SSH servers

JAgentDesk includes a Termius-class SSH client. The daemon opens the connections (with `ssh2`), so
sessions keep running when the app is closed and every device paired with the daemon sees the same
servers and tabs. Open it from **Servers** in the rail (desktop) or the navigation (mobile); it is
shown when the daemon advertises the `sshServers` feature.

## Data and secrets

Everything lives under `$JAGENTDESK_HOME/ssh/` (files `0600`, folders `0700`, atomic writes):
`servers.json`, `groups.json`, `identities.json`, `keys.json`, `known_hosts.json`, `snippets.json`,
`history.json`, `workspaces.json`, `forwarding.json`, `environments.json`, `logs/`. Passwords, private
keys and passphrases are stored only in the daemon secret store; the JSON files hold public data and
`hasPassword` / `hasPassphrase` flags. Nothing secret is sent to the app or written to logs.

## Connecting

1. Configuration is resolved field by field from the server and its groups (nearest group wins).
2. Proxy (SOCKS5 / HTTP CONNECT) and jump chain hops are opened first; every hop checks its host key.
3. Unknown host key → a bar with the SHA-256 fingerprint, Trust or Reject (120 s). A changed key
   blocks with `host_key_mismatch` and both fingerprints; "trust new key" replaces it.
4. Authentication in the server's order: password, key, keyboard-interactive (prompts appear in the
   tab, answers are not stored).
5. Environment variables, PTY `xterm-256color`, shell, startup snippet, forwarding rules marked
   "open on connect".
6. Keepalive; on loss with auto-reconnect: 1, 2, 4, 8, 16, 30 s, then every 30 s for up to 10 minutes.

Telnet servers (`protocol: telnet`, port 23) use a plain TCP connection and are marked unencrypted.

## Server screen

Header: status dot, `user@host:port`, detected environment, **Type password**, **Disconnect**, and a
menu with Re-detect, Install public key and Edit server. Tabs: **Terminal**, **SFTP**, **Port
forwarding**, **Snippets**, **Docker** (only when the server has Docker), **Logs**. Keychain, Known
hosts, Snippets and Port forwarding also have their own tabs on the Servers screen.

## Chat agent for a server

A chat started from a server gets SSH tools bound to that server: `ssh_run`, `ssh_read_file`,
`ssh_write_file`, `ssh_list_dir`, `ssh_terminal_send`, `ssh_terminal_capture`,
`ssh_forward_start`, `ssh_forward_stop`, and the Docker tools with `serverId`. Tools that change the
server ask for permission; reads (file reads up to 1 MB, output cut at 64 KB per stream) do not. The
agent's system prompt includes the detected environment.

## Docker, databases and Kubernetes on the server

- **Docker:** the daemon forwards `/var/run/docker.sock` over `direct-streamlocal@openssh.com` on
  demand and shows the existing Docker cockpit for that server. The server's `sshd` must allow TCP
  forwarding (`AllowTcpForwarding`), and the user must be able to open the socket (for example,
  member of the `docker` group); otherwise the error is `forwarding_refused` or
  `docker_socket_denied`. All `docker/*` requests accept an optional `serverId`.
- **Databases:** "Add database via this server" (`ssh.remote_db.prepare`) opens a stable local port to
  the database as seen from the server and adds it to Databases; the forward is reopened on connect.
- **Kubernetes:** "Import Kubernetes cluster via this server" (`ssh.remote_k8s.import`) reads the
  kubeconfig on the server over SFTP, keeps its credentials in the secret store and connects
  through a forward with `tls-server-name` set to the original API host.

## RPC

All requests use the `ssh.*` namespace and need `daemon.manage`: servers, groups, identities, keys
(`install_to_server`), known hosts, `hostkey.respond`, `auth.respond`, `session.create`, `sftp.*`,
`transfer.*`, `forward.*`, `snippets.*`, `snippet.run|cancel|get_run|list_runs`, `history.*`,
`workspaces.*`, `logs.*`, `import.preview|apply`, `environment.detect`, `docker.attach|detach`,
`remote_db.prepare`, `remote_k8s.import`. Pushes: `ssh.hostkey.prompt`, `ssh.auth.prompt`,
`ssh.connection.state`, `ssh.session.activity`, `ssh.transfer.progress`, `ssh.forward.state`,
`ssh.snippet.output`, `ssh.snippet.state`. Product contract: spec 25 in the spec repository.

## Acceptance check

`node packages/server/scripts/ssh-acceptance.mjs [--keep] [--port N]` builds a throwaway topology
of OpenSSH and PostgreSQL containers, starts a real daemon with its own home on a free port, and
checks the 14 acceptance criteria end to end (it never uses port 6767).
