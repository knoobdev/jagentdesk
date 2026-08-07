---
title: CLI
description: "JAgentDesk CLI reference: manage agents, workspaces, scripts, schedules, daemons, and permissions from your terminal."
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

## Running agents

Use `jagentdesk run` to start a new agent with a task:

```bash
jagentdesk run "implement user authentication"
jagentdesk run --provider codex "refactor the API layer"
jagentdesk run --background "run the focused test suite"
jagentdesk run --new-workspace worktree --worktree-mode branch-off --new-branch feature/x --base main "implement feature X"
jagentdesk run --workspace <workspace-id> "review the current diff"
jagentdesk run --output-schema schema.json "extract release notes"
jagentdesk run --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' "summarize release notes"
```

From a human shell, a bare `jagentdesk run` creates a new local workspace for the current directory. Use `--workspace <id>` to add the agent to an existing workspace, or `--new-workspace local|worktree` to explicitly create a separate workspace for the run.

Worktree creation accepts `--worktree-mode branch-off|checkout-branch|checkout-pr` plus the matching `--new-branch`/`--base`, `--branch`, or `--pr-number`/`--forge` options. Use `--worktree-slug` to choose the managed directory slug.

When an existing JAgentDesk agent runs the same command, JAgentDesk recognizes it through `JAGENTDESK_AGENT_ID`. Without explicit placement, the new agent becomes its subagent in the same workspace. `--workspace` can place that subagent elsewhere without changing its parent.

Use `--output-schema` to return only matching JSON output. You can pass a schema file path or an inline JSON schema object. This mode cannot be used with `--background`.

By default, `jagentdesk run` waits for completion. Use `--background` to return immediately while the agent keeps running.

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
  --base main

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

Then list, use, or archive it:

```bash
jagentdesk workspace ls
jagentdesk run --workspace <workspace-id> "implement authentication"
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
jagentdesk daemon stop              # Stop the daemon
```

Use `JAGENTDESK_HOME` to run multiple isolated daemon instances.

## Connecting to a remote daemon

`--host` accepts either a local target (`host:port`, a unix socket, or a Windows pipe) or a
Tailscale endpoint. A pairing offer URL (`jagentdesk://app/#offer=...`) is only the application
authorization hand-off; after pairing, the CLI dials the daemon's tailnet address directly.

Get an offer URL from the daemon you want to control:

```bash
jagentdesk daemon pair          # prints the QR/link and waits for device confirmation
jagentdesk daemon pair --json   # structured output; never prompts
```

The daemon must be logged into the same tailnet as the client. Pairing authorizes the device at
the application layer; Tailscale supplies the encrypted network path. See [Security](/docs/security).

Use it from anywhere:

```bash
jagentdesk ls --host 'jagentdesk://app/#offer=eyJ2IjozLC...'
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

- `--host <target>`, connect to a different daemon (`host:port`, unix socket, or tailnet endpoint). See [Connecting to a remote daemon](#connecting-to-a-remote-daemon).
- `--json`, JSON output
- `-q, --quiet`, minimal output
- `--no-color`, disable colors
