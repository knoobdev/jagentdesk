import Constants from "expo-constants";

/**
 * Returns the native name reported by the operating system for the device
 * running the mobile app. If the operating system does not expose a name, the
 * caller keeps the device in an identity-pending state instead of inventing a
 * hardware label.
 */
export function getMobileDeviceName(): string | undefined {
  const deviceName = Constants.deviceName?.trim();
  return deviceName || undefined;
}
