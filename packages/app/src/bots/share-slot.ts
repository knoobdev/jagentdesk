// Bot sharing is bt5's (spec 37.13, branch plat/bt5-share). Settings › Sharing and the panel's
// "Share bot…" mount whatever it registers here; until then the Sharing row says sharing needs the
// newer app build. bt5 calls `registerBotShareSurface` from its module.
import type { ComponentType } from "react";
import { create } from "zustand";
import type { Bot } from "@jagentdesk/protocol/bots/types";

export interface BotShareSurfaceProps {
  serverId: string;
  bot: Bot;
  /** Leaves the share page (Settings' back). */
  onClose: () => void;
}

export interface BotShareReceiveProps {
  serverId: string;
  onClose: () => void;
}

interface BotShareSlotState {
  Surface: ComponentType<BotShareSurfaceProps> | null;
  /** "From a link…": paste a link, review, create (spec 37.13.3). */
  Receive: ComponentType<BotShareReceiveProps> | null;
}

export const useBotShareSlot = create<BotShareSlotState>()(() => ({
  Surface: null,
  Receive: null,
}));

export function registerBotShareSurface(Surface: ComponentType<BotShareSurfaceProps>): void {
  useBotShareSlot.setState({ Surface });
}

export function registerBotShareReceive(Receive: ComponentType<BotShareReceiveProps>): void {
  useBotShareSlot.setState({ Receive });
}
