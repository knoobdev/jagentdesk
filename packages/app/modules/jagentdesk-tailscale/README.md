# JAgentDesk Tailscale native module

This module ships the embedded `tsnet` bridge for iOS and Android. Both
platforms use the same Go bridge and keep Tailscale state under the app's
private application-support directory. The JavaScript client connects to the
bridge's loopback proxy while the bridge dials the daemon through the tailnet.

The Android AAR in `android/libs/tailscale-bridge.aar` is generated from
`go/tailscale-bridge` with `gomobile bind` for arm64, armv7, x86, and x86_64.
Do not replace the native module with a JS-only success response: a missing or
failed bridge must continue to report `unavailable` and keep the Local option
available.
