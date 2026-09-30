# Host capabilities and tool installer

A daemon can run on macOS, Linux or Windows. Each host reports what it can run, and missing
command-line tools can be installed for the host's own OS and CPU without root.

## Capabilities

The daemon probes the host in the background after it starts, after every install, and when an app
asks (`host.capabilities.refresh`). Probes run in parallel and never block startup. The result is
sent in `server_info` as `capabilities.host`; when it changes, `server_info` is sent again. Apps that
do not know the field ignore it, and apps treat a host that reports nothing as capable.

Each capability has:

| Field         | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `state`       | `available`, `missing_tool`, `not_running` or `unsupported_os` |
| `reason`      | Why it is not available, shown to the user                     |
| `version`     | Version of the main tool, when there is one                    |
| `installable` | Tools the installer can add to make it available               |

| Capability                         | Available when                                                                                                                         | Unsupported on                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `iosSimulators`                    | `xcrun simctl` runs                                                                                                                    | anything but macOS                                |
| `androidDevices`                   | `adb` and the emulator are found (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, the IDE default folder, or `$JAGENTDESK_HOME/tools/android-sdk`) | Linux arm64 and Windows arm64 (no emulator build) |
| `docker`                           | `docker info` succeeds (`not_running` when the CLI exists but the engine is stopped)                                                   | —                                                 |
| `helm`                             | `helm version` runs                                                                                                                    | —                                                 |
| `proxySystemCapture`               | `networksetup` exists                                                                                                                  | anything but macOS                                |
| `frida`                            | `frida --version` runs                                                                                                                 | —                                                 |
| `tunnel`                           | `cloudflared --version` runs                                                                                                           | —                                                 |
| `maestro`                          | `maestro --version` runs                                                                                                               | —                                                 |
| `java`                             | Java 17 or newer                                                                                                                       | —                                                 |
| `forgeGh`, `forgeGlab`, `forgeTea` | the CLI runs                                                                                                                           | —                                                 |

Code: `packages/server/src/server/host-capabilities/service.ts`, schemas in
`packages/protocol/src/host-capabilities.ts`.

## Tools agents are offered

`unsupported_os` depends only on the OS and CPU, so agent tools are gated without waiting for a
probe. `sim_*`, Frida unpinning and simulator CA trust are registered only on macOS hosts, and
`proxy_capture_start` lists only the capture modes the host supports (`system` on macOS, `frida`
where iOS simulators run).

## Installer

`gh`, `glab`, `tea`, `helm`, `cloudflared` and `maestro` can be installed. The installer tries, in
order:

1. **Already installed** — found on `PATH`, nothing to do.
2. **A package manager that needs no root** — Homebrew, winget (user scope or portable), Scoop.
3. **The vendor's release** for this OS and architecture, downloaded into
   `$JAGENTDESK_HOME/tools/<tool>/<version>` and verified against its SHA-256 before extraction.
   Binaries are exposed through `$JAGENTDESK_HOME/tools/bin`, which is on the daemon's `PATH`.
   Checksums come from the vendor's checksum list or sidecar file; cloudflared uses the digest from
   the GitHub releases API because its release notes list wrong macOS checksums.
4. **Manual** — instructions only. apt, dnf and pacman need root, so they are suggested, never run.

Nothing runs `sudo` or asks for elevation.

`host.tools.plan` returns what would happen (method, version, download URL, size, checksum,
destination) without changing anything. `host.tools.install` carries out a plan made in the last
10 minutes, streams its output, and probes the capabilities again when it finishes. On Windows the
`PATH` is re-read from the registry after winget or Scoop, because they only change it for new
processes.

Forge Hub's CLI installer uses the same installer.

Code: `packages/server/src/server/host-tools/` (`registry.ts` lists the tools and their release
sources, `release.ts` resolves and verifies downloads, `installer.ts` plans and installs).

## App

**Settings → host → Tools** lists every capability with its state, version and reason, has
**Check again**, and installs a missing tool after showing its plan, with live output. The
**Simulators** entry opens on the first host that can run simulators and is hidden when none can.
