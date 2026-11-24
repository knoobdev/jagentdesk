import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { goBuildEnv, tailscaleLdflags } from "../../../scripts/tailscale-build.mjs";

const moduleDir = fileURLToPath(new URL("../go/tsnet-bridge/", import.meta.url));
const outputDir = fileURLToPath(new URL("../dist/server/go/tsnet-bridge/", import.meta.url));
mkdirSync(outputDir, { recursive: true });
execFileSync(
  "go",
  [
    "build",
    "-ldflags",
    tailscaleLdflags(moduleDir),
    "-o",
    path.join(outputDir, "tailnet-bridge"),
    ".",
  ],
  {
    cwd: moduleDir,
    env: goBuildEnv,
    stdio: "inherit",
  },
);
