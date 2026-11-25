# Mobile Testing

## Agent Device

Agent Device `.ad` scripts are the primary mobile E2E format. An agent discovers a working flow interactively, saves the successful commands, then the replay runner executes the same plan. The `agent-device` CLI is not a repo dependency; install it on your machine first.

Record a flow while driving the app normally:

```bash
agent-device open app.jagentdesk.mobile.debug \
  --platform ios \
  --session terminal-author \
  --save-script ./packages/app/e2e/mobile/agent-device/terminal.ios.ad
agent-device snapshot -i --session terminal-author
agent-device press 'id="workspace-header-menu-trigger"' --session terminal-author
# Continue the flow and verify its result with wait/get/is/find.
agent-device close --session terminal-author
```

`close` writes the script. Keep selectors based on stable app IDs. Keep assertions as `wait`, `get`, `is`, or `find` commands; screenshots are evidence, not assertions.

Run the JAgentDesk mobile suite:

```bash
npm run test:e2e:mobile
```

`scripts/test-mobile-agent-device.sh` uses an isolated Agent Device state directory (`.dev/agent-device-e2e`), prepares Metro for this checkout, prewarms the iOS runner, runs every script in `packages/app/e2e/mobile/agent-device/` with `--fail-fast`, and stops its Agent Device daemon on exit. Each script's platform comes from its `context` header. Results, logs, and failure artifacts go under `.dev/agent-device-artifacts`.

Metro defaults to port `8081`. Set `JAGENTDESK_MOBILE_E2E_METRO_PORT` when this worktree runs Metro elsewhere:

```bash
JAGENTDESK_MOBILE_E2E_METRO_PORT=62093 npm run test:e2e:mobile
```

[native-terminal-basic.ios.ad](../packages/app/e2e/mobile/agent-device/native-terminal-basic.ios.ad) and [native-terminal-basic.android.ad](../packages/app/e2e/mobile/agent-device/native-terminal-basic.android.ad) are the smallest examples. Each opens a fresh terminal from `workspace-header-menu-trigger`, types a command at zero delay, submits it, and asserts its distinct output. The scripts target the debug app (`app.jagentdesk.mobile.debug`), which must be connected to a daemon with an active workspace.

When replay diverges, read its ranked selector suggestions. Edit the script deliberately and rerun it from the beginning.

## Maestro compatibility

Existing Maestro flows live in `packages/app/maestro/`. Agent Device can execute its supported subset with `agent-device test <path> --maestro`, which provides a migration path while `.ad` coverage replaces these flows.

### Existing flows

Maestro flows live in `packages/app/maestro/`, documented in its `README.md`. Reusable sub-flows live in `packages/app/maestro/flows/`.

Run a flow:

```bash
maestro test packages/app/maestro/my-flow.yaml
```

### Screenshots

`takeScreenshot` writes to the **current working directory** — there's no way to configure the output path in the YAML. To keep screenshots out of the checkout, `cd` into a temp directory and use an absolute path for the flow:

```bash
FLOW="$(pwd)/packages/app/maestro/my-flow.yaml"
mkdir -p /tmp/maestro-out
cd /tmp/maestro-out && maestro test "$FLOW"
```

`packages/app/maestro/.gitignore` excludes `*.png` as a safety net.

### Element targeting

Use `testID` or `nativeID` on components, then target with `id:` in flows. Prefer this over text matching — text breaks on copy changes.

The shell exposes stable IDs for navigation (`packages/app/src/components/gumloop-shell/`):

| testID                 | What it is                                                                   |
| ---------------------- | ---------------------------------------------------------------------------- |
| `menu-button`          | Compact header button that opens the mobile drawer                           |
| `gumloop-sidebar`      | The sidebar (pinned on wide layouts, the drawer on compact)                  |
| `sidebar-<key>`        | A sidebar nav row, for example `sidebar-sessions`                            |
| `gumloop-group-<name>` | A collapsible sidebar group: `gumloop-group-tools`, `gumloop-group-projects` |
| `sidebar-project-list` | The project list inside the sidebar                                          |

```tsx
// Component
<Pressable testID="sidebar-sessions" onPress={onPress}>
```

```yaml
# Flow
- tapOn:
    id: "sidebar-sessions"
- assertVisible:
    id: "sidebar-sessions"
```

