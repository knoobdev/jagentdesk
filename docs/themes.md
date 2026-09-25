# Themes

JAgentDesk ships a set of built-in themes and can also apply themes contributed by plugins.
The default theme is **ClickUp**, a violet palette measured from ClickUp's own web and iOS UI.

Code: `packages/app/src/styles/theme.ts` (theme objects), `packages/app/src/styles/unistyles.ts`
(registration), `packages/app/src/screens/settings/appearance/` (picker and resolution).

## Built-in themes

| Setting value                                        | Unistyles key(s)                                                         | Follows system appearance       |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| `clickup` (default)                                  | `clickupLight`                                                           | no (ClickUp is a light product) |
| `clickupDark` ("ClickUp Dark")                       | `clickupDark`                                                            | no                              |
| `auto` ("System")                                    | `light` / `dark`                                                         | yes                             |
| `light`, `dark`                                      | `light`, `dark`                                                          | no                              |
| `zinc`, `midnight`, `claude`, `ghostty`, `pureBlack` | `darkZinc`, `darkMidnight`, `darkClaude`, `darkGhostty`, `darkPureBlack` | no                              |

`SCHEME_FOLLOWING_THEMES` lists themes with a light and a dark half; none currently (ClickUp stays light, ClickUp Dark is a separate choice). The root layout
(`app/_layout.tsx`) resolves the stored setting plus the current color scheme to one Unistyles
key through `resolveThemeTarget` (`screens/settings/appearance/theme-target.ts`); only "System"
(`auto`) follows the OS appearance.

### Default and migration

`DEFAULT_THEME` is `"clickup"`. Stored settings carry `defaultThemeVersion`; a settings blob
written before ClickUp existed that still has the old default `auto` is moved to `clickup`
once. A user who picked any other theme keeps it, and a user who picks `auto` after the
migration keeps `auto`. None of the previous themes were removed.

## Plugin themes

Theme plugins (installed from the Marketplace or a directory) contribute palettes through
the plugin client API. The Appearance picker lists them below the built-in themes; picking
one stores `{ theme: "plugin", pluginThemeId }`. The chosen palette is built into the two
reserved Unistyles slots `pluginLight` / `pluginDark` with `buildLightTheme` /
`buildDarkTheme`. If the plugin is uninstalled or its host is offline, the app falls back
to the default theme instead of rendering an unknown key.

## ClickUp content styling

Besides the shell, shared components read a few more `theme.chrome` tokens so every screen picks
up ClickUp's look without per-screen branches: `titleWeight` (screen titles 600 instead of 300),
`buttonTextWeight`, `controlRadius` (6px buttons), `outlineBackground` / `outlineBorder` (white
outline buttons with a `#e4e4e4` border), and for settings `pageCanvas` (`#f9f9f9` behind the
cards), `cardBackground` (`#ffffff`), `cardBorder` (`#ececec`), `cardRadius` (10),
`sectionTitleColor` / `sectionTitleWeight` (ink, 600) and `rowTitleWeight` (500). Classic themes
fill the same tokens with their previous values, so they render unchanged.

Structural differences choose a style from `useIsClickUpTheme()`:

- `SegmentedControl` renders underlined text tabs (ink bar under the active label).
- `clickUpTabStyles` (`components/clickup-shell/list-styles.ts`) does the same for the screens
  with their own tab pills: Skills, Docker, Marketplace.
- `clickUpListStyles`: History groups become uppercase bordered pills ("TODAY") and rows get a
  hairline divider.
- `clickUpChipStyles`: filter chips are white with a light border, the selected one lavender
  (`chipActiveBackground` `#f2f2fe`) with violet text, as ClickUp iOS's "Unread" chip. Used by the
  Marketplace sort and category filters.
- Chat (`components/clickup-shell/chat-headers.tsx`): messages are left-aligned under a header
  with a round avatar, a bold name and muted meta, as in ClickUp chat. The user's message drops
  the right-aligned bubble ("You" + time, violet avatar); each agent turn opens with the provider
  mark, provider name and model, and the turn's items are indented under the name.
