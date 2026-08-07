# Security

JAgentDesk is local-first. A daemon runs on the work machine and manages coding-agent
processes. Desktop and mobile clients connect to that daemon through the user&apos;s Tailscale
network.

## Connection security

- Tailscale supplies the network path and WireGuard node authentication.
- A node being present in the tailnet is not enough to control the daemon.
- The daemon creates a pairing offer containing its public identity and Tailscale address.
- The mobile client must complete Tailscale authentication, then enter the six-digit code shown
  by the desktop pairing request.
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