### Conditional steps

Use `runFlow:when:visible` for steps that should only execute when a specific element is on screen:

```yaml
- runFlow:
    when:
      visible:
        id: "sidebar-sessions"
    commands:
      - swipe:
          direction: LEFT
          duration: 300
```

This is how `flows/dev-client.yaml` handles Expo dev client screens that only appear in dev builds.

### Don't use launchApp against a running dev app

`launchApp` kills and restarts the app, disrupting Expo dev client state and host connections. For flows that test against an already-running dev app, **omit launchApp entirely** and interact with whatever is on screen.

Use `launchApp` only in flows that need a clean start (e.g., onboarding tests).

### Swipe gestures

Use `start`/`end` with percentage coordinates for precise control:

```yaml
# Edge swipe from left to open sidebar
- swipe:
    start: "5%,50%"
    end: "80%,50%"
    duration: 300
```

`direction: RIGHT` is simpler but less precise — use it for generic swipes, use coordinates when the start position matters (edge gestures, avoiding specific UI regions).

### Assertions

`assertVisible` checks **actual screen visibility**, not view tree presence alone. An element that exists in the tree but is off-screen (e.g., `translateX: -400`) will correctly fail `assertVisible`. This makes it reliable for catching animation bugs where state says "open" but the view is visually hidden.

For async elements, use `extendedWaitUntil`:

```yaml
- extendedWaitUntil:
    visible: ".*Online.*"
    timeout: 90000
```

### Dev client handling

Two reusable flows handle Expo dev client screens after launch:

- `flows/launch.yaml` — handles the dev launcher, dismisses the dev menu, and asserts "Welcome to JAgentDesk" when it is visible
- `flows/dev-client.yaml` — same but without asserting a particular app route
- `flows/android-dev-client.yaml` — the Android dev client variant

### Reach the composer

`flows/land-in-chat.yaml` is the canonical "get into a chat" primitive. It `clearState`s, runs `launch.yaml`, taps `welcome-direct-connection`, types `127.0.0.1:6767` into `direct-host-input`, submits, and waits for `message-input-root`. Compose any composer-level fixture on top of it:

```yaml
appId: app.jagentdesk.mobile
---
- runFlow: flows/land-in-chat.yaml
# ...your scenario here, starting from a ready composer
```

See `image-picker-repro.yaml` for an example.

**Use the connection mode required by the test.** `land-in-chat.yaml` targets the production-style daemon on `6767`; a flow against the dev daemon types `127.0.0.1:6768` instead. Remote-pairing flows (`tailscale-pair-*.yaml`) drive the real Tailscale offer and SAS verification, so they need a reachable tailnet.

### New Workspace Creation

The Android workspace-creation regression has a dedicated harness:

```bash
bash packages/app/maestro/test-workspace-create-android-crash.sh
```

For a short recording that starts after launch/connection/sidebar setup:

```bash
bash packages/app/maestro/record-workspace-create-android-focus.sh
```

The flow details are documented in `packages/app/maestro/README.md`. The important rule is that a valid new-workspace assertion must prove the redirect completed: select a real model, tap `Create`, wait for `workspace-header-title`, wait for `message-input-root`, assert `New workspace` is gone, and assert the Android redbox strings are absent. Waiting for the composer alone is too weak because it can still be the `/new` route after a validation error.

New workspace scenarios should compose the reusable subflows in `packages/app/maestro/flows/`:

- `android-dev-client.yaml`
- `connect-direct-if-welcome.yaml`
- `open-prepared-project-sidebar.yaml`
- `new-workspace-open-from-sidebar.yaml`
- `new-workspace-select-codex-gpt54.yaml`
- `new-workspace-submit-and-assert-created.yaml`

The workspace-create shell scripts render those subflows into a temp directory before running Maestro, which keeps nested `runFlow` paths and `${JAGENTDESK_MAESTRO_*}` placeholders working together.

### Inputs that Maestro types into

Maestro `inputText` fires one character at a time. React Native's **controlled** `TextInput` re-renders per keystroke; if a controlled input's state update lags or re-mounts mid-type, characters are dropped silently — the final value on screen is a truncated/scrambled version of what was "typed."

