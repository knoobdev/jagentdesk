export type PluginProcessRequest =
  | { type: "initialize"; pluginId: string; bundle: string }
  | { type: "invoke"; requestId: string; method: string; input: unknown }
  | { type: "shutdown" }
  | { type: "jagentdesk_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "jagentdesk_close" };

export type PluginProcessMessage =
  | { type: "ready"; methods: string[] }
  | { type: "result"; requestId: string; output: unknown }
  | { type: "error"; requestId: string; error: string }
  | { type: "fatal"; error: string }
  | { type: "jagentdesk_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "jagentdesk_close" };
