import { execFileSync } from "node:child_process";

export const goBuildEnv = {
  ...process.env,
  GOTOOLCHAIN: process.env.GOTOOLCHAIN || "auto",
};

export function tailscaleLdflags(moduleDir) {
  const version = execFileSync("go", ["list", "-m", "-f", "{{.Version}}", "tailscale.com"], {
    cwd: moduleDir,
    env: goBuildEnv,
    encoding: "utf8",
  }).trim();
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected a stable tailscale.com version in ${moduleDir}, got ${version}`);
  }
  // Tailscale's unstamped fallback requires VCS metadata, which source archives
  // and gomobile builds need not carry. Stamp both accessors from go.mod.
  const short = version.slice(1);
  return `-X tailscale.com/version.shortStamp=${short} -X tailscale.com/version.longStamp=${short}-jagentdesk`;
}
