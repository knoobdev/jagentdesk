import { create } from "zustand";
import type { BotHomeFile } from "@jagentdesk/protocol/bots/views";

/**
 * The newest SOUL.md / MEMORY.md hash each bot's `bots.home_file_changed` push reported. An open
 * editor compares it with the hash it loaded: a different one is "SOUL.md changed on disk."
 */
interface BotHomeFileState {
  diskHashes: Record<string, string>;
  noteDiskHash: (botId: string, file: BotHomeFile, hash: string) => void;
}

export function botHomeFileKey(botId: string, file: BotHomeFile): string {
  return `${botId}:${file}`;
}

export const useBotHomeFileStore = create<BotHomeFileState>()((set) => ({
  diskHashes: {},
  noteDiskHash: (botId, file, hash) =>
    set((state) => ({ diskHashes: { ...state.diskHashes, [botHomeFileKey(botId, file)]: hash } })),
}));
