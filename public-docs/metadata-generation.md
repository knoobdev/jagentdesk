---
title: Metadata generation
description: How JAgentDesk uses providers to generate commit messages and pull request text, and how to configure them.
nav: Metadata generation
order: 42
category: Configuration
---

# Metadata generation

When you commit or open a pull request without writing the text yourself, JAgentDesk asks a language model to draft it. This is separate from the agent you're talking to: it's a small, one-shot call made only for that commit or pull request.

JAgentDesk generates these kinds of metadata with a model:

- **Commit messages** — a concise message for the changes you're committing, when you leave the message empty.
- **Pull request title and body** — drafted from the diff when you open a PR and leave either field empty.

Workspace titles and worktree branch names do not use a model. JAgentDesk derives them from the first line of the first prompt (or its attachments), so creating an agent never starts a second provider process or spends tokens.

## How a model is chosen

JAgentDesk has two modes. **Automatic** is the default and needs no configuration. **Manual** uses only the models you choose.

In Automatic mode, JAgentDesk builds an ordered list of candidates and tries each one until a generation succeeds, so a slow or unavailable model falls through to the next:

1. **Built-in defaults**, matched against the models of the providers you have enabled:
   1. a `haiku` model
   2. `gpt-5.4-mini` (low reasoning)
   3. `minimax-m3`
   4. `nemotron-3-super`
2. **The model currently selected** for that agent or draft, as a last resort.

Each default is a match on the model id or name, so the first enabled provider that ships a matching model wins. Defaults with no match are skipped. Duplicates are removed, then generation tries the list top to bottom. The default order prefers small, fast, cheap models for these short tasks before falling back to whatever you have selected.

In Manual mode, JAgentDesk tries only your configured models, in your order. It never adds the built-in defaults or the selected model, so your prompts and diffs only go to providers you chose. If every configured model fails, generation fails: commits and pull requests get placeholder text. Pick a model that works for these tasks.

Every failure is written to `$JAGENTDESK_HOME/daemon.log` (`~/.jagentdesk/daemon.log` by default) with the provider, the model and the error. Look there when a manual model doesn't produce commit messages or pull request text.

## Choose a model

Open **Settings → Host → Workspaces** and select **Automatic** or **Manual**. In Manual mode, pick the model JAgentDesk uses. Choosing a model replaces the first entry in `agents.metadataGeneration.providers` and preserves the rest of the list. Switching back to Automatic clears the list.

## Configure a custom fallback order

To use more than one model in Manual mode, list them in `agents.metadataGeneration.providers` in `~/.jagentdesk/config.json`. JAgentDesk tries your entries in order and nothing else. An empty list means Automatic.

```json
{
  "agents": {
    "metadataGeneration": {
      "providers": [
        { "provider": "claude", "model": "claude-haiku-4-5-20251001", "thinkingOptionId": "low" },
        { "provider": "opencode" }
      ]
    }
  }
}
```

Each entry accepts:

- `provider` (required) — the provider id. Built-in ids are `claude`, `codex`, `copilot`, `opencode`, and `pi`; custom providers use the id you gave them.
- `model` (optional) — a specific model id. Omit it to use that provider's default model.
- `thinkingOptionId` (optional) — a reasoning/thinking level for models that support one. Falls back to the model's default if the value isn't valid for that model.

The Settings screen replaces only the first entry and preserves the rest of a custom list. Restart the daemon after editing the file directly.

## Host-wide instructions

To guide all metadata generated on a host, open **Settings → Host → Workspaces** and edit **Instructions** under **Metadata generation**, or set `agents.metadataGeneration.instructions` in `~/.jagentdesk/config.json`.

```json
{
  "agents": {
    "metadataGeneration": {
      "instructions": "Write in Simplified Chinese. Keep phrasing consistent across commits and pull requests. Do not use em dashes."
    }
  }
}
```

Host instructions apply to commit messages and pull request drafts alongside JAgentDesk's default styles. Leave the field empty to use the defaults only. If a project sets its own `jagentdesk.json` style instructions, both apply and the project style takes precedence when they conflict. The JSON output format always applies.

## Per-project instructions

You can steer the wording of each kind of metadata per repository with a `jagentdesk.json` file at your repo root. JAgentDesk reads it from the committed version of the base branch, the same way it reads worktree config.

```json
{
  "metadataGeneration": {
    "title": { "instructions": "Keep titles to a few words, no leading verb." },
    "branchName": { "instructions": "Use the format <type>/<scope>-<short-desc>." },
    "commitMessage": { "instructions": "Follow Conventional Commits." },
    "pullRequest": { "instructions": "Include a Testing section in the body." }
  }
}
```

Each key is optional; only the ones you set are affected. `title` and `branchName` are read only by older hosts that generated workspace names with a model; current hosts derive names without one. Your instructions **replace** the default style for that metadata type — they are not appended to it — so your wording never competes with JAgentDesk's defaults. The functional requirements (what to produce and the output format) always apply and cannot be overridden.
