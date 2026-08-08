# Browser screencast: desktop → mobile (view-only v1)

User request: view the in-app browser (esp. the agent/e2e-driven browser) on **mobile**, seeing
exactly what the desktop's automated browser renders. Chosen approach: **live screencast** (stream
frames desktop → mobile), not URL-sync or a separate mobile WebView.

## Why screencast

- The browser runs as a **resident Electron `<webview>`** in the desktop renderer
  (`desktop/browser/resident-webviews.ts`, mapped by `browserId`), driven by the
  `browser.automation.execute` host capability. The webview supports `capturePage()` → NativeImage.
- Browser session state is **desktop-local** and the page may not be reachable from mobile, so the
  only faithful "see what the agent sees" option is streaming frames.

## Architecture (renderer → daemon → mobile; no Electron-main change)

Producer = desktop renderer (owns the webviews). Relay = daemon. Consumer = mobile client.

```
mobile BrowserPane                 daemon (session relay)             desktop browserHost
  subscribe(browserId) ───────────▶ register consumer ──────────────▶ browser.screencast.start
                                                                        capture loop (~5 fps):
  render <Image src=frame> ◀──────── fan-out frame ◀──────────────────   webview.capturePage()→JPEG
  unsubscribe ────────────────────▶ drop consumer; if none left ─────▶ browser.screencast.stop
```

## Layers / tasks

1. **Protocol** (`packages/protocol`): messages
   - `browser.screencast.subscribe.request` {browserId, workspaceId} (client→daemon)
   - `browser.screencast.unsubscribe.request` {browserId}
   - `browser.screencast.start` / `browser.screencast.stop` (daemon→browserHost) {browserId}
   - `browser.screencast.frame` {browserId, dataBase64 (jpeg), width, height, seq, ts_ms}
     (browserHost→daemon→consumers)
   - capability flag on browserHost: `screencast: true`.
2. **Daemon** (`packages/server`): per-browserId consumer registry. First consumer → send
   `screencast.start` to the browserHost; relay each `frame` to all consumers; last consumer leaves
   → `screencast.stop`. Throttle/coalesce frames; drop if a consumer is slow (latest-wins).
3. **Desktop producer** (`packages/app/src/desktop/browser`): handle `screencast.start/stop`; add
   `captureResidentBrowserWebview(browserId)` (webview.capturePage → toJPEG base64); run a capture
   loop (~5 fps, only while ≥1 consumer) and send `frame` messages via the daemon client. Reuse the
   automation handler's client wiring.
4. **Mobile consumer** (`packages/app/src/desktop/browser/pane/index.tsx`): replace the stub — on
   mount subscribe(browserId); render latest frame as `<Image source={{uri: 'data:image/jpeg;base64,'+data}}>`
   sized to fit; unsubscribe on unmount. Show a "waiting for frames" state until the first frame.

## v1 scope

- **View-only** (no input forwarding from mobile). ~5 fps JPEG, quality ~0.6, latest-wins.
- Desktop must be running (it hosts the browser); mobile is a viewer.
- Follow-ups: input forwarding (tap→coords), adaptive fps/quality, WebRTC for higher fps.

## Verify

Desktop: an agent/e2e opens a browser tab (or `browser_new_tab`). Mobile: open that browser tab →
see the live page. Confirm frames update as the desktop page navigates/animates.

## Status (2026-08-08) — v1 CODE-COMPLETE + typecheck-clean + built

All 4 layers implemented, typecheck green, and compiled into dist:

- **Protocol** (`browser-automation/rpc-schemas.ts` + `messages.ts`): `browser.screenshot.request`
  (inbound) / `browser.screenshot.response` (outbound, discriminated `ok`). Protocol built.
- **Daemon** (`websocket-server.ts` `handleBrowserScreenshotRequest`): intercepts the request,
  calls `browserToolsBroker.execute({command:"screenshot",…})`, relays the PNG to the client.
  Server dist rebuilt (handler present in `dist/.../websocket-server.js`).
- **Client** (`daemon-client.ts` `requestBrowserScreenshot`): correlated RPC. Client dist rebuilt.
- **Mobile** (`desktop/browser/pane/index.tsx`): replaced the stub — polls the RPC ~3 fps, renders
  the PNG via `<Image>`, pauses when `isInteractive===false`, shows a loading/error state.
