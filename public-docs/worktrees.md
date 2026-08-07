---
title: Git worktrees
description: Run agents in isolated git worktrees with setup hooks, scripts, and long-running services.
nav: Git worktrees
order: 11
category: Workspaces
---

# Git worktrees

Git worktrees are one kind of workspace.

A [workspace](/docs/workspaces) is the place where a task happens. When that workspace is backed by a git worktree, JAgentDesk creates a separate directory on a separate branch so parallel agents never step on each other.

This page covers the git-specific details: where worktrees live, how branches are chosen, and how to configure setup hooks, scripts, terminals, and long-running services through `jagentdesk.json`.

## Layout and workflow

Worktrees live under `$JAGENTDESK_HOME/worktrees/` by default, grouped by a hash of the source checkout path. You can change the base directory with `worktrees.root` in `config.json`. Each worktree gets a slug and a branch when its workspace is created.

```
~/.jagentdesk/worktrees/
└── 1vnnm9k3/               # hash of source checkout path
    ├── tidy-fox/           # worktree slug
    └── bold-owl/
```

With a custom root, JAgentDesk keeps the same hashed layout under that directory:

```json
{
  "worktrees": {
    "root": "/mnt/fast/jagentdesk-worktrees"
  }
}
```

1. Create a workspace with worktree isolation, JAgentDesk creates the worktree and runs your setup hooks
2. Launch one or more agents in that workspace
3. Review the diff against the base branch
4. Merge or archive the workspace; after the last workspace using it is archived, JAgentDesk runs teardown and removes the worktree

## Create a worktree-backed workspace

The examples below use the current directory as the source checkout. Pass `--path ~/dev/my-app` to create the workspace from another checkout.

Branch off from a base branch:

```bash
jagentdesk workspace create \
  --isolation worktree \
  --mode branch-off \
  --new-branch feature/auth \
  --worktree-slug feature-auth \
  --base main
```

Check out an existing branch:

```bash
jagentdesk workspace create \
  --isolation worktree \
  --mode checkout-branch \
  --branch feature/existing \
  --worktree-slug existing-copy
```

Or open a pull request in its own workspace:

```bash
jagentdesk workspace create \
  --isolation worktree \
  --mode checkout-pr \
  --pr-number 2186
```

Add `--forge <name>` when JAgentDesk cannot infer the forge from the source checkout.

## jagentdesk.json

Drop a `jagentdesk.json` in your repo root. JAgentDesk reads it from the committed version of the base branch you picked, so uncommitted changes in other branches don't apply.

```json
{
  "worktree": {
    "setup": "npm ci",
    "teardown": "rm -rf .cache"
  },
  "scripts": {
    "test": { "command": "npm test" },
    "web": { "command": "npm run dev", "type": "service", "port": 3000 }
  }
}
```

## Setup and teardown

`setup` runs once after the worktree is created. A fresh worktree has no installed dependencies and no ignored files (like `.env`), so use setup to install and copy what you need. `teardown` runs during archive, before the directory is removed.

```json
{
  "worktree": {
    "setup": "npm ci\ncp \"$JAGENTDESK_SOURCE_CHECKOUT_PATH/.env\" .env\nnpm run db:migrate",
    "teardown": "npm run db:drop || true"
  }
}
```

Both fields accept a multiline shell script or an array of commands; commands run sequentially either way.

Commands run with the worktree as `cwd`. Use `$JAGENTDESK_SOURCE_CHECKOUT_PATH` to reach files in the original checkout (untracked config, local caches, etc).

## Scripts and services

`scripts` are named commands you can run inside a worktree on demand. Mark one as a _service_ and JAgentDesk supervises it as a long-running process, assigns it a port, and routes HTTP traffic to it through the daemon's reverse proxy.

