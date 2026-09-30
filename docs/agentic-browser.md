# Agentic browser: identity and dialogs

The agentic browser runs each tab in an Electron `<webview>` on the desktop app. Agents drive it with
the `browser_*` tools through the daemon (`packages/server/src/server/browser-tools/`); the desktop
main process executes the commands (`packages/desktop/src/features/browser-automation/`).

## Identity

A tab presents either the active fingerprint profile or, when none is chosen, a plain Chrome
identity.

- **Before the first request.** Electron starts loading a `<webview>`'s `src` before
  `did-attach-webview`, so the first URL is held until the identity (User-Agent, Client Hints,
  platform, timezone, locale and init scripts) is applied, then loaded.
- **Everywhere.** Open tabs and popups get a new profile when it changes; cross-site iframes and
  workers get it through `Target.setAutoAttach`, including `navigator.platform` in workers.
- **Plain Chrome without a profile.** The User-Agent has no app or Electron tokens, Client Hints match
  Chrome's (also on navigation requests, which Electron does not send by itself), and the UA follows
  the engine's Chrome version.
- **Fingerprint checks.** Chrome APIs Electron lacks (`window.chrome.loadTimes`, `csi`, `app`) are
  shimmed, `navigator.webdriver` is `false`, patched functions answer `[native code]` to
  `Function.prototype.toString`, canvas noise leaves solid fills exact and audio noise leaves
  silence silent, the reported screen is never smaller than the window, and a profile on the host's
  own OS reports the real GPU.
- **Persistence.** Fingerprint profiles and the active profile are stored in `config.json` and
  survive a daemon restart.

Measured on macOS arm64 (2026-09-30): no profile and a macOS profile score 100 on iphey and
"consistent, no masking" on PixelScan. A Windows profile on a Mac scores 100 on iphey, but
PixelScan detects the claimed GPU. A location that does not match the network (for example New York
without a proxy) lowers the iphey score; use a proxy in the profile.

## JavaScript dialogs (ADR-0025)

`alert`, `confirm` and `prompt` in an agentic tab do not open a native box. The dialog becomes the
tab's **pending dialog** — `{ id, type, message, defaultValue?, url, openedAtMs }` — and the page
stays paused until someone answers it. Nothing is answered automatically and there is no timeout;
navigating away or closing the tab cancels it.

- **Command that opens a dialog.** It returns immediately with `pendingDialog` (result
  `{ command: "dialog", pendingDialog, handled: null }`).
- **Commands on a waiting tab.** They are refused with `browser_denied` and `pendingDialog`, because
  the page cannot run script. `screenshot`, `logs` and the navigation commands still run.
- **Agent answer.** `browser_dialog { browserId, action: "accept" | "dismiss" | "status", text? }`.
  `accept` presses OK, `dismiss` presses Cancel, `text` is the prompt's input (default: its default
  value).
- **User answer.** A bar in the browser tab shows the dialog with OK / Cancel and a text field for
  prompts. The first answer wins; the user's answer is reported to the agent in `dialogs` on its next
  command on that tab.
- **`prompt()` in the main frame.** Electron replaces it with a function that throws. The tab's
  preload (`browser-keyboard/guest-preload.ts`) installs a prompt that blocks on a synchronous IPC to
  the main process until the dialog is answered (OK returns the text, Cancel returns `null`).
- **"Leave site?"** (`beforeunload`) leaves the page and is reported in `dialogs`.
- **HTML modals.** `<dialog>` and `aria-modal` elements appear in snapshots as
  `dialog "<name>" [modal=true]`; the agent clicks their buttons like any other element.
- **Popups** opened with `window.open` are separate windows the user sees; they keep Electron's
  native dialogs.

Code: `guest-dialogs.ts` (pending dialogs), `service.ts` (`withDialogCapture`, the `dialog`
command), `packages/app/src/desktop/browser/pane/dialog-bar.tsx` (the bar).
