import type { PairingDeviceListResponse } from "@jagentdesk/protocol/messages";

export type PairedDevice = PairingDeviceListResponse["payload"]["devices"][number];

/** Newest pairing first; a host can carry dozens of stale entries and the fresh one is on top. */
export function sortPairedDevices(devices: readonly PairedDevice[]): PairedDevice[] {
  return [...devices].sort((left, right) => right.pairedAtMs - left.pairedAtMs);
}

export function filterPairedDevices(
  devices: readonly PairedDevice[],
  query: string,
): PairedDevice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...devices];
  return devices.filter((device) =>
    [device.deviceName ?? "", device.kind ?? "", device.deviceId].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}