For inputs that E2E flows type into (host endpoint, pairing URL, etc.), use an **uncontrolled ref-backed input**: `defaultValue` + `onChangeText` writes into a `useRef`, reads via the ref on submit. No per-keystroke re-render, no dropped characters.

See `pair-link-modal.tsx` for the pattern (`useRef`-backed `onChangeText`, no `value=` prop). Always pair the source change with a Maestro `assertVisible` on the input's `id + text` after `inputText`, so regressions are caught immediately.

### Menus that launch native presenters (iOS)

A menu item that opens an image picker or document picker on iOS runs a beat after the press. The menu engine owns that delay; see [Selecting an item on iOS](menus.md#selecting-an-item-on-ios). Don't add your own timing shim.

## Self-verification loops

Maestro can only interact with the app UI — it can't toggle iOS appearance, change locale, or simulate network conditions. For bugs that depend on system-level state, wrap Maestro in a bash script that handles the system changes between Maestro runs.

This pattern also lets agents self-verify fixes without manual user testing.

### Pattern

1. Run baseline Maestro flow (confirm feature works)
2. Make system-level change via `xcrun simctl` (toggle appearance, etc.)
3. Re-run Maestro flow (confirm feature still works)
4. Repeat N iterations to catch intermittent failures

Scripts run `maestro test` from inside a temp directory so screenshots don't dirty the checkout.

See `packages/app/maestro/test-sidebar-theme.sh` for the canonical example:

```bash
bash packages/app/maestro/test-sidebar-theme.sh 6 1
# Args: iterations=6, wait_seconds=1 between toggle and test
```

Key elements of the script pattern:

```bash
set -euo pipefail
ITERATIONS="${1:-3}"

for i in $(seq 1 "$ITERATIONS"); do
  # Toggle system state
  xcrun simctl ui booted appearance light

  # Wait for change to propagate
  sleep 1

  # Run Maestro flow and capture result
  if maestro test "$FLOW" 2>&1 | tee "$ITER_DIR/test.log"; then
    echo "PASS"
  else
    echo "FAIL"
    xcrun simctl io booted screenshot "$ITER_DIR/failure-state.png"
  fi
done
```

### Android audio focus interruptions

Voice mode uses the custom `expo-two-way-audio` Android module, so incoming calls and other system audio owners must be tested with emulator/system commands, not a JS-only test. To verify that voice resume handles denied audio focus without crashing:

```bash
adb shell am start -n app.jagentdesk.mobile/.MainActivity
# Start voice mode in an existing composer, then background JAgentDesk with Home.
adb emu gsm call 5551234
# Foreground JAgentDesk while the call is still ringing.
```

Expected result: JAgentDesk does not throw `RuntimeException: Audio focus request failed`; native audio reports an interruption and voice mode stops or pauses coherently.

## Unistyles + Reanimated

Theme-reactive Unistyles styles on a Reanimated `Animated.View` crash on theme change. The rule and the fix live in [unistyles.md](unistyles.md#reanimated-animatedview--dynamic-styles-crashes).

## Chat Stream Layout

Native renders the agent stream with `LegendList` over an end-pinned `ScrollView` (`packages/app/src/agent-stream/strategy-native.tsx`); web uses `strategy-web.tsx`. Both strategies keep chronological order. Platform differences belong on `StreamStrategy` (`packages/app/src/agent-stream/strategy.ts`).

Do not compute stream neighbors, history/live-head seams, turn footer ownership, assistant block spacing, or tool sequence endings inside React render loops. Those policies live in `packages/app/src/agent-stream/layout.ts` and are unit-tested without React Native rendering.

If a chat footer looks duplicated or misplaced on mobile, start with `packages/app/src/agent-stream/layout.test.ts`. Make the pure layout invariant fail first; do not add a React Native renderer test for this class of bug.

## iOS Simulator

```bash
# Screenshot
xcrun simctl io booted screenshot /tmp/screenshot.png

# Dark/light mode
xcrun simctl ui booted appearance          # check current
xcrun simctl ui booted appearance dark     # set dark
xcrun simctl ui booted appearance light    # set light
```

Expo logs are in the terminal running `npm run dev:app` (or `npm run ios`). Daemon logs are at `$JAGENTDESK_HOME/daemon.log` (see [development.md](development.md)). For the simulator fleet and input backends, see [simulators.md](simulators.md).
