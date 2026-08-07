## 1. Product scope and domain model

- [ ] 1.1 Implement daemon/client boundary and supported product surfaces from `product-scope` Requirements 1–7.
- [ ] 1.2 Implement stable project, workspace, agent, schedule, chat, and loop entities from `domain-model` Requirements 1–7.
- [ ] 1.3 Add `$JAGENTDESK_HOME` layout, atomic JSON stores, optional-field forward compatibility, and 0600 permissions from `storage-data-model` Requirements 1–12.

## 2. Tailscale transport

- [ ] 2.1 Implement tsnet daemon listener and direct tailnet WebSocket dialing from `transport-tailscale` Requirements 1–2.
- [ ] 2.2 Preserve `attachSocket(ws, ExternalSocketMetadata)` and the `/ws` hello/server-info contract from `transport-tailscale` Requirements 3 and 5.
- [ ] 2.3 Remove relay outbound dialing and relay E2EE-box paths; add stale-socket lease and bounded outbound buffering from `transport-tailscale` Requirements 4, 6–7.

## 3. Pairing, protocol, and security

- [ ] 3.1 Implement mobile Tailscale login, per-device keypair registration, pairing offers, revocation, and signed nonce challenge from `pairing-and-signing` Requirements 1–6.
- [ ] 3.2 Implement JSON WebSocket envelopes, request correlation, dotted RPC namespaces, ping/pong, timeout, and binary frame contracts from `protocol` Requirements 1–22.
- [ ] 3.3 Implement layered Tailscale ACL, pairing, permission, BYOK, capability-token, constant-time comparison, and secret-file hardening from `security` Requirements 1–7.

## 4. Agent sessions and providers

- [ ] 4.1 Implement persisted agent lifecycle, create/run/cancel, foreground-run exclusivity, resume/reload/replace/import, archive, and subagent identity from `agent-sessions` Requirements 1–8.
- [ ] 4.2 Implement provider registry, modes, discovery, native/ACP adapters, custom overrides, diagnostics, model/thinking/features/voice selection from `providers` Requirements 1–8.
- [ ] 4.3 Implement provider-neutral orchestration, timeline, attention, permission, and structured-output event handling from `agent-sessions` Requirement 8 and `providers` Requirement 8.

## 5. Workspaces and Git

- [ ] 5.1 Implement workspace source types, repository association, checkout/worktree isolation, deterministic placement, and ownership from `workspaces-git` Requirements 1–3.
- [ ] 5.2 Implement read-only Git snapshot, checkout observation, bounded diff, archive safety, and GitHub/GitLab/Gitea forge operations from `workspaces-git` Requirements 4–7.
- [ ] 5.3 Implement project/workspace RPCs and metadata generation while preserving the protocol contracts in `protocol` Requirements 8–13.

## 6. Terminals

- [ ] 6.1 Implement workspace-scoped PTY creation, lifecycle, RPCs, tab/split identity, and activity tracking from `terminals` Requirements 1–2 and 6.
- [ ] 6.2 Implement terminal binary multiplexing, input, resize, capture, kill, backpressure, and snapshot recovery from `terminals` Requirements 3–5.

## 7. Read-only files and diffs

- [ ] 7.1 Implement scoped file listing, bounded reads, stable streamed reads, live version observation, and file-transfer framing from `diff-and-files` Requirements 1, 3–5.
- [ ] 7.2 Implement read-only preview, image lightbox, structured commit/working-tree diffs, and oversized-diff states from `diff-and-files` Requirements 2, 6–7.
- [ ] 7.3 Exclude all in-app file-write/editor routes and RPCs; add negative tests from `product-scope` Requirement 6 and `settings` Requirement 5.

## 8. Composer and permissions

- [ ] 8.1 Implement composer validation, input submission, attachments, queue/interrupt semantics, and daemon persistence from `composer-permissions` Requirements 1–3.
- [ ] 8.2 Implement actionable permission cards, plan cards, question forms, approval/rejection, and timeout behavior from `composer-permissions` Requirement 4.

## 9. Voice and dictation

