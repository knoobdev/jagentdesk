// Coded refusals of the physical-device layer (spec 27.3, 27.6). RPC responses carry the bare code
// in `error` so clients map it to their own copy; agent tools append the user-facing message.
export type DeviceErrorCode =
  | "control_disabled"
  | "denied"
  | "unsupported_on_platform"
  | "device_not_found"
  | "device_not_ready"
  | "sideload_unavailable"
  | "account_required"
  | "no_apple_account"
  // Spec 27.4: touch on an iPhone without WebDriverAgent. The app answers with its in-place
  // "Enable touch" dialog; an agent gets apple_account_required when no account is saved.
  | "wda_required"
  | "apple_account_required"
  | "tool_missing";

export class DeviceError extends Error {
  constructor(
    readonly code: DeviceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeviceError";
  }
}
