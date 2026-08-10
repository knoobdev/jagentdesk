# Local connections require device pairing (align with ADR-0010)

## Outcome

Every real daemon connection — loopback/direct AND tailnet — must present a
challenge-bound Ed25519 signed hello from a device in the daemon's paired-device
store. The daemon stops accepting unsigned local hellos. OS permissions
(loopback bind, `0600` socket) remain defense-in-depth only, not control
authority.

Product contract: `../../remote-coding-app-spec/docs/decisions/ADR-0010-local-and-tailscale-require-device-pairing.md`.
JAgentDesk authority: `docs/architecture.md`, `docs/rpc-namespacing.md`,
`docs/protocol-compatibility.md`, `docs/testing.md`.

## Bootstrap decision (chosen)

**Desktop is the sole bootstrap.** The desktop that creates the daemon keypair
self-registers its own device key as the first trusted device at home init. The
CLI and every other device (mobile, second desktop) become trusted only through
a pairing session opened by an already-authenticated connection (SAS confirmed
both sides). No local exception auto-adds a public key (ADR-0010 §4).

## Current state (verified)

- Challenge + signed-hello gate is tailnet-only:
  `packages/server/src/server/websocket-server.ts` — challenge issued at ~1460,
  verified at ~1754 under `identity.transport === "tailnet"`.
- Reusable primitives already exist: `pairing/paired-devices.ts` (store),
  `pairing/signed-hello.ts` (`verifySignedHello`, rejects unknown device key),
  `pairing.challenges.issue()`.
- CLI already carries a signer (`packages/cli/src/utils/client.ts:341-356`:
  `devicePublicKeyB64` + `signNonce`) but its key is not registered, because
  loopback is currently trusted.
- Daemon binds `127.0.0.1:<port>` (loopback-only) for direct.
- Mobile runtime default `connectionMode` falls back to `"local"`
  (`packages/app/src/runtime/host-runtime.ts:451,625`); `pair-start.tsx:128-140`
  shows an un-gated "Continue with Local" button.

## Scope / sequence (dependency order — must land together to avoid lockout)

1. **Server enforcement.** Issue challenge + verify signed hello for direct too;
   remove the unsigned-local accept path. Fail-closed with `not_paired` /
   `signer_required`. Keep tailnet behavior intact.
2. **Desktop self-bootstrap.** At daemon home init, register the desktop's device
   public key as the first trusted device (owner of the daemon keypair). Idempotent.
3. **CLI pairing.** New authenticated pairing path so the CLI key is trusted;
   until paired, CLI RPCs fail closed with a clear "run `daemon pair`"-style message.
   (This unblocks the e2e harness which relies on the local CLI connection.)
4. **Mobile.** Drop the auto `"local"` default; gate/hide "Continue with Local" on
   native; fail-closed when no signer.
5. **Adopt ADR-0010 into this repo** (security/protocol change needs a product ADR).
6. **Validation.** Unit: direct unsigned hello rejected; paired direct accepted.
   Reuse `websocket-server.pairing.test.ts`. E2E per `docs/testing.md` + the
   Tailscale/local Maestro flows. Real proof, not presentation-only.

## Risks / recovery

- Flipping server enforcement before desktop+CLI trust exist locks out ALL local
  control (including this repo's own e2e harness). Steps 1–3 must ship as one unit.
- Persisted device store must survive restart or every boot re-locks.

## Status

- [x] 1 server — gate extended to direct behind `requireSignedHelloForDirect`
      (`websocket-server.ts` `requiresSignedHello()` + 3 gate points; env
      `JAGENTDESK_REQUIRE_LOCAL_PAIRING=1` in `bootstrap.ts`, default off).
      Validated: 3 new tests in `websocket-server.pairing.test.ts` (14/14 pass);
      origin + bootstrap-auth suites 9/9. Typecheck clean.
- [x] 2 desktop — already present: `bootstrap.ts` registers
      `JAGENTDESK_DESKTOP_DEVICE_PUBLIC_KEY` as the first trusted device.
- [x] 3 cli — local connect now carries the CLI device signer and answers the
      challenge (`cli/utils/client.ts` `tryConnectHost`). Added client options
      `challengeWaitFallbackMs` + `unsignedHelloFallbackOnChallengeTimeout`
      (`daemon-client.ts`) so a local client works against both a gate-on daemon
      (challenge answered) and a gate-off/legacy daemon (plain hello). Tailnet's
      strict refusal is unchanged. Validated: client 113/113.
- [x] 4 mobile — native no longer defaults to `"local"`
      (`host-runtime.ts`, `isWeb ? "local" : null`) and hides "Continue with Local"
      on native (`pair-start.tsx`, `isNative`). Screenshot proof: onboarding shows
      only Tailscale pairing; `pair-start-local` absent. App typecheck clean.
- [ ] 5 ADR — adopt ADR-0010 into this repo's `docs/decisions/`.
- [ ] 6 flip-on default — needs an automatic CLI-key trust path (desktop
      registers the CLI key, or CLI pairs via the desktop's authenticated session).
      Until then enforcement stays behind `JAGENTDESK_REQUIRE_LOCAL_PAIRING=1`.

Runtime E2E proof with the gate on (`JAGENTDESK_REQUIRE_LOCAL_PAIRING=1`):

- untrusted CLI over loopback → rejected: daemon logs "device is not paired",
  4401; CLI reports websocket "not reachable".
- trusted CLI (owner key registered) → daemon logs "signed hello verified",
  CLI "reachable".
- gate off → no challenge, CLI "reachable" (no regression).