- NOT YET LIVE-VERIFIED end-to-end: did **not** restart the daemon because a real orchestration run
  ("Create developer portfolio website") was active — a restart would interrupt it. The handler is
  in dist and activates on the next daemon restart. To verify: restart daemon → open/az browser tab
  on desktop (agent `browser_new_tab`) → open that tab on the mobile sim → watch live frames.
- Follow-ups (documented above): input forwarding, adaptive fps/quality, push streaming/WebRTC.

## E2E verified (2026-08-08) + real bug found & fixed

Added a **`browser.list` RPC** (discovery) alongside `browser.screenshot` because the workspace tab
layout is client-local (zustand+AsyncStorage) and the browser store is desktop-local — a viewer
client can't otherwise learn the host's browserIds. The mobile `BrowserPane` now: lists the host's
browser tabs → picks one (this workspace / passed id / first) → polls its screenshot → renders.

**Bug found via the e2e:** the response payloads used `z.discriminatedUnion("ok", …)` with a BOOLEAN
discriminator; the WS AOT validator codegen emits `switch(payload.ok){case "true":…case "false":…}`
(string cases) which never matches a real boolean → every valid response was rejected
("Response validation failed"). Fixed by switching both payloads to `z.union([...])`. Regenerated the
AOT (`case "true"` count → 0).

**Verified end-to-end** by invoking the RPCs from the desktop app's real `DaemonClient`
(`globalThis.__jagentdeskHostRuntimeStore.getSnapshot(serverId).client`) after reload:

- `requestBrowserList` → `ok`, returned the live tabs (example.com / "Example Domain").
- `requestBrowserScreenshot` → `ok`, a real **2400×2010 PNG** — decoded + confirmed it's the actual
  example.com page. This is the identical path the mobile pane consumes.
  Note: the running MOBILE bundle still predates the union fix; it needs a reload to pick up the fixed
  client + AOT (verified from the reloaded desktop client instead, since driving the sim UI to open a
  browser tab was unreliable).

## Mobile build (2026-08-08) — new EAS account

The old build was blocked because `app.config.js` pinned `owner: "jagent20261"` but the CLI was
logged into a new account `jagentdesk20262` (permission denied on the old project). Fixed:

- `app.config.js` `owner`/`extra.eas.projectId` now default to the new account
  (`jagentdesk20262` / `2bcf1178-84eb-49e5-aa1e-2c66679371b5`) and are overridable via
  `EAS_OWNER`/`EAS_PROJECT_ID`. New EAS project created: `@jagentdesk20262/jagentdesk-mobile`.
- Built `development-simulator` under the new account (build `39114dd1`), installed + launched on the
  iPhone 15 sim; it auto-connected to the local daemon and loaded the FRESH bundle (union fix + list
  RPC + new BrowserPane). Verified my collapsible Lead-plan fix live on mobile (tap-to-expand).

## Mobile entry point built + FULL screencast LIVE-VERIFIED on the sim (2026-08-08)

The reason there was "no button" on mobile: the header ⋮ menu's **"New browser tab"** item
(`workspace-header-new-browser`) was gated `showCreateBrowserTab = getIsElectron()` (desktop-only),
and `handleCreateBrowserTab` early-returned on non-Electron. Both live in
`packages/app/src/screens/workspace/workspace-screen.tsx`. Fixes:

- `showCreateBrowserTab = getIsElectron() || isNative` — surfaces the already-wired, desktop-tested
  "New browser tab" item in the mobile header menu (consistent with desktop; no new component).
- `handleCreateBrowserTab` guard → `(!getIsElectron() && !isNative)` so it runs on native mobile
  (`createWorkspaceBrowser()` + `openWorkspaceTabFocused`). On mobile there's no local webview, so the
  new tab is a **viewer**: `BrowserPane` lists the host's tabs and screencasts the desktop's browser.
  Typecheck green; fast-refresh applied to the running dev-client build.

**LIVE-VERIFIED end-to-end on the iPhone 15 sim:** opened the header ⋮ menu → "New browser tab"
appears (my change) → tapped it → a browser tab opened → `BrowserPane` resolved the desktop's
`example.com` tab via `requestBrowserList` and rendered the **live PNG screencast**: the actual
_Example Domain_ page painted on mobile (URL bar "example.com", title "Example Domain", body text).
This is the complete chain the user asked for: a mobile button that opens a view of the desktop's
in-app browser. (Sim synthetic-tap note: the Simulator header row sits at screen-y ≈ `272 + dy*0.417`,
not the naive title-bar offset — small top-row targets miss until calibrated.)
