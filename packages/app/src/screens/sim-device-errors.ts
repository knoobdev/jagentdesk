import type { SimDevice, SimReadiness } from "@jagentdesk/protocol/simulator/rpc-schemas";

// Coded refusals of the physical-device layer (spec 27.3, 27.6) → copy shown next to the action.
const ERROR_COPY: Record<string, string> = {
  control_disabled: "Control of this device is off. Enable control first.",
  denied: "Not allowed for this agent session.",
  unsupported_on_platform: "This device does not support that action.",
  device_not_found: "The device is no longer connected to the host.",
  device_not_ready: "The device is not ready yet. Follow the steps above.",
  sideload_unavailable: "Signing with an Apple account is not available on this host yet.",
  account_required: "Choose the Apple account to sign WebDriverAgent with.",
  no_apple_account: "Add an Apple account in Sideload first.",
  tool_missing: "A tool this device needs is not installed on the host.",
  binary_screen_frames_unsupported: "This host cannot stream the screen to this app version.",
};

export function deviceErrorCopy(error: string): string {
  return ERROR_COPY[error] ?? error;
}

// Spec 27.4: what the user does on the device for each readiness step.
export const READINESS_COPY: Record<Exclude<SimReadiness, "ready">, string> = {
  needs_usb_debugging:
    "Unlock the phone and accept the Allow USB debugging prompt. If no prompt appears, turn on USB debugging in Developer options and reconnect the cable.",
  needs_trust: "Unlock the device and tap Trust on the Trust This Computer prompt.",
  needs_unlock: "Unlock the device. Control resumes on its own once it is unlocked.",
  needs_developer_mode:
    "Turn on Developer Mode in Settings > Privacy & Security, restart the device and confirm with the passcode.",
  needs_wda:
    "Prepare the device: WebDriverAgent is signed with your Apple account and installed on it. A free account uses one of its 3 app slots and the signature lasts 7 days (renewed automatically).",
  wda_expired: "WebDriverAgent expired. Prepare the device again to re-sign it.",
  offline: "The device is offline. Reconnect the cable or Wi-Fi.",
};

export function connectionLabel(device: SimDevice): string {
  if (device.kind === "emulator") return "Emulator";
  if (device.connection === "wifi") return "Wi-Fi";
  if (device.connection === "usb") return "USB";
  return "";
}
