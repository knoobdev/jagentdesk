import { useCallback, type ReactNode } from "react";
import { PluginClientStateProvider, usePluginClientStateSource } from "./client-state.js";
import { JAgentDeskApiProvider, useJAgentDeskContextValue } from "./jagentdesk-context.js";
import { PluginRpcProvider, usePluginRpcContextValue } from "./rpc-context.js";

export type PluginRuntimeContextBridge = (children: ReactNode) => ReactNode;

/** Rebuilds plugin runtime contexts inside React Native portal hosts. */
export function usePluginRuntimeContextBridge(): PluginRuntimeContextBridge {
  const jagentdesk = useJAgentDeskContextValue();
  const rpc = usePluginRpcContextValue();
  const state = usePluginClientStateSource();

  if (!jagentdesk || !rpc) {
    throw new Error("Plugin UI must run inside a contributed plugin surface");
  }

  return useCallback(
    (children: ReactNode) => {
      const content = state ? (
        <PluginClientStateProvider source={state}>{children}</PluginClientStateProvider>
      ) : (
        children
      );
      return (
        <JAgentDeskApiProvider jagentdesk={jagentdesk}>
          <PluginRpcProvider invoke={rpc.invoke}>{content}</PluginRpcProvider>
        </JAgentDeskApiProvider>
      );
    },
    [jagentdesk, rpc, state],
  );
}
