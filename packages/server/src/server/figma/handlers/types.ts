import type {
  FigmaRequest,
  FigmaRequestType,
  FigmaResponseData,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaContext } from "../context.js";

/** Per-session facts a handler may need (OAuth loopback on desktop, delegation, ownership). */
export interface FigmaSessionInfo {
  sessionKey: string;
  /** True when this client is the Electron desktop and can run the 127.0.0.1:8766 callback. */
  canRunLoopback: boolean;
}

export type FigmaRequestOf<T extends FigmaRequestType> = Extract<FigmaRequest, { type: T }>;

export type FigmaHandler<T extends FigmaRequestType> = (
  request: FigmaRequestOf<T>,
  ctx: FigmaContext,
  session: FigmaSessionInfo,
) => Promise<FigmaResponseData<T>>;

export type FigmaHandlerMap<K extends FigmaRequestType> = { [T in K]: FigmaHandler<T> };
