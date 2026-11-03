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
