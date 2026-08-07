# Contributing to JAgentDesk

JAgentDesk is a local-first product. Contributions should preserve the desktop/mobile
connection model: Tailscale provides the network path and application pairing authorizes each
device.

## Before editing

- Read the relevant product contract in `docs/` and the matching source package.
- Keep user-facing strings in the locale resources.
- Do not add hosted relay, public release, telemetry, or project-community dependencies.
- Do not add mock data or claim a change is complete without executable evidence.

## Validation

Run the smallest relevant checks while iterating, then run the affected workspace checks:

```bash
npm run typecheck
npm run lint
npm run build:desktop
npx expo prebuild --platform ios --no-install
```

For pairing or transport changes, exercise both the desktop request UI and the mobile flow with a
real Tailscale connection. Record the platform, commands, test result, and any screenshots in the
change notes.

## Product decisions

Keep product and architecture decisions in `docs/` and security/protocol decisions in the
corresponding ADR. The local project tracker is the source for review status; this repository does
not depend on a hosted issue, discussion, or release service.
