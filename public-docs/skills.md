---
title: Orchestration skills
description: "JAgentDesk orchestration skills: teach coding agents to spawn, coordinate, and manage other agents using slash commands."
nav: Skills
order: 32
category: Orchestration
---

# Orchestration skills

JAgentDesk ships orchestration skills that teach coding agents how to use JAgentDesk tools and the CLI to spawn, coordinate, and manage other agents. Skills package common workflows as slash commands, so agents know how to orchestrate without you writing the briefing and safety rails each time.

Start with [Orchestration](/docs/orchestration) if you want the mental model, or [Common workflows](/docs/orchestration-workflows) for prompts you can use without installing skills.

## Installation

Two ways to install:

- **Desktop app:** Settings → Integrations → Install
- **Manual:** `npx skills add acme/example`, this installs to `~/.agents/skills/` and sets up symlinks for each agent.

When the desktop app finds installed JAgentDesk skills, it keeps the bundled skills up to date on startup. If automatic update fails, use Settings → Integrations → Update or the manual command above.

## `/jagentdesk`, JAgentDesk Reference

The foundational skill. JAgentDesk reference for managing agents and workspaces. Load it when an agent needs to create agents, send them prompts, or manage workspace isolation.

Not typically invoked directly by users, it's a reference that other skills depend on.

```
/jagentdesk show me the JAgentDesk CLI surface for creating an agent in a worktree-isolated workspace
```

## `/jagentdesk-handoff`, Task Handoff

Hands off the current task to another agent with full context. Use it when you say "handoff", "hand off", "hand this to", or want to pass work to another agent.

The receiving agent gets a self-contained briefing with the task, context, relevant files, current state, what's been tried, decisions, acceptance criteria, and constraints. Provider comes from orchestration preferences unless you name one. Supports worktree-isolated workspaces when you ask for one.

```
/jagentdesk-handoff hand off the auth fix to codex in a worktree-isolated workspace
/jagentdesk-handoff hand this to claude opus for review
```

## `/jagentdesk-loop`, Iterative Loops

Runs an agent loop until an exit condition is met. Use it when you say "loop", "babysit", "keep trying until", "check every X", "watch", or want iterative autonomous execution.

A loop is a worker/verifier cycle: launch a worker, check verification, repeat until done or limits hit. It can use a shell check, a verifier prompt, or both. Set a sensible `--max-iterations` or `--max-time`.

```
/jagentdesk-loop keep trying until the changed test file passes, max 5 iterations
/jagentdesk-loop babysit PR 123 until checks are green, check every 2m, max-time 1h
```

## `/jagentdesk-committee`, Committee Planning

Forms a committee of two high-reasoning agents to step back, do root cause analysis, and produce a plan. Use it when stuck, looping, tunnel-visioning, or facing a hard planning problem.

Committee members do analysis only. They do not edit, create, or delete files. The orchestrating agent synthesizes their plans, implements, then sends the diff back for review.

```
/jagentdesk-committee why are the websocket connections dropping under load?
/jagentdesk-committee plan the auth system migration
```

## `/jagentdesk-advisor`, Advisor

Spins up a single agent as an advisor, a second opinion on the current task. Use it when you say "advisor", "second opinion", "what does X think", or want an outside take without delegating the work itself.

The advisor gives a judgment. You decide what to do. The advisor prompt is analysis-only and ends with a no-edits instruction.

```
/jagentdesk-advisor did I miss anything in this migration plan?
/jagentdesk-advisor --provider claude/opus what is the UX risk in this flow?
```
