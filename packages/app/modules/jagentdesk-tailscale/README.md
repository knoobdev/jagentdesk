# JAgentDesk Tailscale native module

This module ships the embedded `tsnet` bridge for iOS and Android. Both
platforms use the same Go bridge and keep Tailscale state under the app's
private application-support directory. The JavaScript client connects to the
bridge's loopback proxy while the bridge dials the daemon through the tailnet.

The app's iOS/Android npm commands, EAS post-install hook, and release jobs
rebuild the native artifacts. For a direct Xcode/Gradle build, rebuild them
from the repository root first:

```sh
node packages/app/modules/jagentdesk-tailscale/build.mjs ios
node packages/app/modules/jagentdesk-tailscale/build.mjs android
```

The script builds the pinned gomobile/gobind tools using the module's Go
version, then binds the iOS device/simulator xcframework or the Android AAR
(arm64, armv7, x86, x86_64). Android requires the SDK and NDK. An optional
second argument selects an output path. Release jobs run these same commands
so checked-in native artifacts cannot hide an outdated Go dependency.

Both native builds and `npm run build:tsnet-bridge` stamp Tailscale's short
and long versions from their respective `go.mod`. The stamps are required
because Tailscale's fallback needs VCS metadata absent from source archives
and gomobile outputs. The daemon bridge's `--version` flag prints both values.
Do not replace the native module with a JS-only success response: a missing or
failed bridge must continue to report `unavailable` and keep the Local option
available.
