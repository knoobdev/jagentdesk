import { PluginTranslationProvider, usePluginTranslationRuntime } from "./translations.js";
import { useCallback, type ReactNode } from "react";
import { PluginClientStateProvider, usePluginClientStateSource } from "./client-state.js";
import { JAgentDeskApiProvider, useJAgentDeskContextValue } from "./jagentdesk-context.js";
import { PluginRpcProvider, usePluginRpcContextValue } from "./rpc-context.js";
import {
  PluginComposerProvider,
  PluginComposersProvider,
  usePluginComposerValue,
  usePluginComposersSource,
} from "./composer.js";
import { PluginNewWorkspaceProvider, usePluginNewWorkspaceValue } from "./new-workspace.js";

export type PluginRuntimeContextBridge = (children: ReactNode) => ReactNode;

/** Rebuilds plugin runtime contexts inside React Native portal hosts. */
export function usePluginRuntimeContextBridge(): PluginRuntimeContextBridge {
  const translations = usePluginTranslationRuntime();
  const jagentdesk = useJAgentDeskContextValue();
  const rpc = usePluginRpcContextValue();
  const state = usePluginClientStateSource();
  const composer = usePluginComposerValue();
  const composers = usePluginComposersSource();
  const newWorkspace = usePluginNewWorkspaceValue();

  if (!jagentdesk || !rpc) {
    throw new Error("Plugin UI must run inside a contributed plugin surface");
  }

  return useCallback(
    (children: ReactNode) => {
      const withState = state ? (
        <PluginClientStateProvider source={state}>{children}</PluginClientStateProvider>
      ) : (
        children
      );
      const withComposers = composers ? (
        <PluginComposersProvider source={composers}>{withState}</PluginComposersProvider>
      ) : (
        withState
      );
      const withNewWorkspace = newWorkspace ? (
        <PluginNewWorkspaceProvider newWorkspace={newWorkspace}>
          {withComposers}
        </PluginNewWorkspaceProvider>
      ) : (
        withComposers
      );
      const content = composer ? (
        <PluginComposerProvider composer={composer}>{withNewWorkspace}</PluginComposerProvider>
      ) : (
        withNewWorkspace
      );
      return (
        <JAgentDeskApiProvider jagentdesk={jagentdesk}>
          <PluginRpcProvider invoke={rpc.invoke} subscribe={rpc.subscribe}>
            <PluginTranslationProvider runtime={translations}>{content}</PluginTranslationProvider>
          </PluginRpcProvider>
        </JAgentDeskApiProvider>
      );
    },
    [composer, composers, newWorkspace, jagentdesk, rpc, state, translations],
  );
}