- Page headers: every full-screen page (History, Schedules, Shared sessions, Team forum,
  Skills, Marketplace, Docker, Simulators, Databases, Clusters, Usage, Forge) uses one
  `PageHeader` (`components/headers/page-header.tsx`): the section's rail icon and a bold `2xl`
  title on one row, same-size `size="sm"` buttons on the right (the primary action is the violet
  `default` button), and a one-line muted description below. On phones it leads with a back
  arrow (`CompactBackButton`: history back, or Home when the page was opened directly) and
  clears the status bar, so every title sits at the same offset. Titles are left-aligned, not
  centered.

## Marketplace › Themes

Themes have their own tab in the Marketplace (`packages/app/src/marketplace/theme-card.tsx`)
instead of a wall of name chips on the Browse tab:

- Each card paints a miniature app window (sidebar, text, raised card, accent button, input)
  with the variant's own `background`, `foreground`, `raised`, `control`, `border`, `accent`
  and `mutedForeground` from the catalog entry. Nothing is invented; entries without a valid
  palette show "No preview".
- Plugins with several variants show one dot per variant; the dot switches the preview.
- Search matches the display name, author, repo and variant names; the All / Dark / Light
  filter keeps plugins that have at least one variant of that appearance.
- The grid is 3 columns on desktop and 2 on compact (phone) layouts; on compact the install
  button goes full width under the appearance tags.
- The Browse tab no longer lists theme plugins; the Installed tab lists everything installed.

## ClickUp shell

Colors alone left the app looking like the classic JAgentDesk shell, so the ClickUp theme also
swaps the window chrome. Only `settings.theme === "clickup"` turns it on
(`useIsClickUpTheme`, `components/clickup-shell/`); every other theme keeps the classic shell.

Desktop (`useClickUpDesktopShell`: not compact, and app chrome or `/settings`):

- **Top bar** (`clickup-top-bar.tsx`, 45px, owns both window corners so it clears the macOS
  traffic lights and is the drag region): sidebar toggle, host switcher chip (initial avatar,
  host name, chevron; opens the host picker), centered search pill that opens the command
  center (⌘K), help menu.
- **Icon rail** (`clickup-rail.tsx`, 64px, rounded, 8px inset): the primary destinations from
  `useAppNavItems` (`components/sidebar/use-app-nav.ts`, shared with the classic sidebar's
  routes) plus plugin sidebar entries, icon in a 32px box with a short label; pair device and
  settings pinned at the bottom. It stays when the workspace sidebar is collapsed.
- **Panel**: sidebar and content inside one bordered, 10px-radius panel on the canvas.
- **Sidebar**: the nav list moves to the rail; a "Workspaces" title with a "+ New" button
  replaces it, the list section is labelled "Projects", the footer keeps only "Add project".
- **Tabs**: the active tab is underlined at the bottom instead of the classic top edge.
- **Composer** (`composer-frame.tsx`): ClickUp Brain's 1.5px gradient border and a square
  gradient send button.

Phones: the drawer gets the same "Workspaces" + "+ New" header, and a bottom tab bar
(`clickup-mobile-tab-bar.tsx`: Home, Workspaces drawer, violet Create square, History,
Settings) shows on list screens and hides inside a workspace, where the composer owns the
bottom edge.

Shell tokens live on every theme as `theme.chrome` (`ShellChrome` in `theme.ts`); classic
themes fill them from their own colors. Styles read them directly (`theme.chrome.topBar`)
because Unistyles on web compiles each style once against CSS variables: a style that
branches on a theme value (`theme.chrome.kind === "clickup" ? …`) is frozen at the first
theme. Structural choices go through `useIsClickUpTheme`, gradients through `withUnistyles`
mappings.

