# iOS simulators (SimFleet)

SimFleet is one control plane for the host's iOS simulators, shared by the human UI (the
**Simulators** screen) and agents (the `sim_*` tools on the `jagentdesk` MCP server). It is
macOS-only and shells out to `xcrun simctl`, plus `idb` or Maestro for input. Off macOS the
daemon reports `availability.simctl = false` instead of erroring.

Code: `packages/server/src/server/simulator/`, wire schemas in
`packages/protocol/src/simulator/rpc-schemas.ts`, UI in `packages/app/src/screens/sim-*.tsx`.

## Input backends

Tap / swipe / type and the element tree need a device-level HID driver; macOS mouse events
don't reach the Simulator (`CGEventPostToPid` is ignored, and a global post moves the user's
cursor).

| Backend                   | Used when                            | Notes                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idb` (+ `idb_companion`) | `idb list-targets` succeeds          | Fast, native HID. Current companion builds need macOS 15 / Xcode 26. `idb --version` is not a valid probe.                                                                                                          |
| Maestro                   | idb is missing, `maestro` is on PATH | On-device XCUITest driver. First `maestro hierarchy` on a device starts the driver and can take ~1 min — the UI shows "Preparing touch input…". Point coordinates must be **integer** percentages (decimals throw). |
| none                      | neither                              | Lifecycle, screenshots, logs and deep links still work.                                                                                                                                                             |

Hardware buttons (Home / Lock) are idb-only.

## Headless, and why Simulator.app still matters

`simctl boot` never opens Simulator.app. But if the user _already_ has Simulator.app open, it
attaches a window to every booted device in the default device set, and by default quitting
it or closing that window **shuts the device down**, killing a simulator an agent is driving.
Before booting, the daemon sets Simulator.app's `DetachOnAppQuit` and `DetachOnWindowClose`
preferences so quit/close only detach the window.

- `AttachBootedOnStart = NO` does not stop the adoption; don't rely on it.
- A private device set (`simctl --set <dir>`) would hide devices from Simulator.app entirely,
  but Maestro only sees the default set ("Device … is not connected"), so SimFleet stays on
  the default set while Maestro is the input backend.

## Screenshots are JPEG, sized to the view

A full-resolution PNG is 1.2–4.6 MB per frame (4.6 MB for an iPad). Polling a fleet of those
over the daemon WebSocket starved the liveness ping, and the app dropped the connection with
`Transport closed (code 1006)`. Live views request `format: "jpeg"` plus a `maxDim` long-edge
cap sized to what they draw: tiles 480 px (~20 KB), the detail view 1600 px (~150 KB), and
agents 1568 px, the model's own downsampling limit. Downscaling uses macOS `sips`. The next
frame is only requested after the previous one lands, so slow captures can't pile up.

Omitting `format` still returns the original full PNG in `pngBase64`; newer clients read
`imageBase64` + `mimeType` + the frame's pixel `width`/`height`.

## Device mockups

The UI draws each device as the real hardware, not a generic phone, so a screenshot fills the
screen with zero crop:

- Classification uses Apple's **device type name** (the daemon maps each device's
  `deviceTypeIdentifier` through `simctl list devicetypes`), never the user-chosen device
  name, which can be anything.
- Touch-ID devices (iPhone SE / 6s–8, iPod touch, home-button iPads) get a rectangular screen
  with forehead, chin and home button. Face-ID devices get Apple's per-generation screen
  corner radius and a uniform bezel.
- Bezels come from Apple's tech-spec enclosure size (mm) versus the active display size
  (native px ÷ ppi), per model. The table and the corner radii live in
  `packages/app/src/screens/sim-device-spec.ts` with unit tests next to it.
- The screen aspect comes from the frame's actual pixel size, so an unknown future model
  still fits exactly.

## Fleet refresh

`simctl` has no event stream, so the fleet is a 2.5 s sweep of `simctl list devices`. After its
own actions (boot, create, delete…) the UI re-lists immediately rather than waiting for the
sweep. The sweep deliberately does not read the "slim" state: that spawns `launchctl` per
booted device on every tick. `sim_slim` / `sim_unslim` report the state they leave behind.

## Verifying changes

Drive the real app through CDP (`--remote-debugging-port`), never the host mouse. The desktop
app keeps hidden copies of screens mounted, so filter to elements with a non-zero bounding
box or measurements hit the hidden copy. Erase / Delete confirm through a **native** macOS
dialog (`desktopApi.dialog.ask`). Clicking them from an automated test pops a real dialog on
the user's screen.
