# Custom providers

Provider configuration lives under `agents.providers` in `$JAGENTDESK_HOME/config.json` (`~/.jagentdesk/config.json` for the packaged daemon). Use it to override a provider's binary or environment, add profiles of a built-in provider, add ACP agents, and disable providers. The user-facing walkthrough is [public-docs/custom-providers.md](../public-docs/custom-providers.md); adding a provider in code is [providers.md](providers.md).

```json
{
  "version": 1,
  "agents": {
    "providers": {
      "provider-id": { "...": "..." }
    }
  }
}
```

Provider IDs match `/^[a-z][a-z0-9-]*$/`. The schema is `ProviderOverrideSchema` in `packages/protocol/src/provider-config.ts`.

## Entry kinds

| Kind                     | Shape                                   | Notes                                                                                                                  |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Built-in override        | ID of a built-in provider, no `extends` | Changes `command`, `env`, models, `enabled` or `order` of that provider                                                |
| Plugin provider override | ID of a provider plugin, no `extends`   | Accepted before the plugin registers. Plugins with `requiresConfiguration` (goose, Hoplite, fx) activate only with one |
| Profile                  | `extends: "<built-in>"` and `label`     | A separate provider entry that inherits the base adapter                                                               |
| ACP agent                | `extends: "acp"`, `label`, `command`    | Generic ACP client; see [ACP agents](#acp-agents)                                                                      |
| API provider             | `api` block                             | Written by the Custom API providers plugin; see [Custom API providers](#custom-api-providers)                          |

Valid `extends` values are `claude`, `codex`, `copilot`, `opencode`, `pi`, `omp` and `acp`.

## Field reference

| Field              | Type                                              | Meaning                                                                                                  |
| ------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `extends`          | `string`                                          | Base provider ID, or `"acp"`                                                                             |
| `label`            | `string`                                          | Display name; required for profiles and ACP agents                                                       |
| `description`      | `string`                                          | Short description                                                                                        |
| `command`          | `string[]`                                        | Replaces the launch command (binary, then arguments); required for ACP agents                            |
| `env`              | `Record<string, string>`                          | Environment for the agent process                                                                        |
| `options`          | `Record<string, unknown>`                         | Provider options; see [Provider options](#provider-options)                                              |
| `params`           | `Record<string, unknown>`                         | Legacy name for `options` (`COMPAT(providerParams)`); if both are set, `options` wins                    |
| `models`           | `ProviderProfileModel[]`                          | Replaces the discovered model list                                                                       |
| `additionalModels` | `ProviderProfileModel[]`                          | Adds to, or relabels, the discovered list                                                                |
| `disallowedTools`  | `string[]`                                        | Provider tool names to disable, such as `WebSearch`                                                      |
| `jagentdeskTools`  | `{ enabled?: boolean, disabledTools?: string[] }` | `enabled: false` removes JAgentDesk tools from this provider's agents; `disabledTools` drops named tools |
| `enabled`          | `boolean`                                         | `false` hides the provider. OMP and plugin providers with `defaultEnabled: false` start off              |
| `order`            | `number`                                          | Sort order in the provider list                                                                          |
| `api`              | `{ protocol, baseUrl, via?, sshServerId? }`       | Daemon-managed API provider; do not write by hand                                                        |

A model entry has `id`, `label`, and optional `description`, `isDefault`, `contextWindow` and `thinkingOptions` (`id`, `label`, `description?`, `isDefault?`).

## Models

`models` replaces the runtime-discovered list. `additionalModels` merges into it; an entry with the same `id` as a discovered model updates that model in place.

The built-in `claude` provider also appends concrete model IDs from `~/.claude/settings.json`: the top-level `model` and the `env` keys `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL`. This lets users who configured Claude Code for Bedrock, OpenRouter or another gateway pick the exact ID. `agents.providers.claude.models` replaces both the first-party list and these entries; use `additionalModels` to keep them. The effort selector does not inherit `effortLevel` from Claude's settings.

## Provider options

Set provider defaults in `agents.providers.<id>.options`; agents override them with `providerOptions`. The provider validates and applies the record. Claude, Codex and OpenCode reject unknown keys with a key-specific creation error; providers without option handling ignore it.

The daemon deep-merges agent options over provider defaults at each launch or resume. Plain objects merge recursively; arrays, scalars and `null` replace the base value. Only agent overrides are persisted, so changed defaults apply at the next launch or resume. A profile inherits its base provider's options unless it sets its own `options`.

## Custom API providers

The built-in `custom-providers` plugin (`plugins/custom-providers/`) manages OpenAI- and Anthropic-compatible model servers without hand-editing config. Add them in Settings → host → Providers → Custom API providers, or let an agent use the `provider_*` tools.

| Field     | Meaning                                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name / ID | Shown in the composer; the ID follows the rule above                                                                                                                                   |
| Protocol  | OpenAI-compatible (runs through OpenCode) or Anthropic-compatible (runs through Claude Code)                                                                                           |
| Base URL  | `http` or `https`, such as `http://127.0.0.1:11434/v1`                                                                                                                                 |
| Route     | **Direct**; **JAgentDesk Tailscale** (the daemon reaches a tailnet address through its own node); **Through SSH server** (write the URL as seen from that server, such as `127.0.0.1`) |
| API key   | Stored in the daemon's encrypted secret store as `provider.apikey.<id>`; never written to `config.json` or returned                                                                    |
| Models    | **Discover models** calls `GET {baseUrl}/models` (`/v1/models` for Anthropic), or list them by hand; thinking options become reasoning settings                                        |

The daemon writes the entry under `agents.providers.<id>` with an `api` block and keeps every other key in the file. Saving, editing or deleting refreshes the composer without a restart; running agents keep the settings they started with. Entries written by hand are shown read-only.

The app uses the `providers.custom.*` RPCs. Agent tools: `provider_list` and `provider_test` run directly; `provider_add`, `provider_update` and `provider_remove` ask for permission unless the agent runs in bypass mode. Cards and tool output never contain the key. For a model served on another machine, install the server with `remote_run`, then call `provider_test` and `provider_add` with `via: "ssh"`, that server's ID and `baseUrl: "http://127.0.0.1:<port>/v1"`.

## Profiles

A profile is an entry that extends a built-in provider. Each profile is a separate provider in the app with its own credentials, environment and models:

```json
{
  "agents": {
    "providers": {
      "claude-work": {
        "extends": "claude",
        "label": "Claude (Work)",
        "env": { "ANTHROPIC_API_KEY": "sk-ant-work-..." },
        "models": [{ "id": "claude-opus-4-6", "label": "Opus 4.6", "isDefault": true }]
      }
    }
  }
}
```

### Anthropic-compatible endpoints

Extend `claude` and point `ANTHROPIC_BASE_URL` at the endpoint. These serve the vendor's own models, not Anthropic's.

| Vendor                              | `ANTHROPIC_BASE_URL`                                        | Key variable                                   |
| ----------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| Z.AI GLM Coding Plan                | `https://api.z.ai/api/anthropic`                            | `ANTHROPIC_AUTH_TOKEN`                         |
| Alibaba Model Studio, coding plan   | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` | `ANTHROPIC_AUTH_TOKEN` (plan key, `sk-sp-...`) |
| Alibaba Model Studio, pay-as-you-go | `https://dashscope-intl.aliyuncs.com/apps/anthropic`        | `ANTHROPIC_API_KEY` (`sk-...`)                 |

```json
{
  "agents": {
    "providers": {
      "zai": {
        "extends": "claude",
        "label": "ZAI",
        "env": {
          "ANTHROPIC_AUTH_TOKEN": "<your-zai-api-key>",
          "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
          "API_TIMEOUT_MS": "3000000"
        },
        "disallowedTools": ["WebSearch"],
        "models": [
          { "id": "glm-5-turbo", "label": "GLM 5 Turbo", "isDefault": true },
          { "id": "glm-5.1", "label": "GLM 5.1" }
        ]
      }
    }
  }
}
```

Always add `"disallowedTools": ["WebSearch"]` for a third-party endpoint: `WebSearch` is an Anthropic server-side tool and other endpoints fail on it. Run `/logout` inside Claude Code first if it holds an Anthropic login. Alibaba keys must come from the Singapore region.

### Codex with an OpenAI-compatible endpoint

Extend `codex` and set `OPENAI_BASE_URL` and `OPENAI_API_KEY` in `env`. Codex reads routing from its config, not from `OPENAI_BASE_URL` alone, so JAgentDesk also injects a model provider into the thread config:

```toml
model_provider = "jagentdesk:my-codex"

[model_providers."jagentdesk:my-codex"]
name = "My Codex"
base_url = "https://custom-relay.example.com/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
requires_openai_auth = false
```

The key is namespaced with `jagentdesk:` so it cannot override a Codex built-in. `base_url` gets `/v1` appended when missing. `env_key` and `requires_openai_auth = false` are set only when `OPENAI_API_KEY` is non-empty. The endpoint must speak the OpenAI Responses API, not only chat completions. Codex does not discover custom models, so set `models`. To change only the binary, use `command` and leave `OPENAI_BASE_URL` out.

### OMP profiles and Pi-compatible forks

OMP is a built-in provider that starts disabled; enable it with `"omp": { "enabled": true }`. Custom OMP profiles extend `omp` and inherit its `rpc-ui` approvals, native host tools, provider subagents and import behavior. OMP accepts `smolModel`, `slowModel` and `planModel` options.

A provider that keeps Pi's `--mode rpc` API but stores sessions elsewhere extends `pi` and replaces `command`.

For both, `options.sessionDir` names the JSONL session directory used only to import sessions started outside JAgentDesk. Launch and resume always go through the configured command. Set it whenever `command` or XDG variables move the session directory:

```json
{
  "agents": {
    "providers": {
      "omp-work": {
        "extends": "omp",
        "label": "Oh My Pi (Work)",
        "env": { "XDG_STATE_HOME": "~/.local/state/omp-work" },
        "options": { "sessionDir": "~/.local/state/omp-work/omp/agent/sessions" }
      }
    }
  }
}
```

## ACP agents

Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdio can be added with `extends: "acp"`. The in-app ACP catalog (`packages/app/src/data/acp-provider-catalog.ts`) writes the same entries for known agents.

```json
{
  "agents": {
    "providers": {
      "gemini": {
        "extends": "acp",
        "label": "Google Gemini",
        "command": ["gemini", "--acp"]
      }
    }
  }
}
```

The agent reports modes and models at runtime after `initialize` and `session/new`. Options for ACP entries:

- `supportsMcpServers: false` stops JAgentDesk from injecting its MCP server. ACP receives JAgentDesk tools through the MCP fallback, and some adapters cannot create sessions when `mcpServers` is non-empty.
- `clientCapabilities: { fs: { readTextFile, writeTextFile }, terminal }` lets a compliant agent delegate file and terminal operations to JAgentDesk. Enable only what JAgentDesk should execute; when agent and daemon run in different environments, give both the same absolute workspace paths first.

Every ACP provider has an **Auto Accept** toggle per session that approves permission requests without prompting. A request with no allow option still waits for you, as do single-choice questions (see [providers.md](providers.md#acp)). Unattended agents turn Auto Accept on unless you disable it.

Diagnostics for an ACP entry report the configured command, resolved launcher, version output, `initialize`, `session/new`, model count, modes and final status. For package runners (`npx`, `bunx`, `pnpm`, `uvx`) the version probe keeps the package spec, so `npx -y @google/gemini-cli --acp` is probed as `npx -y @google/gemini-cli --version`. Probes use short timeouts and suppress browser launches, so an agent that starts an auth flow fails as a diagnostic error instead of hanging.

## Commands and disabling

`command` replaces the provider's launch command and works on built-in providers, profiles and plugin providers. The binary must exist; otherwise the provider is reported unavailable.

```json
{
  "agents": {
    "providers": {
      "claude": { "command": ["/opt/claude-nightly/claude"] },
      "copilot": { "enabled": false }
    }
  }
}
```

`enabled: false` hides a provider from the app and CLI. Remove the field or set `true` to restore it.