| Token                             | Light                             | Dark                  | Source                                                                                                               |
| --------------------------------- | --------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| canvas / topBar                   | `#fcfcfc`                         | `#111111`             | Top bar, M (`w_purple_home`, `w_dark_home`).                                                                         |
| railGradient                      | `#5741d2` → `#4332a2` → `#2e2371` | `#191919`             | Rail top/middle/bottom, M.                                                                                           |
| railActiveBackground / Foreground | `#ffffff` / `#6149e7`             | `#2a2a2a` / `#ffffff` | Active rail item, M (light); dark D.                                                                                 |
| panelBorder                       | `#eaeaea`                         | `#1f1f1f`             | Panel edge, M~ (`#eae9e7`–`#efefef` / `#161616`–`#1a1a1a`).                                                          |
| createBackground / Foreground     | `#6149e7` / `#ffffff`             | `#ededed` / `#111111` | Sidebar "Create", M.                                                                                                 |
| searchBackground / Border         | `#ffffff` / `#e4e4e4`             | `#2a2a2a` / `#2d2d2d` | Search pill, M.                                                                                                      |
| composerGradient                  | `#40c8f4` → `#912eff` → `#ec02f7` | same                  | Brain composer (`fef108fd`): violet and magenta M from the send button, cyan D from the anti-aliased `#92e5f5` edge. |
| sendGradient                      | `#912eff` → `#ec02f7`             | same                  | Brain send button, M.                                                                                                |
| tabBar / tabBarBorder             | `#ffffff` / `#f1f1f1`             | `#1e1e1e` / `#292929` | iOS tab bar, M.                                                                                                      |
| tabIdle                           | `#8c8c8c`                         | `#6d6d6d`             | iOS idle tab label, M~.                                                                                              |
| tabCreateBackground               | `#5b43d7`                         | `#a59ff7`             | iOS Create square, M.                                                                                                |

## ClickUp palette

Measured on 2026-09-25 from 76 ClickUp screens on Mobbin (54 web, 22 iOS); 29 were sampled at
full resolution. Mobbin does not return hex values, so every value is a pixel sample (mode or
median of a flat region, about ±2–3 per channel from JPEG compression).

Confidence labels:

- **M**: measured on a flat color region.
- **M~**: measured on anti-aliased text or a small icon; the true color may be slightly
  darker or lighter.
- **D**: derived from an M value (for example darkened to reach WCAG AA) or assigned to a
  role ClickUp does not show.
- **K**: kept from the existing JAgentDesk theme because ClickUp has no equivalent.

Screen references are Mobbin ids (`https://mobbin.com/screens/<id>`):
`76af4864-46dc-4fec-897a-c4d5e9994295` (home, dark),
`f602ab77-1370-4a6d-9d41-0ac7a7cf75f2` (home, light),
`b5341bea-6020-439e-9041-0b2c6c3e0d84` (Customize › Themes, Purple),
`04550a9d-e935-40dc-984e-3970ed95d1c4` (same modal, dark),
`3ee66cc7-40d4-4105-aa50-01cb66a1b71f` (My Settings),
`4a1e7597-03a3-473c-8cd8-011e6b5de0e6` (list, dark status pills),
`6644402d-8d50-42fd-a333-fd73adbcfc9c` (task detail, dark).

