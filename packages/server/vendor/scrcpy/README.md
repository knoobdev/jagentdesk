# scrcpy-server (vendored)

`scrcpy-server-v5.0.1` is the unmodified server of [scrcpy](https://github.com/Genymobile/scrcpy)
v5.0.1, downloaded from
`https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1`
(sha256 `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`, matching the release's
`SHA256SUMS.txt`). Licensed under the Apache License 2.0 (`LICENSE`); Copyright (C) 2018 Genymobile,
Copyright (C) 2018-2026 Romain Vimont.

The daemon pushes it to `/data/local/tmp` on an Android device whose control the user enabled
(spec 27.1). The server and client versions must match exactly, so the version is pinned in
`src/server/devices/scrcpy.ts` (`SCRCPY_VERSION`); `scrcpy.test.ts` checks the checksum.
