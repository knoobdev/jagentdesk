// COMPAT(pluginReactNativeEntrypoint): added in v0.9.59, remove after 2027-04-20.
/** @deprecated Import JAgentDesk UI from @jagentdesk/plugin/client/ui. */
export * from "./ui.js";
/** @deprecated Render StreamedText from @jagentdesk/plugin/client/ui. */
export declare function useRevealedText(text: string, phase: "streaming" | "complete"): string;
