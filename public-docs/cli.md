---
title: CLI
description: "JAgentDesk CLI reference: manage projects, workspaces, agents, plugins, scripts, schedules, daemons, and permissions from your terminal."
nav: CLI
order: 3
category: Getting started
---

# CLI

The JAgentDesk CLI lets you manage agents from your terminal. It's the same interface exposed by the daemon's API, so anything you can do in the app you can do from the command line.

> **Agent orchestration:** You can tell coding agents to use the JAgentDesk CLI to spawn and manage other agents. JAgentDesk recognizes the calling agent, so CLI-created workers get the same workspace and parent defaults as MCP-created workers.

## Quick reference

```bash
jagentdesk run "fix the tests"            # Start an agent
jagentdesk ls                             # List running agents
jagentdesk attach <id>                    # Stream agent output
jagentdesk send <id> "also fix linting"   # Send follow-up task
jagentdesk logs <id>                      # View agent timeline
jagentdesk stop <id>                      # Stop an agent
```

## Provider diagnostics

Ask the daemon to inspect the provider environment it actually uses:

```bash
jagentdesk provider diagnostic claude
jagentdesk provider diagnostic codex --json
jagentdesk provider diagnostic opencode --host devbox:6767
```

The diagnostic includes the configured command, daemon `PATH` and shell, matching binaries, resolved path, version, model count, and provider status. Use `--host` for a remote daemon. This is the same diagnostic shown under **Settings → your host → Providers → provider → Diagnostic**.

## Running agents

Use `jagentdesk run` to start a new agent with a task:

```bash
jagentdesk run "implement user authentication"
jagentdesk run --provider codex "refactor the API layer"
jagentdesk run --background "run the focused test suite"
jagentdesk run --new-workspace worktree --worktree-mode branch-off --new-branch feature/x --base origin/main "implement feature X"
jagentdesk run --workspace <workspace-id> "review the current diff"
jagentdesk run --output-schema schema.json "extract release notes"
jagentdesk run --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' "summarize release notes"
```

From a human shell, a bare `jagentdesk run` creates a new local workspace for the current directory. Use `--workspace <id>` to add the agent to an existing workspace, or `--new-workspace local|worktree` to explicitly create a separate workspace for the run.

Worktree creation accepts `--worktree-mode branch-off|checkout-branch|checkout-pr` plus the matching `--new-branch`/`--base`, `--branch`, or `--pr-number`/`--forge` options. Use `--worktree-slug` to choose the managed directory slug.

When an existing JAgentDesk agent runs the same command, JAgentDesk recognizes it through `JAGENTDESK_AGENT_ID`. Without explicit placement, the new agent becomes its subagent in the same workspace. `--workspace` can place that subagent elsewhere without changing its parent.

Use `--output-schema` to return only matching JSON output. You can pass a schema file path or an inline JSON schema object. This mode cannot be used with `--background`.

By default, `jagentdesk run` waits for completion. Use `--background` to return immediately while the agent keeps running.

## Projects

Register the current directory as a project, then list the projects known to the daemon:

```bash
cd ~/dev/my-app
jagentdesk project create
jagentdesk project ls
```

Use the project ID from `jagentdesk project ls` to rename, reset, or delete a project:

```bash
jagentdesk project rename <project-id> "My app"
jagentdesk project rename <project-id> --reset
jagentdesk project delete <project-id>
```

`--reset` restores the name derived from the project directory. Deleting a project archives its active workspaces and removes the project from JAgentDesk. It does not delete the project directory.

For a local daemon, `jagentdesk project create [path]` defaults to the current directory and resolves relative paths on the CLI machine. When you use `--host` or `JAGENTDESK_HOST`, provide a path that the target daemon can access:

```bash
jagentdesk project create /srv/repos/api --host devbox:6767
```

The remote daemon interprets that path on its own machine. See [Workspaces](/docs/workspaces) for how projects group working directories and sessions.

## Workspaces

Create a workspace independently when you want to prepare its files before starting an agent:

```bash
jagentdesk workspace create --isolation local --path ~/dev/my-app --title main

jagentdesk workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode branch-off \
  --new-branch feature/auth \
  --worktree-slug feature-auth \
  --base origin/main

jagentdesk workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode checkout-branch \
  --branch feature/existing \
  --worktree-slug existing-copy

jagentdesk workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode checkout-pr \
  --pr-number 2186
```

