import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { FigmaFileRef } from "@/figma/contracts";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

import { callFigma } from "./figma-api";
import {
  assetScopeKey,
  createScopedFontGate,
  retainAssetScope,
  type PrototypeAssetStore,
} from "./asset-store";
import type { PrototypeFontGate } from "./font-loading";

// The player owns its frame/paint assets for exactly as long as it is open on one pinned
// snapshot (ADR-0037 memory rule): the provider retains the store for `file`@`version`, the
// tree below it draws through `usePrototypeAssetScope`, and closing the player — or a file,
// server, or version change under an open player — disposes bytes, stylesheets, and FontFaces.

export interface PrototypeAssetScopeHandle {
  /** `serverId|fileKey|version` the store is pinned to. */
  key: string;
  store: PrototypeAssetStore;
  fontGate: PrototypeFontGate;
  /** Releases the scope; the provider owns the only call site. */
  release: () => void;
}

const AssetScopeContext = createContext<PrototypeAssetScopeHandle | null>(null);

/** The active player scope, or null while none is retained (frame content waits for it). */
export function usePrototypeAssetScope(): PrototypeAssetScopeHandle | null {
  return useContext(AssetScopeContext);
}

function createHandle(client: DaemonClient, key: string): PrototypeAssetScopeHandle {
  const scope = retainAssetScope(key);
  return {
    key,
    store: scope.store,
    fontGate: createScopedFontGate(scope.store, async (family, style) => {
      const data = await callFigma(client, "figma.fonts.get.request", { family, style });
      return data.font;
    }),
    release: scope.release,
  };
}

export function PrototypeAssetScopeProvider({
  file,
  version,
  children,
}: {
  file: FigmaFileRef;
  version: string;
  children: ReactNode;
}) {
  const client = useHostRuntimeClient(file.serverId);
  const key = assetScopeKey(file.serverId, file.fileKey, version);
  const [handle, setHandle] = useState<PrototypeAssetScopeHandle | null>(null);

  // The scope lives in effect state, not in a render-time retain: an unmounted or re-keyed
  // provider can never leave a store retained with nobody drawing on it, and a StrictMode
  // double-cleanup disposes while the re-run retains a fresh store.
  useEffect(() => {
    if (!client) {
      setHandle(null);
      return;
    }
    const scope = createHandle(client, key);
    setHandle(scope);
    return () => {
      setHandle(null);
      scope.release();
    };
  }, [client, key]);

  return <AssetScopeContext.Provider value={handle}>{children}</AssetScopeContext.Provider>;
}
