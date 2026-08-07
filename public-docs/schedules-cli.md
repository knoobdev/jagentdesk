---
title: Schedules from the CLI
description: Create and manage JAgentDesk schedules with jagentdesk schedule.
nav: CLI
order: 27
category: Schedules
---

# Schedules from the CLI

`jagentdesk schedule` creates and manages new-agent [schedules](/docs/schedules) from your terminal, useful for headless boxes and scripts. Every run starts a fresh agent.

## Create

Overnight refactor on Codex:

```bash
jagentdesk schedule create \
  --every 30m \
  --name overnight-refactor \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  --max-runs 16 \
  --expires-in 10h \
  "Continue the refactor. Run the focused checks. Leave a short status note."
```

Long build babysitter on Claude:

```bash
jagentdesk schedule create \
  --every 5m \
  --name build-watch \
  --provider claude/opus-4.7 \
  --cwd ~/dev/my-app \
  --max-runs 24 \
  "Check the release build. If it failed, inspect logs, fix the cause, and rerun."
```

Daily GitHub triage on GLM through OpenCode:

```bash
jagentdesk schedule create \
  --cron "0 14 * * 1-5" \
  --timezone UTC \
  --run-now \
  --name github-triage \
  --provider opencode/openrouter/glm-5.1 \
  --cwd ~/dev/my-app \
  "Triage GitHub issues, PRs, and failing checks. Summarize what needs attention."
```

Morning triage at 9 AM in New York, including daylight saving time changes:

```bash
jagentdesk schedule create \
  --cron "0 9 * * 1-5" \
  --timezone America/New_York \
  --name morning-triage \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  "Review overnight CI failures and summarize anything urgent."
```

## Heartbeats

Inside a running JAgentDesk agent, create a heartbeat for that same conversation:

```bash
jagentdesk heartbeat create \
  --cron "*/20 * * * *" \
  --name heartbeat \
  "Check the current task state and continue with the next useful step."
```

The heartbeat interface is deliberately small:

```bash
jagentdesk heartbeat update <id> --cron "*/10 * * * *"
jagentdesk heartbeat delete <id>
```

Updating a heartbeat changes only its cron cadence and optional time zone. Its target and prompt stay fixed. Heartbeat commands require `JAGENTDESK_AGENT_ID`, which JAgentDesk sets inside agent sessions.

Heartbeats require a raw `--cron` expression. The `--every` presets below are available only for new-agent schedules.

## Manage

```bash
jagentdesk schedule ls
jagentdesk schedule inspect <id>
jagentdesk schedule logs <id>
jagentdesk schedule pause <id>
jagentdesk schedule resume <id>
jagentdesk schedule run-once <id>
jagentdesk schedule update <id> --every 10m --max-runs 6
jagentdesk schedule delete <id>
```

## Cadence

Use `--cron "<expr>"` for a 5-field cron expression. For common cron-compatible cadences, `--every <duration>` accepts presets such as `5m` or `1h` and compiles them to cron. It does not create a rolling interval anchored to creation time.

Schedules default to UTC. Pass `--timezone <IANA>` to interpret cron fields in a local wall-clock time zone, for example `--timezone America/New_York`. The persisted `nextRunAt` is still a UTC instant, but it is computed from that local time zone so recurring jobs stay at the same local time across daylight saving time changes.

Schedules wait for the next matching cron time by default. Pass `--run-now` to start one immediate run on creation.

When targeting a remote daemon with `--host`, pass `--cwd`; your local working directory may not exist on the remote machine.