Then list, use, rename, or archive it:

```bash
jagentdesk workspace ls
jagentdesk run --workspace <workspace-id> "implement authentication"
jagentdesk workspace rename <workspace-id> "Auth rework"
jagentdesk workspace rename <workspace-id> --reset   # back to the branch or directory name
jagentdesk workspace archive <workspace-id>
```

Add `--forge <name>` to PR checkout when JAgentDesk cannot infer the forge from the source checkout. See [Git worktrees](/docs/worktrees) for setup hooks and services.

## Workspace scripts

List, start, and stop the scripts configured in a workspace's `jagentdesk.json`:

```bash
jagentdesk script ls
jagentdesk script start web
jagentdesk script stop web
```

By default, JAgentDesk selects the workspace whose directory is the current directory. Pass `--cwd <path>` to select a different directory, or `--workspace <workspace-id>` when a directory has multiple workspaces. These commands also accept `--host` and the standard output options such as `--json`.

The output includes each script's lifecycle and supervised terminal ID. Services also include their assigned port, proxy URL, and health. See [Git worktrees](/docs/worktrees#scripts-and-services) for `jagentdesk.json` configuration.

## Plugins

> **Trust every plugin you add.** `jagentdesk plugin add` and `jagentdesk plugin install` mean “I trust this codebase.” Plugin server code and Git preparation commands run unsandboxed with the daemon user's access on the daemon host; client contributions run inside JAgentDesk. Dependencies and future updates are part of that decision. With `--host`, commands run on the remote daemon host.

Create and manage trusted plugins on a daemon:

```bash
jagentdesk plugin init /absolute/path/to/plugin
jagentdesk plugin install /absolute/path/to/plugin
jagentdesk plugin add owner/repository
jagentdesk plugin add https://gitlab.com/group/repository.git --ref main
jagentdesk plugin add owner/monorepo:plugins/review
jagentdesk plugin status
jagentdesk plugin update my-plugin
jagentdesk plugin update --all
jagentdesk plugin ls
jagentdesk plugin reload my-plugin
jagentdesk plugin logs my-plugin
jagentdesk plugin disable my-plugin
jagentdesk plugin enable my-plugin
jagentdesk plugin remove my-plugin
```

GitHub shorthand checks an existing host directory first. Append `:<directory>` for a plugin in a
monorepo. `jagentdesk plugin logs <id>` returns the plugin's recent daemon-side stdout and stderr. Add `--json` for
structured entries or `--host <target>` for another daemon. See the
[Plugin reference](/docs/plugins/reference) for installation, trust, lifecycle, and log-retention
behavior.

## Listing agents

```bash
jagentdesk ls                    # Running agents in current directory
jagentdesk ls -a                 # Include completed/stopped agents
jagentdesk ls -g                 # All directories
jagentdesk ls -a -g --json       # Full list as JSON
```

## Streaming output

Use `jagentdesk attach` to stream an agent's output in real-time:

```bash
jagentdesk attach abc123   # Attach to agent (Ctrl+C to detach)
```

Agent IDs can be shortened, `abc` works if it's unambiguous.

## Sending messages

Send follow-up tasks to a running or idle agent:

```bash
jagentdesk send <id> "now run the tests"
jagentdesk send <id> --image screenshot.png "what's wrong here?"
jagentdesk send <id> --no-wait "queue this task"
```

## Viewing logs

```bash
jagentdesk logs <id>                  # Full timeline
jagentdesk logs <id> -f               # Follow (streaming)
jagentdesk logs <id> --tail 10        # Last 10 entries
jagentdesk logs <id> --filter tools   # Only tool calls
```

## Waiting for agents

Block until an agent finishes its current task:

```bash
jagentdesk wait <id>
jagentdesk wait <id> --timeout 60   # 60 second timeout
```

Useful in scripts or when one agent needs to wait for another.

## Schedules

Run an agent on a cron schedule. The CLI also accepts simple cadence presets and compiles them to cron. See [Schedules from the CLI](/docs/schedules-cli) for the full reference.

