# JAgentDesk client

This package contains the shared Expo client used by JAgentDesk on iOS, Android,
and the Electron desktop wrapper.

Run it from the repository root with:

```bash
npm run dev:app
```

The app connects to a JAgentDesk daemon through a local connection or Tailscale.
Remote devices must complete the pairing flow and six-digit device verification
before they can control a daemon.

Mobile simulator builds are created through the EAS profiles in `eas.json`.

## Dictation debugging

Set `EXPO_PUBLIC_ENABLE_AUDIO_DEBUG=1` before starting Expo to render the in-app
audio debug card. Pair it with `STT_DEBUG_AUDIO_DIR` on the daemon to save raw
dictation audio for local diagnosis.
