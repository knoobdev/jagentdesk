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
  type ScopedFontGate,
} from "./asset-store";

// The player owns its frame/paint assets for exactly as long as it is open on one pinned
// snapshot (ADR-0037 memory rule): the provider retains the store for `file`@`version`, the
// tree below it draws through `usePrototypeAssetScope`, and closing the player — or a file,
// server, or version change under an open player — disposes bytes and FontFaces.
// While the player stays open, memory is trimmed per stage owner: `releaseFrameOwner` frees
// everything a frame instance (base or overlay, on navigation or unmount) claimed, keeping
// only what a simultaneously active owner still shares.

export interface PrototypeAssetScopeHandle {
  /** `serverId|fileKey|version` the store is pinned to. */
  key: string;
  /** The pinned snapshot version — render requests must carry it, or late bytes look current. */
  version: string;
  /** The live client behind this handle — identity-guards the provider value (see below). */
  client: DaemonClient;
  store: PrototypeAssetStore;
  fontGate: ScopedFontGate;
  /** Releases the scope; the provider owns the only call site. */
  release: () => void;
  /** Drops every asset and font claim held by one stage-owner identity. */
  releaseFrameOwner: (ownerId: string) => void;
}

const AssetScopeContext = createContext<PrototypeAssetScopeHandle | null>(null);

/** The active player scope, or null while none is retained (frame content waits for it). */
export function usePrototypeAssetScope(): PrototypeAssetScopeHandle | null {
  return useContext(AssetScopeContext);
}

function createHandle(
  client: DaemonClient,
  key: string,
  version: string,
): PrototypeAssetScopeHandle {
  const scope = retainAssetScope(key);
  const fontGate = createScopedFontGate(scope.store, async (family, style) => {
    const data = await callFigma(client, "figma.fonts.get.request", { family, style });
    return data.font;
  });
  return {
    key,
    version,
    client,
    store: scope.store,
    fontGate,
    release: scope.release,
    releaseFrameOwner(ownerId: string) {
      scope.store.releaseOwner(ownerId);
      fontGate.releaseOwner(ownerId);
    },
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
    const scope = createHandle(client, key, version);
    setHandle(scope);
    return () => {
      setHandle(null);
      scope.release();
    };
  }, [client, key, version]);

  // The handle only swaps inside the effect, so for the render between a server/file/version
  // change and the effect cleanup, children would still see the PREVIOUS snapshot's scope —
  // one pass drawing (or claiming) with bytes and fonts from a file this tree no longer plays.
  // Gate the value by identity: a handle whose key or client differs from the current one is
  // treated as absent, so the switch settles with no old-scope assets observed.
  const current = handle !== null && handle.key === key && handle.client === client ? handle : null;

  return <AssetScopeContext.Provider value={current}>{children}</AssetScopeContext.Provider>;
}