```bash
jagentdesk schedule create --every 30m --cwd ~/dev/my-app "Continue the refactor and leave a note."
jagentdesk schedule ls
jagentdesk schedule pause <id>
```

## Permissions

Agents may request permission for certain actions. Manage these from the CLI:

```bash
jagentdesk permit ls                # List pending requests
jagentdesk permit allow <id>        # Allow all pending for agent
jagentdesk permit deny <id> --all   # Deny all pending
```

## Agent modes

Change an agent's operational mode (provider-specific):

```bash
jagentdesk agent mode <id> --list   # Show available modes
jagentdesk agent mode <id> bypass   # Set bypass mode
jagentdesk agent mode <id> plan     # Set plan mode
jagentdesk agent detach <id>        # Make a subagent top-level
```

Detaching is an explicit lifecycle action, not a creation flag. The agent keeps running; only its relationship to its parent changes.

## Daemon management

```bash
jagentdesk daemon start             # Start the daemon
jagentdesk daemon start --web-ui    # Start and serve the bundled web UI
jagentdesk daemon status            # Check status
jagentdesk reload                    # Reload config.json (top-level alias)
jagentdesk daemon reload             # Reload config.json
jagentdesk daemon stop              # Stop the daemon
```

Reload validates the whole file, applies runtime-safe changes, and reports `appliedPaths`, `restartRequiredPaths`, and `overrideControlledPaths`. Human output prints `jagentdesk daemon restart` only when a changed setting needs it. Use `--json` or `--format yaml` for the structured result, and `--host` to reload a remote daemon's own configuration file. An older host that does not support reload returns an update-host error.

Use `JAGENTDESK_HOME` to run multiple isolated daemon instances.

## Hub

```bash
jagentdesk hub login [url]          # Approve and store organization-scoped CLI access
jagentdesk hub init                 # Guided setup: scaffold and deploy a starter bundle here
jagentdesk hub connect [url]        # Enroll this daemon using CLI access
jagentdesk hub projects             # List projects in the authenticated organization
jagentdesk hub status               # Show the current Hub relationship
jagentdesk hub disconnect           # End it
jagentdesk hub deploy -p <project>  # Discover, validate, and activate a Hub bundle
jagentdesk hub deploy -p <project> --dry-run # Validate without activating
jagentdesk hub logout               # Remove the active stored CLI login
```

Run deploy from the project root. It reads `.jagentdesk/hub.yml`, every direct `.jagentdesk/workflows/*.yml` file, and referenced `.jagentdesk/workflows/partials/*` files in deterministic path order. It does not search parents, accept an alternate resource path, or flatten the bundle into monolithic YAML.

Pass `-p, --project <slug>` to select the target project. `--dry-run` performs the same discovery and server validation without recording or activating a revision. Both outputs include the resolved Hub, project, and discovered workflow count.

`login` opens the Hub approval page and stores a durable organization-scoped CLI credential under `JAGENTDESK_HOME`. In an interactive terminal it then asks whether to connect this daemon and whether to initialize and deploy a starter workflow, both defaulting to yes. Declining the connection prints `jagentdesk hub connect <origin>; then jagentdesk hub init`, because the connection alone does not produce a bundle; declining only the starter prints `jagentdesk hub init`. `--json` and non-TTY login remain login-only and never prompt. The stored login is separate from the daemon relationship created by `connect`.

`init` runs the same guided setup on its own and requires a TTY. It connects the daemon, uses the organization's only project or asks which one, and lists the Hub app connections that can back a starter workflow. One usable connection is selected automatically; with several, you choose a **Trigger connection**. If none is ready, setup sends you to **Hub → Apps** and stops before selecting an agent or writing files.

Setup then asks which agent provider, model, and mode the starter should run, choosing from what the connected daemon reports. A provider is offered only when the daemon has it enabled with a selectable model. Suggested model and mode entries are the daemon's defaults; no provider is suggested merely because it appears first. The mode question is skipped for providers that expose no modes and asked explicitly when the daemon has modes but no default. Finally, setup asks for the identity that gates the chosen connection: a GitHub username, a Slack member ID, or a Discord user ID. It writes `.jagentdesk/hub.yml` and `.jagentdesk/workflows/<provider>-help.yml`, validates them against Hub, and deploys. An existing `.jagentdesk/` directory is replaced only after you confirm. See the [generated starter bundle](/docs/hub/configuration#generated-starter-bundle).

