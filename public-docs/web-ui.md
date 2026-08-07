---
title: Browser access
description: Use the optional local browser renderer against a JAgentDesk daemon you control.
nav: Browser access
order: 6
category: Getting started
---

# Browser access

JAgentDesk is desktop- and mobile-first. A daemon may also serve the bundled renderer locally
for diagnostics or development; it is not a hosted web service and it never uses a relay.

Start it explicitly:

```bash
jagentdesk daemon start --web-ui --listen 127.0.0.1:6768
```

Then open `http://localhost:6768/` on the same machine. For a remote browser, use Tailscale
Serve or another private network path and keep application pairing/password protection enabled.

The browser renderer connects to the same daemon origin. It does not discover or select a
public JAgentDesk endpoint, and no public release/download service is required.

## Security

- Keep the listener on localhost unless a private network path is intentional.
- Use Tailscale for remote access and pair the browser/device at the application layer.
- Set a daemon password before exposing a listener beyond localhost.
- Do not expose the daemon directly to the public internet.
