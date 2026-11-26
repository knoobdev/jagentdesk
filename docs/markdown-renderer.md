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

Native changes require a client rebuild; JavaScript refresh cannot enable compiled grammars.

Some fork changes are backports. A sync past the upstream version drops them in favour of upstream's code:

| Fork change                                                         | Upstream                                                                                                                                                     | Released in |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| Android long-press drag selection keeps parent intercept disallowed | [#1012](https://github.com/software-mansion/enriched-markdown/pull/1012)                                                                                     | `1.2.0`     |
| Android nested list items start their text after their own marker   | [#1015](https://github.com/software-mansion/enriched-markdown/pull/1015), [#1023](https://github.com/software-mansion/enriched-markdown/pull/1023) (Android) | `1.2.0`     |

Android measures and displays a reply with the same span order, and applies list line height before blockquote spacers, so a list with nested quotes fits above its turn footer. `ListBlockquoteMeasurementTest` covers it.

## Copy controls

Code blocks and plain quotes have a copy control in their top trailing corner. Native code blocks use the library's compiled grammars. On native, the code block and quote container views share one control (`HeaderCopyButton` on Android, `ENRMHeaderCopyButton` on iOS). A quote reserves the code block's header band above its body, so the control never covers quote text at any font size. On web, code blocks use `HighlightedCodeBlock` through the library's `renderers.codeBlock` override, and quotes use `WebBlockquote` through `renderers.blockquote`. Both use `BlockCopyButton`. On compact layouts the control is always visible, so the web quote reserves a band above its body, as native does. On wide layouts the control appears on hover or focus, so the quote keeps a right gutter instead; a band there would leave an empty strip above every quote.

A quote copies its body without the `>` markers, with its nested Markdown, and reads the content at the time of the press, so a streaming quote copies what it shows. A nested quote or code block keeps its own control. Web quote copy uses the same two clipboard flavors as selection copy: `text/plain` is unescaped Markdown and `text/html` is rendered from escaped Markdown. A rendered Mermaid diagram copies as its fence because its wrapper carries the fence source. Native quote copy serializes the quote's parsed Markdown, so a workspace image copies as its cached file URL, as native selection copy does; native has no map back to the workspace path. A native Mermaid diagram in a quote renders outside it, so each quote fragment copies only its own text. Admonitions get no control: web renders them with a separate library renderer. On web an admonition inside a copied quote copies as its `> [!TYPE]` source; the fork marks the box and its generated title for this. Selection copy keeps the text it shows, because the cloned range cannot tell a whole callout from part of one. On native, quotes inside list items get no control, because they render as text spans in the item. Web renders them as blocks, so they get one.
