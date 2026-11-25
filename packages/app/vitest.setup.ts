// @ts-nocheck
import { vi } from "vitest";
import React from "react";

// SDK 57 installs Metro-only import.meta/async-require globals here; Vite owns module loading.
vi.mock("expo/src/winter", () => ({}));

const globalWithTestShims = globalThis as typeof globalThis & Record<string, unknown>;

globalWithTestShims.__DEV__ = false;

// JSDOM has no CSS media-query engine. Give native-web libraries the browser API
// with no active preferences; responsive behavior is exercised in Chromium.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (media: string) =>
    Object.assign(new window.EventTarget(), {
      media,
      matches: false,
      onchange: null,
      addListener(listener: EventListener) {
        this.addEventListener("change", listener);
      },
      removeListener(listener: EventListener) {
        this.removeEventListener("change", listener);
      },
    });
}

if (typeof globalThis.self === "undefined") {
  globalWithTestShims.self = globalThis;
}

if (typeof globalThis.expo === "undefined") {
  class ExpoEventEmitter {
    addListener() {
      return {
        remove() {},
      };
    }
    removeListener() {}
    removeAllListeners() {}
    emit() {}
    listenerCount() {
      return 0;
    }
  }

  class ExpoSharedObject extends ExpoEventEmitter {}
  class ExpoSharedRef extends ExpoSharedObject {}
  class ExpoNativeModule extends ExpoEventEmitter {}

  globalWithTestShims.expo = {
    EventEmitter: ExpoEventEmitter,
    SharedObject: ExpoSharedObject,
    SharedRef: ExpoSharedRef,
    NativeModule: ExpoNativeModule,
    modules: {},
  };
}

if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
}

if (typeof globalThis.cancelAnimationFrame !== "function") {
  globalThis.cancelAnimationFrame = (handle: number) => {
    clearTimeout(handle);
  };
}

// The unistyles test double lives in test-stubs/react-native-unistyles.ts and
// reaches every vitest project through the resolve.alias in vitest.config.ts —
// no vi.mock here, so there is a single copy of the fixture theme.

vi.mock("@xterm/addon-ligatures", () => ({
  LigaturesAddon: class LigaturesAddon {
    dispose(): void {}
  },
}));

// react-native-svg and expo-linking test doubles live in test-stubs/ and reach
// every vitest project through the resolve.alias in vitest.config.ts, same as
// react-native-unistyles and lucide-react-native.

const RouterPassthrough = ({ children }: { children?: React.ReactNode }) => children;

vi.mock("expo-router", () => ({
  Redirect: () => null,
  Stack: Object.assign(RouterPassthrough, {
    Screen: () => null,
    Protected: RouterPassthrough,
  }),
  router: {
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
    navigate: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
  },
  useGlobalSearchParams: vi.fn(() => ({})),
  useLocalSearchParams: vi.fn(() => ({})),
  usePathname: vi.fn(() => "/"),
  useRootNavigationState: vi.fn(() => ({ key: "root" })),
  useRouter: vi.fn(() => ({
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
    navigate: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
  })),
}));

// Plugin registration tests inspect metadata without rendering native Markdown. Browser
// journeys exercise this bridge and its real renderer; other Markdown tests keep their imports.
vi.mock("@/plugins/react-native/markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));
