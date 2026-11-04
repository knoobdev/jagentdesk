import { AndroidError } from "./android.js";
import { AnisetteError } from "./apple/anisette.js";
import { GsaError } from "./apple/gsa.js";
import { AppleHttpError } from "./apple/http.js";
import { TeamApiError } from "./apple/team-api.js";
import { BundleEditError } from "./bundle.js";
import { IosDeviceError } from "./ios-devices.js";
import { IpaError } from "./ipa.js";
import { MachoError } from "./macho.js";
import { ProcessStartError } from "./process.js";
import { SignError } from "./signer.js";
import { ZipError } from "./zip.js";

/** One error type at the sideload boundary: a code the app branches on + English copy. */
export class SideloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SideloadError";
  }
}

export function toSideloadError(error: unknown): SideloadError {
  if (error instanceof SideloadError) return error;
  if (error instanceof GsaError) return new SideloadError(error.code, error.message);
  if (error instanceof AnisetteError) {
    return new SideloadError(
      "anisette_failed",
      `${error.message} Try another anisette source in the account settings.`,
    );
  }
  if (error instanceof TeamApiError) {
    const code = error.code === "session_expired" ? "sign_in_required" : "apple_error";
    return new SideloadError(code, error.message);
  }
  if (error instanceof IpaError) return new SideloadError(error.code, error.message);
  if (error instanceof BundleEditError) return new SideloadError(error.code, error.message);
  if (error instanceof IosDeviceError) return new SideloadError(error.code, error.message);
  if (error instanceof AndroidError) return new SideloadError(error.code, error.message);
  if (error instanceof SignError) return new SideloadError("sign_failed", error.message);
  if (error instanceof AppleHttpError) {
    return new SideloadError("network_error", `Could not reach ${error.host}: ${error.message}`);
  }
  if (error instanceof ProcessStartError) {
    return new SideloadError("tool_failed", `${error.command}: ${error.message}`);
  }
  if (error instanceof ZipError || error instanceof MachoError) {
    return new SideloadError("not_an_ipa", error.message);
  }
  if (error instanceof Error) return new SideloadError("internal_error", error.message);
  return new SideloadError("internal_error", String(error));
}
