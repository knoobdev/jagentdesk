// Orca's bot mascots (dfdb4fda, MIT, Copyright (c) 2026 Lovecast Inc.; see THIRD_PARTY_NOTICES),
// copied byte for byte into assets/bot-mascots. Requiring them here puts every file in the
// desktop, web and phone bundles; `assets/bot-mascots/*.svg` and `outfits/*.json` stay on disk
// for renderers that read them.
import type { BotMascotId } from "@jagentdesk/protocol/bots/rules";

// The notice travels with the mascots: any bundle that draws one carries Orca's MIT text.
export { THIRD_PARTY_NOTICES } from "@/legal/third-party-notices";

export interface BotMascotAsset {
  /** Desktop and web picture (`shared/bot-mascots/<id>.webp`). */
  image: number;
  /** The picture with a light rim, for dark tiles (`isDarkBotAvatarColor`). */
  rim: number;
  /** The phone picture (`mobile/assets/bot-mascots/<id>.webp`). */
  phone: number;
}

export const BOT_MASCOT_ASSETS: Record<BotMascotId, BotMascotAsset> = {
  A1: {
    image: require("../../assets/bot-mascots/A1.webp"),
    rim: require("../../assets/bot-mascots/A1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/A1.webp"),
  },
  B1: {
    image: require("../../assets/bot-mascots/B1.webp"),
    rim: require("../../assets/bot-mascots/B1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/B1.webp"),
  },
  D1: {
    image: require("../../assets/bot-mascots/D1.webp"),
    rim: require("../../assets/bot-mascots/D1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/D1.webp"),
  },
  E1: {
    image: require("../../assets/bot-mascots/E1.webp"),
    rim: require("../../assets/bot-mascots/E1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/E1.webp"),
  },
  F1: {
    image: require("../../assets/bot-mascots/F1.webp"),
    rim: require("../../assets/bot-mascots/F1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/F1.webp"),
  },
  G1: {
    image: require("../../assets/bot-mascots/G1.webp"),
    rim: require("../../assets/bot-mascots/G1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/G1.webp"),
  },
  H1: {
    image: require("../../assets/bot-mascots/H1.webp"),
    rim: require("../../assets/bot-mascots/H1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/H1.webp"),
  },
  H2: {
    image: require("../../assets/bot-mascots/H2.webp"),
    rim: require("../../assets/bot-mascots/H2-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/H2.webp"),
  },
  I1: {
    image: require("../../assets/bot-mascots/I1.webp"),
    rim: require("../../assets/bot-mascots/I1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/I1.webp"),
  },
  J1: {
    image: require("../../assets/bot-mascots/J1.webp"),
    rim: require("../../assets/bot-mascots/J1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/J1.webp"),
  },
  K2: {
    image: require("../../assets/bot-mascots/K2.webp"),
    rim: require("../../assets/bot-mascots/K2-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/K2.webp"),
  },
  L2: {
    image: require("../../assets/bot-mascots/L2.webp"),
    rim: require("../../assets/bot-mascots/L2-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/L2.webp"),
  },
  M1: {
    image: require("../../assets/bot-mascots/M1.webp"),
    rim: require("../../assets/bot-mascots/M1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/M1.webp"),
  },
  N1: {
    image: require("../../assets/bot-mascots/N1.webp"),
    rim: require("../../assets/bot-mascots/N1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/N1.webp"),
  },
  O1: {
    image: require("../../assets/bot-mascots/O1.webp"),
    rim: require("../../assets/bot-mascots/O1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/O1.webp"),
  },
  P3: {
    image: require("../../assets/bot-mascots/P3.webp"),
    rim: require("../../assets/bot-mascots/P3-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/P3.webp"),
  },
  Q1: {
    image: require("../../assets/bot-mascots/Q1.webp"),
    rim: require("../../assets/bot-mascots/Q1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/Q1.webp"),
  },
  R3: {
    image: require("../../assets/bot-mascots/R3.webp"),
    rim: require("../../assets/bot-mascots/R3-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/R3.webp"),
  },
  S2: {
    image: require("../../assets/bot-mascots/S2.webp"),
    rim: require("../../assets/bot-mascots/S2-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/S2.webp"),
  },
  T1: {
    image: require("../../assets/bot-mascots/T1.webp"),
    rim: require("../../assets/bot-mascots/T1-rim.webp"),
    phone: require("../../assets/bot-mascots/mobile/T1.webp"),
  },
};

/** What a mascot wears (`shared/bot-mascots/outfits/<id>.webp`). */
export const BOT_OUTFIT_ASSETS: Record<string, number> = {
  tie: require("../../assets/bot-mascots/outfits/tie.webp"),
  detective: require("../../assets/bot-mascots/outfits/detective.webp"),
  "hard-hat": require("../../assets/bot-mascots/outfits/hard-hat.webp"),
  reviewer: require("../../assets/bot-mascots/outfits/reviewer.webp"),
  "night-shift": require("../../assets/bot-mascots/outfits/night-shift.webp"),
  artist: require("../../assets/bot-mascots/outfits/artist.webp"),
  scientist: require("../../assets/bot-mascots/outfits/scientist.webp"),
  party: require("../../assets/bot-mascots/outfits/party.webp"),
  security: require("../../assets/bot-mascots/outfits/security.webp"),
};

/** Cut-out mascots for the empty Bots card (`renderer/src/assets/bot-mascot-cutouts`). */
export const BOT_MASCOT_CUTOUTS = {
  A1: require("../../assets/bot-mascots/cutouts/A1-cut.webp"),
  E1: require("../../assets/bot-mascots/cutouts/E1-cut.webp"),
} as const;