Interactive logout checks the same-origin daemon relationship and asks whether to disconnect before deleting the login. Declining removes only the login. JSON and noninteractive logout never prompt or disconnect implicitly; `--disconnect-daemon` is the explicit automation path, and `--force` applies to that daemon disconnection. If a requested disconnection fails, the login is preserved.

Every command resolves and normalizes its destination before Hub or daemon work. Origin precedence is an explicit command origin or `--hub`, then `JAGENTDESK_HUB_URL`, then the active stored login origin, then the hosted default `https://hub.jagentdesk.local`. The hosted default never overrides an active login. Credential precedence is `--api-key <secret>`, then `JAGENTDESK_HUB_API_KEY`, then a stored login for the exact resolved origin. A stored credential is never sent to a different origin. API keys passed through flags or the environment are not stored.

Human output reports the resolved destination before each action. JSON output keeps stdout machine-readable and includes the normalized Hub origin. Bundle diagnostics identify paths without printing configuration contents or credentials.

See [Daemons in Hub](/docs/hub/daemons), [Hub configuration](/docs/hub/configuration), and the [Hub public API](/docs/hub/api).

## Connecting to a remote daemon

`--host` accepts either a local target (`host:port`, a unix socket, or a Windows pipe) or a pairing offer URL, the same `https://app.jagentdesk.local/#offer=...` link the mobile app uses for QR pairing. With an offer URL the CLI connects through the JAgentDesk relay with end-to-end encryption, so you can drive a daemon on another machine without exposing it to the network.

Get an offer URL from the daemon you want to control:

```bash
jagentdesk daemon pair          # asks before enabling relay, then prints the QR and link
jagentdesk daemon pair --relay  # enables relay without prompting
jagentdesk daemon pair --json   # structured output; never prompts
```

Relay is off for new installations. In non-interactive or JSON mode, a disabled relay returns a `RELAY_DISABLED` error; pass `--relay` to provide explicit consent. Relay pairing is end-to-end encrypted. See [Security](/docs/security).

Use it from anywhere:

```bash
jagentdesk ls --host 'https://app.jagentdesk.local/#offer=eyJ2IjoyLC...'
jagentdesk run --host "$OFFER_URL" "fix the failing tests"
```

You can also set it once via `JAGENTDESK_HOST` instead of passing `--host` on every command.

## Multi-agent workflows

The CLI is designed to be used by agents themselves. You can instruct an agent to spawn sub-agents for parallel work:

```bash
# Agent A spawns Agent B and waits for it
agent_id=$(jagentdesk run --background --quiet --title api-agent "implement the API")
jagentdesk wait "$agent_id"
jagentdesk logs "$agent_id" --tail 5
```

Because Agent A's ID is present in the environment, Agent B is created as its subagent in the same workspace unless `--workspace` is specified.

Simple implement + verify loop:

```bash
# Requires jq
while true; do
  jagentdesk run --provider codex "make the tests pass" >/dev/null

  verdict=$(jagentdesk run --provider claude --output-schema '{"type":"object","properties":{"criteria_met":{"type":"boolean"}},"required":["criteria_met"],"additionalProperties":false}' "ensure tests all pass")
  if echo "$verdict" | jq -e '.criteria_met == true' >/dev/null; then
    echo "criteria met"
    break
  fi
done
```

This pattern enables hierarchical task decomposition, a lead agent can break down work, delegate to specialists, and synthesize results.

## Output formats

Most commands support multiple output formats for scripting:

```bash
jagentdesk ls --json                # JSON output
jagentdesk ls --format yaml         # YAML output
jagentdesk ls -q                    # IDs only (quiet)
```

## Global options

- `--host <target>`, connect to a different daemon (`host:port`, unix socket, or `https://app.jagentdesk.local/#offer=...` for relay). See [Connecting to a remote daemon](#connecting-to-a-remote-daemon).
- `--json`, JSON output
- `-q, --quiet`, minimal output
- `--no-color`, disable colors
