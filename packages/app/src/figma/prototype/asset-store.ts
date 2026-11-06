import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  isItalicStyle,
  weightForStyle,
  type PrototypeFontGate,
  type RequiredFont,
} from "./font-loading";

// Player-scoped asset lifetime (spec 32.5.3, ADR-0037 memory rule): decoded image fills, raster
// fallbacks, and FontFace registrations hang off ONE store per
// server/file/version snapshot — but the store must not become a second global cache. Memory is
// released per stage owner: every asset is claimed for the frame instance that draws it, and a
// claim frees the entry the moment no simultaneously active owner holds it, while the player
// stays open. `dispose` (close, version switch) sweeps what remains. Late callbacks — an `Image`
// decode or an in-flight RPC finishing after its owner was released — carry the claim's
// generation token and drop instead of resurrecting cleared entries or a newer generation.

export interface AssetEntry {
  status: "loading" | "ready" | "failed";
  image: HTMLImageElement | null;
}

/** Proof that a claim started the fetch; `putDecoded` accepts a settle only for its own claim. */
export interface AssetClaim {
  assetKey: string;
  generation: number;
}

interface AssetRecord extends AssetEntry {
  owners: Set<string>;
  generation: number;
}

export class PrototypeAssetStore {
  readonly key: string;
  private entries = new Map<string, AssetRecord>();
  // Per-key generation counters survive releases: a late settle for generation N must not
  // stomp a re-claimed key now running at generation N+1.
  private generations = new Map<string, number>();
  private ownerKeys = new Map<string, Set<string>>();
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

  /**
   * Attaches `ownerId` to `assetKey`. Returns the claim when THIS call started the fetch — the
   * caller must fetch and settle with `putDecoded(key, bytes, claim)`. Returns null when the
   * asset is already held by another simultaneously active owner (sharing, no second fetch) or
   * already settled, and on a disposed store.
   */
  claim(ownerId: string, assetKey: string): AssetClaim | null {
    if (this.isDisposed) return null;
    const record = this.entries.get(assetKey);
    if (record) {
      record.owners.add(ownerId);
      this.trackOwner(ownerId, assetKey);
      return null;
    }
    const generation = (this.generations.get(assetKey) ?? 0) + 1;
    this.generations.set(assetKey, generation);
    const created: AssetRecord = {
      status: "loading",
      image: null,
      owners: new Set([ownerId]),
      generation,
    };
    this.entries.set(assetKey, created);
    this.trackOwner(ownerId, assetKey);
    return { assetKey, generation };
  }

  /** Decodes returned bytes; the settle lands only while its own claim still owns the entry. */
  putDecoded(assetKey: string, bytes: FigmaBytes | null, claim: AssetClaim): void {
    if (this.isDisposed) return;
    const record = this.entries.get(assetKey);
    // Released mid-fetch, or superseded by a newer claim: drop the late completion entirely —
    // it must not resurrect the entry or overwrite the generation that replaced it.
    if (!record || record.generation !== claim.generation || record.status !== "loading") return;
    if (!bytes) {
      record.status = "failed";
      this.notify();
      return;
    }
    const image = new Image();
    const settle = (status: "ready" | "failed") => {
      // A decode that finishes after the owning frame navigated away belongs to a dead claim:
      // drop it so released truly means released, with no callback reviving cleared memory.
      if (this.isDisposed || this.entries.get(assetKey) !== record) return;
      record.status = status;
      record.image = status === "ready" ? image : null;
      this.notify();
    };
    image.addEventListener("load", () => settle("ready"), { once: true });
    image.addEventListener("error", () => settle("failed"), { once: true });
    image.src = `data:${bytes.mimeType};base64,${bytes.dataBase64}`;
  }

  /**
   * Drops every claim held by `ownerId` — a reused FrameContent on its previous root, or a frame
   * that left the stage. Entries no other active owner holds are freed (decoded image, bytes,
   * fetch slot); entries shared with a still-active owner survive.
   */
  releaseOwner(ownerId: string): void {
    const keys = this.ownerKeys.get(ownerId);
    if (!keys) return;
    this.ownerKeys.delete(ownerId);
    for (const assetKey of keys) {
      const record = this.entries.get(assetKey);
      if (!record) continue;
      record.owners.delete(ownerId);
      if (record.owners.size === 0) this.entries.delete(assetKey);
    }
  }

  /**
   * Cache-HIT attach for the draw path: the renderer only reports a missing asset once the
   * getter comes back empty, so a frame drawing on an asset another active owner fetched must
   * attach HERE or the first release would free bytes the new frame still paints with. Attaches
   * to an existing record only — never starts a fetch, which would consume the claim slot
   * before `onMissing` and stall the real fetch forever.
   */
  attachOwner(ownerId: string, assetKey: string): boolean {
    if (this.isDisposed) return false;
    const record = this.entries.get(assetKey);
    if (!record) return false;
    record.owners.add(ownerId);
    this.trackOwner(ownerId, assetKey);
    return true;
  }

