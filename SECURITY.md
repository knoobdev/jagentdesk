# Security

JAgentDesk is local-first. A daemon runs on the work machine and manages coding-agent
processes. Desktop and mobile clients connect through Tailscale or the encrypted
relay described in [docs/relay.md](docs/relay.md).

## Connection security

- Tailscale supplies the network path and WireGuard node authentication.
- A node being present in the tailnet is not enough to control the daemon.
- Pairing offers contain the daemon public identity and available connection routes.
- On either remote path, the client enters the six-digit code shown by the desktop
  pairing request and signs the daemon challenge with its device key.
- The daemon signs and verifies the pairing transcript before registering the device.
- Each pending request has its own code and expiry; accepting or cancelling a request updates the
  desktop pairing surface immediately.

## Local daemon boundary

The daemon binds to the configured local or Tailscale address. When a password is configured,
HTTP requests require a bearer token and WebSocket upgrades require the matching protocol token.
Connected clients are trusted operators of the daemon user, so protect the Tailscale account,
daemon password, pairing links, and auth keys.

## Agent credentials

JAgentDesk starts provider CLIs in the local user context. Provider credentials stay with those
CLIs; the application does not collect or forward provider API keys.

## Reporting

Keep pairing links, six-digit codes, Tailscale auth keys, daemon passwords, and diagnostic output
private. Report a suspected vulnerability through the private channel agreed by the project owner.
