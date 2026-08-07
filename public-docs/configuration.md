---
title: Configuration
description: Configure JAgentDesk via config.json, environment variables, and CLI overrides.
nav: Configuration
order: 40
category: Configuration
---

# Configuration

JAgentDesk loads configuration from a single JSON file in your JAgentDesk home directory, with optional environment variable and CLI overrides.

## Where config lives

By default, JAgentDesk uses `~/.jagentdesk` as its home directory. The configuration file is:

```bash
~/.jagentdesk/config.json
```

You can change the home directory by setting `JAGENTDESK_HOME` or passing `--home` to `jagentdesk daemon start`.

## Precedence

JAgentDesk merges configuration in this order:

1. Defaults
2. `config.json`
3. Environment variables
4. CLI flags

Lists append across sources (for example, `hostnames` and `cors.allowedOrigins`).

## Example

Minimal example that configures listening address, hostnames, and MCP:

```json
{
  "$schema": "http://localhost:8082/schemas/jagentdesk.config.v1.json",
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:6767",
    "hostnames": ["localhost", ".localhost"],
    "mcp": { "enabled": true }
  }
}
```

`daemon.hostnames` is the primary field. The old `daemon.allowedHosts` name still works as a deprecated alias for backward compatibility.

## Agent providers

Agent providers, both the first-class ones JAgentDesk ships with and custom entries you add under `agents.providers`, are documented on their own page.

See [Providers](/docs/providers) for the mental model and [Supported providers](/docs/supported-providers) for the full list of agents JAgentDesk can launch. For pointing Claude at Anthropic-compatible endpoints (Z.AI, Alibaba/Qwen), multiple profiles, custom binaries, ACP agents, and the `additionalModels` merge behavior, see [Custom providers](/docs/custom-providers). The full field reference is maintained in the local `docs/custom-providers.md` file.

## Worktrees

New worktrees are created under `$JAGENTDESK_HOME/worktrees` by default. To place new worktrees somewhere else, set `worktrees.root`:

```json
{
  "worktrees": {
    "root": "/mnt/fast/jagentdesk-worktrees"
  }
}
```

Relative paths are resolved against `JAGENTDESK_HOME`. Existing worktrees remain where they are; changing this setting only changes where JAgentDesk creates and discovers JAgentDesk-managed worktrees going forward.

## Voice

Voice is configured through `features.dictation` and `features.voiceMode`, with provider credentials under `providers`.

For voice philosophy, architecture, and complete local/OpenAI setup examples, see [Voice docs](/docs/voice).

## Bundled web UI

The daemon can serve the browser web client from the same HTTP server. This is enabled in the official Docker image and disabled by default for normal CLI and desktop-managed daemons.

Enable it from the CLI:

```bash
jagentdesk daemon start --web-ui
```

Or set the environment variable:

```bash
JAGENTDESK_WEB_UI_ENABLED=true jagentdesk daemon start
```

Or persist it in `config.json`:

```json
{
  "features": {
    "webUi": {
      "enabled": true
    }
  }
}
```

When enabled, open the daemon HTTP origin, for example `http://localhost:6767/`, to load the web app. Static UI files load without daemon auth; API and WebSocket requests still require the configured password.

## Logging

Daemon logging uses separate console and file sinks by default:

- Console: `info` and above
- File (`$JAGENTDESK_HOME/daemon.log`): `trace` and above
- File rotation: `10m` max file size, `2` retained files total (active + 1 rotated)

```json
{
  "log": {
    "console": {
      "level": "info",
      "format": "pretty"
    },
    "file": {
      "level": "trace",
      "path": "daemon.log",
      "rotate": {
        "maxSize": "10m",
        "maxFiles": 2
      }
    }
  }
}
```

Legacy fields `log.level` and `log.format` are still supported and map to the new destination settings.

## Password authentication

You can require a password to connect to the daemon. When set, all HTTP and WebSocket clients must authenticate. Only the `/api/health` liveness endpoint is exempt, so that process supervisors and load balancers can probe without credentials.

The easiest way to set a password is with the CLI:

```bash
jagentdesk daemon set-password
```

This prompts for a password, writes the bcrypt hash to `config.json`, and tells you to restart the daemon.

Alternatively, set the `JAGENTDESK_PASSWORD` environment variable (plaintext, hashed automatically at startup):

```bash
JAGENTDESK_PASSWORD=my-secret jagentdesk daemon start
```

Or write the hash directly in `config.json`:

