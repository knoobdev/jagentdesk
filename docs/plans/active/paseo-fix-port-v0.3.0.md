# Port Paseo v0.2.5 → v0.3.0 bug fixes into jagentdesk

jagentdesk was forked from Paseo **v0.2.5**. Paseo has since shipped **v0.3.0**. This ports the
upstream **bug fixes** in `v0.2.5..HEAD` into the fork, rebranded to jagentdesk, **without undoing
any jagentdesk divergence** (view-only/no-editor, Tailscale-only transport / no `relay` package,
orchestration Supervisor→Lead→Peer + `/orc`, mobile browser screencast, pairing, jagentdesk branding).

Upstream working clone for reference/diffing: `../paseo-upstream` (full history).

## Method
- Enumerated `v0.2.5..HEAD`: 180 commits → 47 real fixes (dropped release/lockfile/Nix-hash noise).
- Clustered fixes by shared files (union-find) into 8 file-disjoint batches.
- Ran an 8-agent workflow (`port-paseo-fixes`); each agent read `git show <sha>` upstream, applied the
  minimal delta to the fork, rebranded `paseo→jagentdesk`, and was told to **skip + flag** anything
  touching a jagentdesk invariant rather than force it.
- Integrated: fixed 2 test-mock lags, reverted whole-repo `oxfmt` churn (kept formatting only on
  touched files), regenerated `package-lock`, branding scan, full monorepo typecheck.

## Version reset
All 10 packages (root + 9 workspaces) and internal deps: `0.2.5` → **`1.0.0`**; `package-lock.json`
regenerated. (`app.config.js` derives Android versionCode `1000000` / iOS buildNumber from this.)

## Applied (18)
Terminal: render art at exact cell geometry, stabilize native rendering, keep output subscribed after
focus (#2896). Server/runtime: pi delegated-task lifecycle status (#2891), pi assistant-delta stream
when cumulative omitted (#2978), stop Claude replay accumulating running subagents (#2876), report
Claude runtime death instead of idling (#2910), Fast toggle on Opus 5 (#2939). App/UI: preserve
assistant order across outline jumps, preserve active host connection choices (#2905), menu-popover
transform-origin x-then-y (#2911), anchor image growth during timeline reload, native IME composition
state, keep open workspace menu from unmounting its trigger (#2850), composer toolbar collapse flicker
(#2937). Desktop: keep dev artifacts out of packaged app; keep browser surfaces interactive (partial —
desktop Electron webview focus only; does not touch the mobile screencast pane). Clipboard: keep line
breaks/indentation in copied code (#2935, partial).

## Skipped (28) — why
- **Already present in the fork** (majority): mobile sidebar swipe/drag (#2709), dictation-on-submit
  (#2745), local-branch worktree base (#2328), host badge identity, workspace titles task-shaped
  (#2755), paste clipboard images (#2793), portable shebangs (#2536), commit-history fixture timeout
  (#2707), browser relay WS protocol-neutral (#2976 — jagentdesk already neutral), and all 5 `nix`
  fixes (runtime mode #2697, docs/CI out of derivation #2652, shrink runtime #2550, Darwin app icon
  #2783/#2506) — jagentdesk's nix already matches.
- **Would fight a jagentdesk divergence (deliberately skipped):** emphasize needs-input indicators +
  its alert-size follow-up (jagentdesk re-tuned this subsystem the opposite way), running-tab
  accessibility (progressbar role removed on purpose).
- **Targets a Paseo subsystem the fork never adopted:** the `components/ui/menu` redesign (menu
  selections on iOS, compact sheet content), the native `press-highlight` primitive (immediate press
  ack, corner tracing), the "fix-5" nav/tree-rail redesign (polish nav surfaces, align file-tree rows,
  reposition launch selector), and two clipboard `content.web.ts` helpers absent in the fork.
- **Dependency-bump-only, low value / risk:** Android keyboard (`react-native-keyboard-controller`
  pin), Windows PTY (`node-pty` pin).

## Integration fixes made by hand
- `48bdc5610` added `getHosts` to `DaemonConnectionStore` and made bootstrap `boot` async; updated the
  lagging mocks in `daemon-start-service.test.ts` (both fake stores) and `host-runtime-bootstrap.test.ts`.

## Validation
- **Full monorepo `npm run typecheck`: clean (0 errors).**
- Branding scan: no `paseo`/`getpaseo` token in any tracked source (the `scratchpad/reference` Paseo
  snapshot is intentionally left as-is).
- Confirmed the workflow touched **none** of the orchestration / screencast / daemon-client / protocol
  RPC files — those show changes only from prior in-repo work, not this port.
- Not committed — left for review.

## Not done / follow-ups
- Runtime/behavioral testing of the applied fixes (only typecheck-verified here).
- Nix build hashes / `flake.lock` will need regeneration at release time (out of scope for source port).
