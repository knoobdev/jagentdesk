# Markdown renderer

Chat replies and Markdown file previews render through one engine, `react-native-enriched-markdown`. Pacing and the streaming split are covered in [agent-stream-performance.md](agent-stream-performance.md).

## The fork

The library is a private workspace, `packages/react-native-enriched-markdown`. It is upstream [enriched-markdown](https://github.com/software-mansion/enriched-markdown) at npm `1.2.0-nightly-20261014-766fc0e67` (upstream commit `766fc0e67`) plus JAgentDesk's changes, which lived in a `patch-package` patch until the package moved into the repository. It is never published. Keep the name `react-native-enriched-markdown`: autolinking, the Gradle project `:react-native-enriched-markdown`, the CocoaPods spec and app imports all use it.

The package keeps the npm tarball's layout, including its build output:

- Metro, Vitest and TypeScript load `lib/`, not `src/`. A JavaScript change edits `src/` and the matching `lib/module` and `lib/typescript` files.
- `android/generated` and `ios/generated` are checked-in codegen output (`includesGeneratedCode`). A change to a native component spec regenerates both.
- `src/web/wasm/md4c.js` and `lib/module/web/wasm/md4c.js` are an Emscripten build of `cpp/md4c`. A parser change rebuilds them with upstream's `packages/core/cpp/wasm/build.sh`. Never rebrand or reformat these files: the binary payload contains compiler build paths, and changing their spelling corrupts section lengths. A successful bundle export does not prove the parser can initialize; check rendered Markdown in the browser.
- Upstream's Gradle, CMake and CocoaPods scripts detect upstream's own monorepo by the paths `packages/core` and a root `vendor/`. Do not add either path to this repository.
- `postinstall.mjs` downloads the tree-sitter grammars into the ignored `cpp/highlight/vendor/grammars` and `vendor/tree-sitter`. The `enriched-markdown` block in `packages/app/package.json` chooses the languages.
- Formatting, lint and knip skip the package.

CI does not build native code or run the fork's Robolectric suites. For Android changes, run them from `packages/app/android` after `expo prebuild`:

```sh
./gradlew :react-native-enriched-markdown:testReleaseUnitTest --no-daemon --max-workers=2
```

Native changes require a client rebuild; JavaScript refresh cannot enable compiled grammars.

Some fork changes are backports. A sync past the upstream version drops them in favour of upstream's code:

| Fork change                                                       | Upstream                                                                                                                                                     | Released in |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| Android nested list items start their text after their own marker | [#1015](https://github.com/software-mansion/enriched-markdown/pull/1015), [#1023](https://github.com/software-mansion/enriched-markdown/pull/1023) (Android) | `1.2.0`     |

Android measures and displays a reply with the same span order, and applies list line height before blockquote spacers, so a list with nested quotes fits above its turn footer. `ListBlockquoteMeasurementTest` covers it.