  /** True while any live owner holds the asset — diagnostics for lifetime regressions. */
  isHeld(assetKey: string): boolean {
    return this.entries.has(assetKey);
  }

  subscribe(listener: () => void): () => void {
    if (this.isDisposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Cleanup hook for global DOM resources a scope creates (e.g. attached nodes). */
  onDispose(cleanup: () => void): void {
    if (this.isDisposed) {
      cleanup();
      return;
    }
    this.disposers.push(cleanup);
  }

  private trackOwner(ownerId: string, assetKey: string): void {
    let keys = this.ownerKeys.get(ownerId);
    if (!keys) {
      keys = new Set();
      this.ownerKeys.set(ownerId, keys);
    }
    keys.add(assetKey);
  }

  private notify(): void {
    // Copy so a listener that unsubscribes (or subscribes) mid-notify cannot skew the pass.
    Array.from(this.listeners).forEach((listener) => listener());
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.entries.clear();
    this.ownerKeys.clear();
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
// Production player fonts come from the daemon's CACHED bytes (spec 32.5.1), NOT the browser's
// Google Fonts stylesheet network. This gate deliberately appends no `<link>` and issues no
// client CSS request: a face is honoured only when an actual matching FontFace is ALREADY
// registered and loaded (real evidence, not `fonts.check`), otherwise the bytes are fetched once
// from `loadFontBytes` (the `figma.fonts.get` RPC) and registered locally. Load bounding the
// player needs to stay stable while a font is unavailable: loads are singleflight (concurrent
// claims share the SAME in-flight promise), and a failed family is remembered for the gate's
// lifetime so a blocked font settles into the renderer's raster fallback instead of re-arming a
// fetch/rerender loop every draw. Fonts are claimed per stage owner and the FontFace is
// unregistered when the last active owner releases, while the player stays open. W8's
// `createFontGate` owns the generic loader semantics and the shared font/style pure helpers;
// this wrapper composes the same exported primitives and never edits that file.

export interface ScopedFontGate extends PrototypeFontGate {
  /**
   * Loads `fonts` on behalf of a stage owner. Returns true only when a font became newly
   * available — callers repaint on true and must ignore false (a settled failure repaints as
   * the raster fallback through the normal missing-asset path, never by re-arming this call).
   */
  loadForOwner(ownerId: string, fonts: readonly RequiredFont[]): Promise<boolean>;
  /** Drops the owner's font claims; the last release unregisters the face/link it held. */
  releaseOwner(ownerId: string): void;
}

interface FontRecord {
  key: string;
  status: "loading" | "loaded" | "failed";
  promise: Promise<boolean>;
  owners: Set<string>;
  unregister: (() => void) | null;
}

export function createScopedFontGate(
  store: PrototypeAssetStore,
  loadFontBytes: (family: string, style: string) => Promise<FigmaBytes | null>,
): ScopedFontGate {
  const fontKey = (family: string, style: string) => `${family}\u0000${style}`;
  const records = new Map<string, FontRecord>();
  const ownerFonts = new Map<string, Set<string>>();
  // Lifetime memory: a family whose daemon bytes failed or went missing is never retried by
  // this gate — the attempt is remembered so the font settles into the renderer's raster
  // fallback instead of re-arming a fetch/rerender loop on every draw.
  const permanentlyFailed = new Set<string>();
  // Closing the scope (player close / version switch) frees EVERY registration this gate holds,
  // including the unguarded "unowned" claims: a dead snapshot keeps no global FontFace.
  store.onDispose(() => {
    for (const record of records.values()) {
      if (record.status === "loaded" && record.unregister) record.unregister();
    }
    records.clear();
    ownerFonts.clear();
  });

  // Real availability proof: `document.fonts.check` returns true even for nonexistent families
  // (MDN documents `i-dont-exist` => true), so it cannot certify that the requested face exists.
  // A font counts as available only when an actual FontFace matching family + weight + style is
  // registered AND fully loaded (`status === "loaded"` — a stylesheet-declared @font-face sits
  // in the set unloaded until the browser fetches it). Without that evidence the caller settles
  // into the renderer's real-Figma raster fallback (W8-owned).
  function loadedFaceMatches(family: string, style: string): boolean {
    if (typeof document === "undefined" || !document.fonts) return false;
    const wantWeight = String(weightForStyle(style));
    const wantStyle = isItalicStyle(style) ? "italic" : "normal";
    const normalise = (value: string) =>
      value
        .replace(/^["']|["']$/g, "")
        .toLowerCase()
        .trim();
    try {
      for (const face of Array.from(document.fonts)) {
        // Only a genuinely loaded face is evidence; @font-face entries declared by a stylesheet
        // sit in the set as "unloaded"/"loading" until the browser actually fetches them.
        if ((face as { status?: string }).status !== "loaded") continue;
        if (
          normalise(face.family) === normalise(family) &&
          String(face.weight) === wantWeight &&
          face.style === wantStyle
        ) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  async function registerFace(font: RequiredFont, bytes: FigmaBytes, record: FontRecord) {
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
      if (store.disposed || record.owners.size === 0) return false;
      document.fonts.add(face);
      record.unregister = () => {
        try {
          document.fonts.delete(face);
        } catch {
          // jsdom/older browsers may not implement delete; nothing to leak in them anyway.
        }
      };
      return true;
    } catch {
      return false;
    }
  }

  async function attemptFont(font: RequiredFont, record: FontRecord): Promise<boolean> {
    const settle = (available: boolean): boolean => {
      // Late completion of an owner-released claim: drop it — and if the registration won
      // after the release, undo it so nothing lingers for a frame no longer on stage.
      const superseded = record.owners.size === 0 || records.get(record.key) !== record;
      if (superseded) {
        if (available && record.unregister) record.unregister();
        return false;
      }
      record.status = available ? "loaded" : "failed";
      if (!available) permanentlyFailed.add(record.key);
      return available;
    };
    if (loadedFaceMatches(font.family, font.style)) return settle(true);
    if (permanentlyFailed.has(record.key)) return settle(false);
    // Daemon-cached bytes are the ONLY network path (spec 32.5.1): the browser never fetches a
    // Google stylesheet here, so offline/failed bytes settle like missing bytes and the draw
    // proceeds through the renderer's real-Figma raster fallback (W8-owned), never re-arming.
    let bytes: FigmaBytes | null = null;
    if (!store.disposed) {
      try {
        bytes = await loadFontBytes(font.family, font.style);
      } catch {
        bytes = null; // A failed fetch settles like missing bytes — never rejects to the caller.
      }
    }
    const registered = bytes ? await registerFace(font, bytes, record) : false;
    return settle(registered);
  }

  async function runLoad(font: RequiredFont, record: FontRecord): Promise<boolean> {
    const available = await attemptFont(font, record);
    if (record.owners.size === 0) {
      // Released while loading: the face (if won) was already undone by `settle`; forget the
      // record so the next claim starts fresh against the lifetime memories above.
      if (records.get(record.key) === record) records.delete(record.key);
    }
    return available;
  }

  function claimRecord(ownerId: string, font: RequiredFont): FontRecord {
    const key = fontKey(font.family, font.style);
    let record = records.get(key);
    if (!record) {
      const created: FontRecord = {
        key,
        status: "loading",
        promise: Promise.resolve(false),
        owners: new Set([ownerId]),
        unregister: null,
      };
      // Register before starting the load: the settle guard compares identity against the
      // live map, so the record must exist there even for a synchronously-settled attempt.
      records.set(key, created);
      created.promise = runLoad(font, created);
      record = created;
    } else {
      record.owners.add(ownerId);
    }
    let keys = ownerFonts.get(ownerId);
    if (!keys) {
      keys = new Set();
      ownerFonts.set(ownerId, keys);
    }
    keys.add(key);
    return record;
  }

  return {
    async load(fonts) {
      // Unguarded loader for callers outside the stage-owner path (tests, viewer probes):
      // claimed under a fixed owner that the scope's dispose sweeps with everything else.
      await Promise.all(
        fonts.map((font) => claimRecord("unowned", font).promise.then(() => undefined)),
      );
    },
    fontAvailable(family, style) {
      const record = records.get(fontKey(family, style));
      // Re-validate evidence on every answer: a face deleted behind our back (system unload,
      // another scope) must not keep claiming availability — the renderer then takes the
      // real-Figma raster fallback path for that text.
      return record?.status === "loaded" && loadedFaceMatches(family, style);
    },
    async loadForOwner(ownerId, fonts) {
      if (store.disposed || typeof document === "undefined") return false;
      let anyBecameAvailable = false;
      await Promise.all(
        fonts.map(async (font) => {
          const record = claimRecord(ownerId, font);
          // Singleflight: every concurrent or subsequent claim for this key awaits the SAME
          // in-flight promise. Repaint credit goes only to claims made while the load was
          // still in flight — a settled record adds nothing a draw doesn't already reflect,
          // so reporting an already-loaded font never re-arms the loop.
          const pendingAtClaim = record.status === "loading";
          const available = await record.promise;
          if (available && pendingAtClaim) anyBecameAvailable = true;
        }),
      );
      return anyBecameAvailable;
    },
    releaseOwner(ownerId) {
      const keys = ownerFonts.get(ownerId);
      if (!keys) return;
      ownerFonts.delete(ownerId);
      for (const key of keys) {
        const record = records.get(key);
        if (!record) continue;
        record.owners.delete(ownerId);
        if (record.owners.size > 0) continue;
        // Last active owner gone: free the registration while the player stays open. The
        // attempt itself is remembered (permanentlyFailed) so a revisit cannot loop requests.
        records.delete(key);
        if (record.status === "loaded" && record.unregister) record.unregister();
        if (record.status === "failed") permanentlyFailed.add(key);
      }
    },
  };
}
