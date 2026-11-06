import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  createFontGate,
  isItalicStyle,
  weightForStyle,
  type PrototypeFontGate,
  type RequiredFont,
} from "./font-loading";

// Player-scoped asset lifetime (spec 32.5.3, ADR-0037 memory rule): decoded image fills, raster
// fallbacks, injected stylesheets, and FontFace registrations all hang off ONE store per
// server/file/version snapshot, disposed when the player closes or the pinned version changes.
// A module-global cache keyed only by fileKey would hold every visited file's bytes forever and
// let a v2 view paint assets fetched from a v1 snapshot (or another server's identically keyed
// file). Late callbacks — an `Image` decode or an in-flight RPC finishing after close — check
// `disposed` and drop instead of reviving cleared entries.

export interface AssetEntry {
  status: "loading" | "ready" | "failed";
  image: HTMLImageElement | null;
}

export class PrototypeAssetStore {
  readonly key: string;
  private entries = new Map<string, AssetEntry>();
  private listeners = new Set<() => void>();
  private disposers: Array<() => void> = [];
  private isDisposed = false;

  constructor(key: string) {
    this.key = key;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  get(assetKey: string): AssetEntry | undefined {
    return this.entries.get(assetKey);
  }

  /** Claims a fetch slot for `assetKey`; false when a fetch is claimed or done already. */
  claim(assetKey: string): boolean {
    if (this.isDisposed || this.entries.has(assetKey)) return false;
    this.entries.set(assetKey, { status: "loading", image: null });
    return true;
  }

  /** Decodes returned bytes; the ready/failed settle lands only while the scope lives. */
  putDecoded(assetKey: string, bytes: FigmaBytes | null): void {
    if (this.isDisposed) return;
    if (!bytes) {
      this.entries.set(assetKey, { status: "failed", image: null });
      this.notify();
      return;
    }
    this.entries.set(assetKey, { status: "loading", image: null });
    const image = new Image();
    const settle = (status: "ready" | "failed") => {
      // A decode that finishes after the player closed belongs to a dead snapshot: drop it so
      // disposed truly means released, with no listener resurrecting a cleared map.
      if (this.isDisposed) return;
      this.entries.set(assetKey, { status, image: status === "ready" ? image : null });
      this.notify();
    };
    image.addEventListener("load", () => settle("ready"), { once: true });
    image.addEventListener("error", () => settle("failed"), { once: true });
    image.src = `data:${bytes.mimeType};base64,${bytes.dataBase64}`;
  }

  subscribe(listener: () => void): () => void {
    if (this.isDisposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Cleanup for global DOM resources this scope created (stylesheet <link>s, FontFace entries). */
  onDispose(cleanup: () => void): void {
    if (this.isDisposed) {
      cleanup();
      return;
    }
    this.disposers.push(cleanup);
  }

  private notify(): void {
    // Copy so a listener that unsubscribes (or subscribes) mid-notify cannot skew the pass.
    Array.from(this.listeners).forEach((listener) => listener());
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.entries.clear();
    this.listeners.clear();
    const disposers = this.disposers;
    this.disposers = [];
    for (const cleanup of disposers) {
      try {
        cleanup();
      } catch {
        // Global-resource cleanup is best-effort; a missing FontFace must not block release.
      }
    }
  }
}

// ── Scope registry ─────────────────────────────────────────────────────────
// Refcounted so an identity shared by simultaneous owners is disposed exactly once, and so a
// closed player's snapshot cannot be reused after its entries were cleared.

interface ScopeRecord {
  store: PrototypeAssetStore;
  refs: number;
}

const scopes = new Map<string, ScopeRecord>();

export interface RetainedAssetScope {
  store: PrototypeAssetStore;
  release: () => void;
}

export function retainAssetScope(key: string): RetainedAssetScope {
  let record = scopes.get(key);
  if (!record) {
    record = { store: new PrototypeAssetStore(key), refs: 0 };
    scopes.set(key, record);
  }
  record.refs += 1;
  const held = record;
  let released = false;
  return {
    store: held.store,
    release() {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs <= 0) {
        if (scopes.get(key) === held) scopes.delete(key);
        held.store.dispose();
      }
    },
  };
}

/** Test/diagnostic peek at the live store for an identity, if any owner holds it. */
export function peekAssetScope(key: string): PrototypeAssetStore | undefined {
  return scopes.get(key)?.store;
}

export function assetScopeKey(serverId: string, fileKey: string, version: string): string {
  return `${serverId}|${fileKey}|${version}`;
}

// ── Scope-bound font gate ──────────────────────────────────────────────────
// One gate per snapshot, shared by every frame the player paints: the loaded/attempted cache
// stops re-fetching `figma.fonts.get` bytes per frame, and the global DOM resources it creates
// (Google Fonts <link>s, FontFace registrations) are disposed with the scope.

export function createScopedFontGate(
  store: PrototypeAssetStore,
  loadFontBytes: (family: string, style: string) => Promise<FigmaBytes | null>,
): PrototypeFontGate {
  return createFontGate({
    appendStylesheet: (href: string) =>
      new Promise<void>((resolve) => {
        if (typeof document === "undefined" || store.disposed) {
          resolve();
          return;
        }
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        const done = () => resolve();
        link.addEventListener("load", done, { once: true });
        link.addEventListener("error", done, { once: true });
        document.head.appendChild(link);
        store.onDispose(() => link.remove());
      }),
    loadFontBytes: (family, style) =>
      store.disposed ? Promise.resolve(null) : loadFontBytes(family, style),
    registerFontFace: async (font: RequiredFont, bytes: FigmaBytes) => {
      if (typeof document === "undefined" || typeof FontFace === "undefined") return false;
      try {
        const face = new FontFace(
          font.family,
          `url(data:${bytes.mimeType};base64,${bytes.dataBase64})`,
          {
            weight: String(weightForStyle(font.style)),
            style: isItalicStyle(font.style) ? "italic" : "normal",
          },
        );
        await face.load();
        if (store.disposed) return false;
        document.fonts.add(face);
        store.onDispose(() => {
          try {
            document.fonts.delete(face);
          } catch {
            // jsdom/older browsers may not implement delete; nothing to leak in them anyway.
          }
        });
        return true;
      } catch {
        return false;
      }
    },
    isFontLoaded: (family, style) => {
      if (typeof document === "undefined" || !document.fonts) return false;
      try {
        const italic = isItalicStyle(style) ? "italic " : "";
        return document.fonts.check(`${italic}${weightForStyle(style)} 16px "${family}"`);
      } catch {
        return false;
      }
    },
    fontsReady: () => {
      if (typeof document === "undefined" || !document.fonts?.ready) return Promise.resolve();
      return document.fonts.ready.then(() => undefined);
    },
  });
}
