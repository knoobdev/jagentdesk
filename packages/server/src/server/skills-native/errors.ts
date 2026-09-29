import type { NativeSkillsErrorCode } from "@jagentdesk/protocol/native-skills";

/** A skills operation failure the app can act on; sent as `rpc_error` with `code`. */
export class NativeSkillsError extends Error {
  readonly code: NativeSkillsErrorCode;

  constructor(code: NativeSkillsErrorCode, message: string) {
    super(message);
    this.name = "NativeSkillsError";
    this.code = code;
  }
}

export function isNativeSkillsError(error: unknown): error is NativeSkillsError {
  return error instanceof NativeSkillsError;
}
