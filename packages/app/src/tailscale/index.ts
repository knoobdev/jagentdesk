export {
  getTailscaleLoginAdapter,
  NativeTailscaleLoginAdapter,
  WebTailscaleLoginAdapter,
} from "./adapter";
export type { DeviceSigningMaterial, TailscaleLoginAdapter } from "./adapter";
export type { JAgentDeskTailscaleNativeModule } from "./adapter";
export {
  ensureHydrated,
  refreshTailscaleStatus,
  getSnapshot,
  getStatus,
  resetForTests,
  subscribe,
  useTailscaleLoginStatus,
} from "./store";
export {
  getTailnetMode,
  setTailnetMode,
  setTailnetModeIfUnset,
  clearTailnetMode,
  subscribe as subscribeTailnetMode,
  useTailnetMode,
} from "./tailnet-mode";
export type { TailnetMode } from "./tailnet-mode";
export {
  classifyPairingCodeEntry,
  isTailscaleReady,
  resolvePairVerifyDecision,
  shouldRoutePairVerifyToTailscaleLogin,
  tailnetModeAfterPairing,
} from "./login-gate";
export type { PairingLinkRoute, PairVerifyDecision } from "./login-gate";
export { reviveTailnetHosts } from "./foreground-revive";
export type { TailnetReviveStore } from "./foreground-revive";
export type { TailscaleLoginResult, TailscaleLoginStatus } from "./types";
