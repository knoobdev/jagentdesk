---
title: Security
description: "Security model for JAgentDesk: Tailscale transport, device pairing, signing, and local daemon boundaries."
nav: Security
order: 4
category: Getting started
---

# Security

JAgentDesk is local-first. The daemon runs on the work machine and manages coding-agent
processes. Desktop and mobile clients connect to it through the user's Tailscale network.

## Connection model

- Tailscale supplies the network path and WireGuard node authentication.
- The daemon exposes its WebSocket endpoint on the tailnet instead of contacting a hosted relay.
- A pairing offer contains the daemon identity and tailnet address.
- The mobile client authenticates Tailscale, then enters the six-digit code shown for its desktop
  pairing request.
- The daemon signs and verifies the pairing transcript before registering the device.

Tailnet membership alone does not grant control. Each pending request has a unique code and an
expiry. Cancelling or accepting it invalidates the pending request.

## Local daemon boundary

The daemon binds to the configured local or tailnet address. If a password is configured, HTTP
requests require a bearer token and WebSocket upgrades require the matching protocol token.
Connected clients are trusted operators of the daemon user, so protect the Tailscale account,
auth keys, daemon password, pairing links, and six-digit codes.

## Agent credentials

JAgentDesk launches provider CLIs in the local user context. Provider credentials remain with
those CLIs and are not collected by JAgentDesk.

## DNS rebinding protection

The daemon validates the `Host` header against its configured allowlist. Configure accepted
hostnames through `daemon.hostnames` in `config.json` or `JAGENTDESK_HOSTNAMES`.
