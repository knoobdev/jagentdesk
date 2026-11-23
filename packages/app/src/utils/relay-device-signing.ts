import { getTailscaleLoginAdapter, type DeviceSigningMaterial } from "@/tailscale";

export async function prepareRelayDeviceSigning(): Promise<void> {
  const adapter = getTailscaleLoginAdapter();
  if (adapter.platform === "desktop") await adapter.getStatus();
  if (!adapter.getDeviceSigningMaterial?.()) {
    throw new Error("Device signing is unavailable on this device.");
  }
}

export function getRelayDeviceSigning(): DeviceSigningMaterial | null {
  return getTailscaleLoginAdapter().getDeviceSigningMaterial?.() ?? null;
}
