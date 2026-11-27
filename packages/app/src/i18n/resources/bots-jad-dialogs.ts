// JAgentDesk-only bots strings for the dialogs surfaces (spec 37), under `bots.jad.dialogs`.
// The New bot dialog's Provider and Model pickers (spec 37.5 part 5; Orca picks a Computer and an Agent).
export const botsJadDialogsStrings = {
  provider: "Provider",
  model: "Model",
  choose: "Choose…",
  searchProviders: "Search providers",
  searchModels: "Search models",
  noMatches: "No matches",
  // The picture picker's chooser (Orca offers "<upload>Upload</upload>, drop, or paste an image";
  // paste and drop are not ported).
  uploadPicture: "Upload an image",
} as const;
