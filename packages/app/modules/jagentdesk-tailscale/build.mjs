import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { goBuildEnv, tailscaleLdflags } from "../../../../scripts/tailscale-build.mjs";

const platform = process.argv[2] || process.env.EAS_BUILD_PLATFORM;
if (platform !== "ios" && platform !== "android") {
  throw new Error("Usage: node build.mjs ios|android [output path]");
}
const moduleDir = fileURLToPath(new URL("./go/tailscale-bridge/", import.meta.url));
const output = path.resolve(
  process.argv[3] ||
    fileURLToPath(
      new URL(
        platform === "ios"
          ? "./ios/TailscaleBridgeNative.xcframework"
          : "./android/libs/tailscale-bridge.aar",
        import.meta.url,
      ),
    ),
);
mkdirSync(path.dirname(output), { recursive: true });
// Build the tools from this module's pinned x/mobile dependency with its Go
// toolchain. A globally installed gobind may use an older Go/types parser.
const toolDir = mkdtempSync(path.join(tmpdir(), "jagentdesk-gomobile-"));
try {
  for (const tool of ["gomobile", "gobind"]) {
    execFileSync(
      "go",
      ["build", "-o", path.join(toolDir, tool), `golang.org/x/mobile/cmd/${tool}`],
      {
        cwd: moduleDir,
        env: goBuildEnv,
        stdio: "inherit",
      },
    );
  }
  execFileSync(
    path.join(toolDir, "gomobile"),
    [
      "bind",
      // Match the module's Swift import and Android minSdkVersion.
      ...(platform === "ios"
        ? ["-target=ios,iossimulator", "-iosversion=15.1"]
        : ["-target=android", "-androidapi=23"]),
      "-ldflags",
      tailscaleLdflags(moduleDir),
      "-o",
      output,
      ".",
    ],
    {
      cwd: moduleDir,
      env: { ...goBuildEnv, PATH: `${toolDir}${path.delimiter}${process.env.PATH}` },
      stdio: "inherit",
    },
  );
} finally {
  rmSync(toolDir, { recursive: true, force: true });
}
