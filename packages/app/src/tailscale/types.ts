export type TailscaleLoginStatus =
  | { kind: "unknown" }
  | { kind: "connecting" }
  | { kind: "needs-login" }
  | { kind: "connected" }
  | { kind: "unavailable" };

export interface TailscaleLoginResult {
  ok: boolean;
  error?: string;
}
