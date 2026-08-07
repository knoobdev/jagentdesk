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
  getConnectionMode,
  setConnectionMode,
  clearConnectionMode,
  subscribe as subscribeConnectionMode,
  useConnectionMode,
} from "./connection-mode";
export type { ConnectionMode } from "./connection-mode";
export {
  classifyPairingCodeEntry,
  isTailscaleReady,
  shouldRoutePairVerifyToTailscaleLogin,
} from "./login-gate";
export type { TailscaleLoginResult, TailscaleLoginStatus } from "./types";