Run them from the app, or manage them from automation with [`jagentdesk script`](/docs/cli#workspace-scripts) and the [workspace-script MCP tools](/docs/mcp#workspace-scripts).

### Plain scripts

```json
{
  "scripts": {
    "test": { "command": "npm test" },
    "lint": { "command": "npm run lint" },
    "generate": { "command": "npm run codegen" }
  }
}
```

### Services

```json
{
  "scripts": {
    "web": {
      "type": "service",
      "command": "npm run dev -- --port $JAGENTDESK_PORT",
      "port": 3000
    },
    "api": {
      "type": "service",
      "command": "npm run api -- --port $JAGENTDESK_PORT"
    }
  }
}
```

Omit `port` to let JAgentDesk auto-assign one. Bind your process to `$JAGENTDESK_PORT` rather than hard-coding, each worktree gets a distinct port so multiple copies of the same service coexist.

### Dynamic port allocation

By default, JAgentDesk asks the OS for an available ephemeral port. Configure a range globally in
`~/.jagentdesk/config.json` or per project in `jagentdesk.json`:

```json
// ~/.jagentdesk/config.json
{
  "worktrees": {
    "servicePorts": { "range": "3000-4000" }
  }
}
```

```json
// jagentdesk.json
{
  "worktree": {
    "servicePorts": { "range": "3000-4000" }
  }
}
```

The range is inclusive. A project `servicePorts` block replaces the global block. An explicit
service `port` always wins over either setting.

For an external allocator, configure `portScript` instead:

```json
{
  "worktree": {
    "servicePorts": { "portScript": "/usr/bin/portmake" }
  }
}
```

JAgentDesk runs the executable in the workspace directory with four arguments: service name, workspace
ID, branch name, and worktree path. Since the script is executed directly without a shell, `portScript` must point to a real executable (such as a compiled binary or a script with a proper shebang line like `#!/bin/bash`) rather than an inline shell command or pipeline. If you need shell evaluation or pipelines, wrap them in a small executable script. A missing branch is passed as an empty string. The same values
are available as `JAGENTDESK_SCRIPTNAME`, `JAGENTDESK_WORKSPACE_ID`, `JAGENTDESK_BRANCH_NAME`, and
`JAGENTDESK_WORKTREE_PATH`. It must print one valid TCP port to stdout. `portScript` wins over `range` in
the same block. JAgentDesk trusts the external allocator, so the returned port may already be in use, for
example by a service JAgentDesk will attach to.

### Reverse proxy

Every service is reachable through the daemon at a deterministic hostname:

```
http://<script>--<branch>--<project>.localhost:<daemon-port>

# on the default branch, the branch label is dropped:
http://<script>--<project>.localhost:<daemon-port>
```

`*.localhost` resolves to `127.0.0.1` on modern systems, so these URLs work out of the box. The proxy supports WebSocket upgrades.

### Service-to-service

Services launched from the same workspace see each other's ports and proxy URLs. Given `web` and `api` above, each process gets:

```
JAGENTDESK_PORT=3000                         # this service's port
JAGENTDESK_URL=http://web--my-app.localhost:6767  # this service's proxy URL
JAGENTDESK_SERVICE_API_PORT=51732
JAGENTDESK_SERVICE_API_URL=http://api--my-app.localhost:6767
JAGENTDESK_SERVICE_WEB_PORT=3000
JAGENTDESK_SERVICE_WEB_URL=http://web--my-app.localhost:6767
```

Script names are upper-cased and non-alphanumerics become `_`. Point your frontend at `$JAGENTDESK_SERVICE_API_URL` instead of hard-coding a port.

## Terminals

Open terminals automatically when a worktree is created. Useful for tailing logs or leaving a REPL ready to go.

```json
{
  "worktree": {
    "terminals": [
      { "name": "logs", "command": "tail -f dev.log" },
      { "name": "shell", "command": "bash" }
    ]
  }
}
```

## Environment variables

Setup, teardown, scripts, and services all see:

- `$JAGENTDESK_SOURCE_CHECKOUT_PATH`, the original repo root
- `$JAGENTDESK_WORKTREE_PATH`, the worktree directory
- `$JAGENTDESK_BRANCH_NAME`, the worktree's branch
- `$JAGENTDESK_WORKTREE_PORT`, legacy per-worktree port (prefer `$JAGENTDESK_PORT` inside services)

Services additionally get:

- `$JAGENTDESK_PORT`, this service's assigned port
- `$JAGENTDESK_URL`, this service's proxy URL
- `$JAGENTDESK_SERVICE_<NAME>_PORT` / `_URL`, peer service ports and URLs
- `$HOST`, `127.0.0.1` for local-only daemons, `0.0.0.0` when the daemon binds all interfaces

## Manage the workspace

```bash
jagentdesk workspace ls
jagentdesk run --workspace <workspace-id> "implement auth"
jagentdesk workspace archive <workspace-id>
```

For the common case, `jagentdesk run --new-workspace worktree --worktree-mode branch-off --new-branch feature/auth --base main "implement auth"` creates both the workspace and its first agent.