- [ ] 9.1 Implement ordered PCM streaming, partial/final transcription, cancellation, retry, insert, and insert-and-send from `voice-dictation` Requirements 1–2 and 4.
- [ ] 9.2 Implement voice mode STT/TTS, interruption, turn detection, native two-way audio, and configured local/OpenAI engines from `voice-dictation` Requirement 3.

## 10. Automation and chat

- [ ] 10.1 Implement cron schedules that create fresh agents, lifecycle controls, and current-agent heartbeats from `automation` Requirements 1–3.
- [ ] 10.2 Implement bounded worker/verifier loops with recovery state from `automation` Requirement 4.
- [ ] 10.3 Implement agent/human chat rooms, message persistence, membership, and event delivery from `automation` Requirement 5.

## 11. Notifications

- [ ] 11.1 Implement focused/present/push-eligible attention policy and desktop/web target routing from `notifications-push` Requirements 1–2.
- [ ] 11.2 Implement Expo token registration, refresh, revocation, and persisted token records from `notifications-push` Requirement 3.
- [ ] 11.3 Implement content-light event-type/opaque-ID payloads and Tailscale detail fetch; prohibit prompt/code/file content in push payloads from `notifications-push` Requirement 4.

## 12. Desktop app

- [ ] 12.1 Implement Electron host for the shared Expo web export, deep-link scheme, windows, and lifecycle from `desktop-app` Requirement 1.
- [ ] 12.2 Implement local daemon start/stop/readiness and local socket/pipe connection from `desktop-app` Requirement 2.
- [ ] 12.3 Implement local and remote tailnet daemon connections, browser automation, and no-editor boundary from `desktop-app` Requirements 3–4.

## 13. Mobile app

- [ ] 13.1 Implement Expo Router/shared providers and the startup route gate from `mobile-app` Requirements 1–2.
- [ ] 13.2 Implement the offer-first pairing gate, post-offer Tailscale login, six-digit verification, welcome/workspace/session/settings routes, and mobile panels/gestures from `mobile-app` Requirements 3–4.
- [ ] 13.3 Implement target-specific push routing and detail retrieval over Tailscale from `mobile-app` Requirement 5.

## 14. Design system

- [ ] 14.1 Port the single token source, six themes, semantic colors, diff colors, identity palette, and Unistyles mapping from `design-system` Requirements 1–5 and 11.
- [ ] 14.2 Port exact spacing, font, radius, icon, weight, opacity, and control geometry scales from `design-system` Requirements 6–10.

## 15. Settings and i18n

- [ ] 15.1 Implement settings list/detail sections, host resources, service URLs, compact/expanded routing, diagnostics, and paired-device management from `settings` Requirements 1–4.
- [ ] 15.2 Implement cloned locales, deterministic system-language resolution, runtime locale selection, and translation-key enforcement from `i18n` Requirements 1–4.

## 16. CLI

- [ ] 16.1 Implement agent, daemon, chat, terminal, script, loop, schedule, heartbeat, workspace, permit, provider, and speech commands from `cli` Requirements 1–2.
- [ ] 16.2 Implement table/JSON/YAML/quiet/header/color output and safe workspace resolution from `cli` Requirements 3–4.
- [ ] 16.3 Ensure CLI uses tailnet hosts and contains no relay control path from `cli` Requirement 5.

## 17. Cross-surface validation and migration safety

- [ ] 17.1 Add protocol contract tests covering signed hello, RPC correlation, liveness, binary frames, and 60-second default RPC wait from `protocol` Requirements 1–7.
- [ ] 17.2 Add parity tests mapping every JAgentDesk capability in this change to an implemented JAgentDesk surface; record intentional deltas for relay, editor, and push payloads from `product-scope` Requirements 4–7.
- [ ] 17.3 Grep for stale `JAGENTDESK_HOME`, `jagentdesk://`, relay, E2EE-box, and file-write UI paths before release; verify all timestamps use Unix UTC milliseconds with `_ms` suffix.
- [ ] 17.4 Run strict OpenSpec validation and retain evidence for each acceptance criterion; do not mark implementation tasks complete without executable or observable proof.
