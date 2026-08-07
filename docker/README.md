# JAgentDesk Docker Image

This directory contains the official JAgentDesk daemon image.

The image runs the daemon headless and serves the bundled web UI from the same
HTTP origin. Start it, then open the daemon URL in a browser.

```bash
docker run -d --name jagentdesk \
  -p 6767:6767 \
  -e JAGENTDESK_PASSWORD=change-me \
  -v "$PWD/jagentdesk-home:/home/jagentdesk" \
  -v "$PWD:/workspace" \
  jagentdesk:local:latest
```

Then open `http://localhost:6767`.

The base image intentionally does not bundle agent CLIs. Extend it with the
agents you use:

```Dockerfile
FROM jagentdesk:local:latest

USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code
```

See [docs/docker.md](../docs/docker.md) for Compose, reverse proxy, security,
agent auth, and troubleshooting notes.
