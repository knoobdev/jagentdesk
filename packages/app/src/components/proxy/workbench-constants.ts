// The Workbench (intercepting-proxy) tool wears Burp Suite's look, whose signature is a warm
// orange accent used for the active tool tab and the primary action ("Send", "Start capture").
// It is a fixed brand-style accent independent of the app theme, so it lives as a constant rather
// than a theme token.
export const WB_ORANGE = "#ff6633";
export const WB_ORANGE_DIM = "#e2571f";

// The Burp top-level tools, in Burp's own order. P1 marks which are functional; the rest render a
// phase placeholder so the shell already matches Burp while the tools land incrementally.
export type WorkbenchTab =
  | "captures"
  | "proxy"
  | "target"
  | "repeater"
  | "intruder"
  | "sequencer"
  | "decoder"
  | "comparer"
  | "logger";

export interface WorkbenchTabDef {
  key: WorkbenchTab;
  label: string;
  ready: boolean; // implemented in the current phase
}

export const WORKBENCH_TABS: WorkbenchTabDef[] = [
  { key: "captures", label: "Captures", ready: true },
  { key: "proxy", label: "Proxy", ready: true },
  { key: "target", label: "Target", ready: true },
  { key: "repeater", label: "Repeater", ready: true },
  { key: "intruder", label: "Intruder", ready: true },
  { key: "sequencer", label: "Sequencer", ready: true },
  { key: "decoder", label: "Decoder", ready: true },
  { key: "comparer", label: "Comparer", ready: true },
  { key: "logger", label: "Logger", ready: true },
];