```json
{
  "daemon": {
    "auth": {
      "password": "$2b$12$..."
    }
  }
}
```

After setting a password, restart the daemon for the change to take effect.

### Connecting with a password

The CLI picks up a password from, in order:

1. The `password` query parameter on a `tcp://` host URI:

   ```bash
   jagentdesk --host "tcp://192.168.1.10:6767?password=my-secret" ls
   ```

2. The `JAGENTDESK_PASSWORD` environment variable, used as a fallback when the host carries no embedded password (works for `localhost:6767`, bare `host:port`, or `tcp://` hosts without a `password=` query):

   ```bash
   JAGENTDESK_PASSWORD=my-secret jagentdesk ls
   JAGENTDESK_PASSWORD=my-secret jagentdesk --host 192.168.1.10:6767 ls
   ```

A `password=` in the URI always wins over the env var, so you can keep `JAGENTDESK_PASSWORD` set globally and still target a different daemon by spelling its password into the URI.

In the mobile app, enter the password in the direct connection setup screen.

## Tailscale

Remote connections use the daemon's Tailscale address and the application pairing flow. The
daemon does not contact a hosted relay and there is no relay enable/disable setting. Configure
the Tailscale auth key in the desktop connection screen when the daemon needs one, then pair a
mobile device with the QR/link and six-digit confirmation code.

## Common env vars

- `JAGENTDESK_HOME`, set JAgentDesk home directory
- `JAGENTDESK_PASSWORD`, on the daemon, the password to require (plaintext, hashed at startup); on the CLI, the password used to connect when the host URI doesn't include one
- `JAGENTDESK_LISTEN`, override `daemon.listen`
- `JAGENTDESK_HOSTNAMES`, override/extend `daemon.hostnames`
- `JAGENTDESK_ALLOWED_HOSTS`, deprecated alias for `JAGENTDESK_HOSTNAMES`
- `JAGENTDESK_WEB_UI_ENABLED`, enable or disable the daemon-served web UI
- `JAGENTDESK_WEB_UI_DIST_DIR`, override the daemon web UI build directory
- `JAGENTDESK_TRUSTED_PROXIES`, configure trusted reverse proxy ranges for `X-Forwarded-*` headers
- `JAGENTDESK_LOG_CONSOLE_LEVEL`, override `log.console.level`
- `JAGENTDESK_LOG_FILE_LEVEL`, override `log.file.level`
- `JAGENTDESK_LOG_FILE_PATH`, override `log.file.path`
- `JAGENTDESK_LOG_FILE_ROTATE_SIZE`, override `log.file.rotate.maxSize`
- `JAGENTDESK_LOG_FILE_ROTATE_COUNT`, override `log.file.rotate.maxFiles`
- `JAGENTDESK_LOG`, `JAGENTDESK_LOG_FORMAT`, legacy log overrides (still supported)
- `OPENAI_API_KEY`, override OpenAI provider key
- `OPENAI_STT_API_KEY`, `OPENAI_STT_BASE_URL`, OpenAI speech-to-text endpoint (dictation + voice mode STT)
- `OPENAI_TTS_API_KEY`, `OPENAI_TTS_BASE_URL`, OpenAI text-to-speech endpoint (voice mode TTS)
- `JAGENTDESK_VOICE_LLM_PROVIDER`, override voice LLM provider (`claude`, `codex`, `opencode`)
- `JAGENTDESK_DICTATION_STT_PROVIDER`, `JAGENTDESK_VOICE_STT_PROVIDER`, `JAGENTDESK_VOICE_TTS_PROVIDER`, override voice provider selection (`local` or `openai`)
- `JAGENTDESK_LOCAL_MODELS_DIR`, control local model directory
- `JAGENTDESK_DICTATION_LOCAL_STT_MODEL`, override local dictation STT model
- `JAGENTDESK_VOICE_LOCAL_STT_MODEL`, `JAGENTDESK_VOICE_LOCAL_TTS_MODEL`, override local voice STT/TTS models
- `JAGENTDESK_DICTATION_LANGUAGE`, `JAGENTDESK_VOICE_LANGUAGE`, override dictation and voice STT language
- `JAGENTDESK_VOICE_LOCAL_TTS_SPEAKER_ID`, `JAGENTDESK_VOICE_LOCAL_TTS_SPEED`, optional local voice TTS tuning

## Schema

For editor autocomplete/validation, set `$schema` to:

```
http://localhost:8082/schemas/jagentdesk.config.v1.json
```