| Token                                                             | Dark                  | Light                 | Source                                                                                                                             |
| ----------------------------------------------------------------- | --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| surface0                                                          | `#090909`             | `#ffffff`             | Dark outer canvas (M, `76af4864`); light content/card (M, `f602ab77`).                                                             |
| surface1                                                          | `#111111`             | `#f9f9f9`             | Dark content/card/modal (M); light canvas (M). The dark builder sets `surfaceWorkspace = surface1`, so the workspace is `#111111`. |
| surface2                                                          | `#191919`             | `#f0f0f0`             | Dark sidebar and board cards (M); light segmented track (M, `b5341bea`).                                                           |
| surface3                                                          | `#2a2a2a`             | `#eaeaea`             | Selected sidebar row in both modes (M).                                                                                            |
| surface4                                                          | `#414141`             | `#cecece`             | Dark control border (M, `04550a9d`); light input border (M, `3ee66cc7`).                                                           |
| surfaceSidebar                                                    | `#191919`             | `#f9f9f9`             | M. In dark the sidebar is lighter than the content, as in ClickUp.                                                                 |
| surfaceSidebarHover                                               | `#222222`             | `#f0f0f0`             | Value M (raised bars / track); the hover role is D.                                                                                |
| foreground                                                        | `#fafafa`             | `#202020`             | Dark within the measured `#f6f6f6`–`#ffffff`; light ink M. 18.1:1 / 16.3:1.                                                        |
| foregroundMuted                                                   | `#b8b8b8`             | `#676767`             | M~ (sidebar labels, iOS subtitles). 9.5:1 / 5.7:1.                                                                                 |
| foregroundExtraMuted                                              | `#757575`             | `#919191`             | M~ (breadcrumb "in …"). Below AA; non-essential text only.                                                                         |
| border                                                            | `#272727`             | `#e9e9e9`             | 1px dividers, M.                                                                                                                   |
| borderAccent                                                      | `#414141`             | `#cecece`             | Control and input borders, M.                                                                                                      |
| accent                                                            | `#6149e7`             | `#6149e7`             | ClickUp's "Purple" interaction violet, M on 5+ screens. White text on it 5.8:1.                                                    |
| accentBright                                                      | `#a6a0f8`             | `#7868e5`             | Dark: violet link text, M~, 8.1:1 on surface1. Light: iOS button violet, M.                                                        |
| destructive                                                       | `#cf2f2f`             | `#cf2f2f`             | Median of Urgent-flag pixels, M~.                                                                                                  |
| statusSuccess                                                     | `#6bba9a`             | `#1f7a52`             | Dark M~; light D (darkened from `#279566` to 5.3:1).                                                                               |
| statusDanger                                                      | `#f98689`             | `#cf2f2f`             | Dark M~ (7.9:1); light as destructive.                                                                                             |
| statusWarning                                                     | `#ffc539`             | `#9a6700`             | Dark M; light D (`#ffc539` is 1.58:1 on white).                                                                                    |
| statusMerged                                                      | `#a6a0f8`             | `#5d47cd`             | REVIEW pill violet, M.                                                                                                             |
| ring                                                              | `#6149e7`             | `#6149e7`             | Purple focus ring, M (`b5341bea`).                                                                                                 |
| terminal black / bright black                                     | `#191919` / `#414141` | `#202020` / `#3f3f46` | D / K.                                                                                                                             |
| diff, ANSI, syntax, palette, radius, spacing, type scale, shadows | kept                  | kept                  | K: ClickUp has no diff, terminal or code UI, and these are shared across themes.                                                   |

### Decisions

- **Label "ClickUp"**, one theme that follows the system appearance (light and dark halves).
- **One violet (`#6149e7`) in both modes.** ClickUp iOS dark uses `#5f48e1` for filled
  controls; the difference is below JPEG error, so one value keeps buttons identical across
  modes. Violet _text_ in dark uses `accentBright` `#a6a0f8`, since `#6149e7` on `#111111`
  is only about 3.2:1.
- **Purple, not Black.** ClickUp's own default is the "Black" theme (ink `#202020` primary);
  JAgentDesk uses the "Purple" theme's violet as the accent so the default has a brand color.
  `primary` stays the ink `#202020` (light) / `#fafafa` (dark) for neutral solid buttons.
- **Web dark values on every platform.** ClickUp iOS dark is `#1b1b1b`–`#1d1d1d`; tokens are
  not split per platform, so desktop and mobile both use the web values above.
- **Electron first frame.** The desktop window background is `#111111` in dark (the workspace
  color) and `#ffffff` in light, so the first painted frame matches ClickUp before the renderer
  loads (`packages/desktop/src/window/window-manager.ts`).

## Adding a built-in theme

1. Build it in `theme.ts` with `buildDarkTheme(buildDarkSemanticColors({...}))` or
   `buildLightTheme(buildLightSemanticColors({...}))`, and add it to `ThemeName`,
   `THEME_TO_UNISTYLES`, and `THEME_SWATCHES`. Add it to `SCHEME_FOLLOWING_THEMES` if it has
   both halves.
2. Register the Unistyles key(s) in `styles/unistyles.ts` and `ALL_THEME_KEYS` in
   `screens/settings/appearance/apply-appearance.ts`.
3. Add the label in every locale under `settings.appearance.theme.options`.
