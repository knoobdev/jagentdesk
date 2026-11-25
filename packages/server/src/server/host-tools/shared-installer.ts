import type { HostToolInstaller } from "./installer.js";

/**
 * The daemon's platform-aware tool installer (spec 24.8, ADR-0024). Bootstrap sets it once the
 * host capability service exists; features read it when they install a CLI. Null until then.
 */
let sharedInstaller: HostToolInstaller | null = null;

export function setSharedHostToolInstaller(installer: HostToolInstaller | null): void {
  sharedInstaller = installer;
}

export function sharedHostToolInstaller(): HostToolInstaller | null {
  return sharedInstaller;
}
