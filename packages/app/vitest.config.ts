import { build } from "esbuild";
import { defineConfig, configDefaults } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import path from "path";
import fs from "fs";

const appNodeModules = path.resolve(__dirname, "node_modules");
const rootNodeModules = path.resolve(__dirname, "../../node_modules");
const resolvePackageEntry = (packageName: string) => {
  const appPackagePath = path.resolve(appNodeModules, packageName);
  return fs.existsSync(appPackagePath)
    ? appPackagePath
    : path.resolve(rootNodeModules, packageName);
};

export default defineConfig({
  plugins: [
    {
      name: "markdown-wasm-commonjs-export",
      transform(source, id) {
        if (!id.split("?")[0].endsWith("/lib/module/web/wasm/md4c.js")) return;
        const trailer = source.search(/\nif\s*\(typeof exports === ['"]object['"]/);
        if (trailer < 0) throw new Error("Markdown WASM CommonJS trailer was not found");
        return { code: `${source.slice(0, trailer)}\nexport default createMd4cModule;`, map: null };
      },
    },
    {
      name: "reanimated-web-style-helpers",
      transform(_source, id) {
        if (
          !id.split("?")[0].endsWith("/lib/module/ReanimatedModule/js-reanimated/webUtils.web.js")
        )
          return;
        return {
          code: [
            'export { default as createReactDOMStyle } from "react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle";',
            'export { createTransformValue, createTextShadowValue } from "react-native-web/dist/exports/StyleSheet/preprocess";',
          ].join("\n"),
          map: null,
        };
      },
    },

    {
      name: "bundle-i18n-resources",
      async transform(_source, id) {
        if (path.resolve(id) !== path.resolve(__dirname, "src/i18n/i18next.ts")) return;
        const result = await build({
          entryPoints: [id],
          bundle: true,
          format: "esm",
          platform: "neutral",
          external: ["i18next", "react-i18next"],
          write: false,
        });
        return { code: result.outputFiles[0].text, map: null };
      },
    },
  ],
  // Expo compiles JSX with the automatic runtime (no `import React` needed); esbuild's
  // default is the classic runtime, which breaks files that render JSX without React
  // in scope (e.g. remote-job-card.tsx) under test.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "e2e/**"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: [
            "src/**/*.{test,spec}.{ts,tsx}",
            "../../plugins/*/client/**/*.{test,spec}.{ts,tsx}",
            "modules/**/*.test.{ts,tsx}",
            "native-release-version.test.ts",
          ],
          setupFiles: [path.resolve(__dirname, "vitest.setup.ts")],
          exclude: [
            ...configDefaults.exclude,
            "e2e/**",
            "src/**/*.browser.{test,spec}.{ts,tsx}",
            "../../plugins/**/*.browser.{test,spec}.{ts,tsx}",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          setupFiles: [path.resolve(__dirname, "vitest.browser.setup.ts")],
          fileParallelism: false,
          include: [
            "src/**/*.browser.{test,spec}.{ts,tsx}",
            "../../plugins/*/client/**/*.browser.{test,spec}.{ts,tsx}",
          ],
          browser: {
            enabled: true,
            provider: playwright({
              // Exercise real WebGL glyph rendering on GPU-less CI runners.
              launchOptions: { args: ["--enable-unsafe-swiftshader"] },
            }),
            headless: true,
            connectTimeout: 180_000,
            instances: [{ browser: "chromium" }],
            screenshotDirectory: ".vitest-screenshots",
          },
        },
      },
    ],
    /**
     * Expo pulls in native tooling (xcode, etc.) that executes files relying on `process.send`.
     * Vitest's default worker pool uses worker_threads, which intentionally stub that API and
     * immediately throw `Unexpected call to process.send`. Running the suite in forked processes
     * keeps `process.send` intact so the app tests can boot before hitting the intentional failures.
     */
    pool: "forks",
    maxWorkers: 2,
    server: {
      deps: {
        fallbackCJS: true,
        inline: [
          "react-native-enriched-markdown",
          "zustand",
          "@tanstack/react-query",
          "react-native-web",
          "react-native-reanimated",
          "react-native-worklets",
          "react-native-gesture-handler",
          "react-native-keyboard-controller",
          "react-native-screens",
          "@floating-ui/react-native",
        ],
      },
    },
  },
  // Reanimated and gesture-handler pick platform files by extension
  // (e.g. `GestureHandlerRootView.web.js`). Vite's optimizer does not apply `resolve.extensions`,
  // so it scans the native files and dies on imports react-native-web has no answer for.
  // Unbundled, the same imports go through the resolver below and land on the web files.
  optimizeDeps: {
    // The optimizer must choose the same platform leaves as Vite/Metro, including CJS
    // imports from Expo Router's native-screen and asset entry points.
    esbuildOptions: {
      resolveExtensions: [
        ".web.mjs",
        ".web.js",
        ".web.mts",
        ".web.ts",
        ".web.jsx",
        ".web.tsx",
        ".mjs",
        ".js",
        ".mts",
        ".ts",
        ".jsx",
        ".tsx",
        ".json",
      ],
    },
    // Bundle the CJS dependencies of the excluded gesture-handler package for the browser.
    include: [
      "@marijn/find-cluster-break",
      "warn-once",
      "@react-native/assets-registry/registry",
      "react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle",
      "react-native-web/dist/exports/StyleSheet/preprocess",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-native-gesture-handler > hoist-non-react-statics",
      "react-native-gesture-handler > invariant",
    ],
    exclude: [
      "react-native-enriched-markdown",
      "expo/src/winter",
      // Expo core has web modules that must pass through the platform resolver.
      "expo-modules-core",
      "expo-asset",
      "expo-constants",
      "expo-clipboard",
      "expo-crypto",
      "expo-web-browser",
      "expo-file-system",
      "react-native-reanimated",
      "react-native-gesture-handler",
      "react-native-keyboard-controller",
    ],
  },
  // The globals a React Native bundler defines, which esbuild is no longer there to supply for
  // the package excluded above.
  define: {
    "process.env.JEST_WORKER_ID": "undefined",
    __DEV__: "false",
    global: "globalThis",
  },
  resolve: {
    extensions: [
      ".web.mjs",
      ".web.js",
      ".web.mts",
      ".web.ts",
      ".web.jsx",
      ".web.tsx",
      ".mjs",
      ".js",
      ".mts",
      ".ts",
      ".jsx",
      ".tsx",
      ".json",
    ],
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "src") },
      // Keep keyboard-controller's imports in Vite so native aliases and platform extensions apply.
      {
        find: /^react-native-keyboard-controller$/,
        replacement: path.resolve(
          resolvePackageEntry("react-native-keyboard-controller"),
          "lib/module/index.js",
        ),
      },
      // The CJS floating-ui entry requires native React Native before aliases can apply.
      {
        find: /^@floating-ui\/react-native$/,
        replacement: path.resolve(
          resolvePackageEntry("@floating-ui/react-native"),
          "dist/floating-ui.react-native.esm.js",
        ),
      },
      // Screens exposes platform-specific leaf modules; keep them in Vite's web resolver.
      {
        find: /^react-native-screens$/,
        replacement: path.resolve(
          resolvePackageEntry("react-native-screens"),
          "lib/module/index.js",
        ),
      },
      // The CJS entry bypasses Vite's React Native alias and web-extension resolution.
      {
        find: /^react-native-gesture-handler$/,
        replacement: path.resolve(
          resolvePackageEntry("react-native-gesture-handler"),
          "lib/module/index.js",
        ),
      },
      // Must precede the `react-native` alias: a string `find` matches by prefix, so this subpath
      // would otherwise resolve inside a react-native-web *file* and break the dependency scan.
      // Reanimated only imports it on the native path, which no test takes.
      {
        find: /^react-native\/Libraries\/Renderer\/shims\/ReactFabric$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-fabric-shim.ts"),
      },
      // Point to the ESM build so Vite can transform its imports and apply the
      // react alias below (the CJS build uses require('react') which bypasses
      // Vite alias resolution).
      {
        find: "react-native",
        replacement: path.resolve(rootNodeModules, "react-native-web/dist/index.js"),
      },
      { find: "react", replacement: resolvePackageEntry("react") },
      {
        find: "react-dom",
        replacement: resolvePackageEntry("react-dom"),
      },
      {
        find: /^@xterm\/addon-ligatures\/lib\/addon-ligatures\.mjs$/,
        replacement: path.resolve(__dirname, "test-stubs/xterm-addon-ligatures.ts"),
      },
      {
        find: /^@xterm\/addon-ligatures$/,
        replacement: path.resolve(__dirname, "test-stubs/xterm-addon-ligatures.ts"),
      },
      {
        find: /^react-native-unistyles$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-unistyles.ts"),
      },
      {
        find: /^react-native-svg$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-svg.ts"),
      },
      // Both ship untranspiled Flow and fail to parse on import, which takes out any test that
      // mounts a menu surface.
      {
        find: /^react-native-safe-area-context$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-safe-area-context.ts"),
      },
      {
        find: /^@gorhom\/bottom-sheet$/,
        replacement: path.resolve(__dirname, "test-stubs/gorhom-bottom-sheet.ts"),
      },
      {
        find: /^react-native-reanimated\/scripts\/validate-worklets-version$/,
        replacement: path.resolve(__dirname, "test-stubs/reanimated-validate-worklets-version.ts"),
      },
      {
        find: /^expo-linking$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-linking.ts"),
      },
      // No Node implementation: every call on the real module rejects, so a test
      // touching a persisted store drowns in unhandled rejections.
      {
        find: /^@react-native-async-storage\/async-storage$/,
        replacement: path.resolve(__dirname, "test-stubs/async-storage.ts"),
      },
      {
        find: /^lucide-react-native$/,
        replacement: path.resolve(__dirname, "test-stubs/lucide-react-native.ts"),
      },
    ],
  },
});
