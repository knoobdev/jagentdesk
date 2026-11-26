# Themes

Theme objects live in `packages/app/src/styles/theme.ts`; `styles/unistyles.ts` registers them.
A fresh install starts on **Gumloop** (`DEFAULT_THEME`). UI and monospace font stacks are the same
in every theme. [design.md](design.md) owns the design rules that apply on top of the tokens.

| Setting value                                                         | Label in Appearance                               | Shell   |
| --------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| `gumloop`                                                             | Gumloop                                           | Gumloop |
| `gumloopDark`                                                         | Gumloop Dark                                      | Gumloop |
| `light`, `dark`, `zinc`, `midnight`, `claude`, `ghostty`, `pureBlack` | Light, Dark, Zinc, Midnight, Claude, Ghostty, ... | Classic |
| `auto`                                                                | System (Light or Dark by system appearance)       | Classic |
| `plugin`                                                              | The selected plugin theme                         | Classic |

Gumloop Dark is its own choice; System never selects it. Gumloop keeps its own syntax and terminal
palettes: `applyAppearance` skips the syntax-theme setting for both Gumloop keys, and Appearance
shows the syntax row as fixed.

## Stored values

`normalizeAppSettings` in `packages/app/src/hooks/use-settings/storage.ts` rewrites the theme once on
load:

- `clickup` becomes `gumloop` and `clickupDark` becomes `gumloopDark` (`COMPAT(gumloopTheme)`).
- Settings written before `defaultThemeVersion` 2 with `auto` or no theme move to `gumloop`. Choosing
  System afterwards keeps System.

A selected plugin theme whose plugin is gone falls back to Gumloop
(`packages/app/src/screens/settings/appearance/theme-target.ts`).

## Shell

The theme setting picks the shell. `useIsGumloopTheme()` and `useGumloopDesktopShell()` in
`packages/app/src/components/gumloop-shell/use-gumloop-chrome.ts` are the only switches; branch on
them in components, never on theme values in a style factory. The Gumloop shell lives in
`components/gumloop-shell/`. The classic shell is `components/left-sidebar.tsx`.

### Desktop

One 324px sidebar (`sidebar.tsx`) holds all app navigation.

- **Header, fixed:** logo, Command Center search, collapse button; the host switcher; **New agent**.
- **Middle, scrolls:** the root destinations Home, History, Schedules, Skills, Bots, Market, Usage,
  Insights; a **Tools** group with every other built-in and installed plugin destination; **Projects**
  (the workspace list).
- **Footer, fixed:** the usage row, the connection card (Direct, Tailscale, or Relay), and the account
  row with Pair device, Settings, Notifications, and More as 32px icon buttons (`account-button.tsx`).

Destinations come from `useAppNavItems` and the plugin registries, so a plugin turned on or off on the
host adds or removes its entry without a reload. A destination only shows while its plugin is
enabled. Tools and Projects start open, and their folds persist per device (`sidebar-state.ts`). Keep
Tools open by default: up to v0.10.0 it folded itself past six entries and users never found Docker,
Data or Jira. The persisted state is versioned, so a fold saved by v0.10.0 is dropped once on upgrade.

Opening a workspace, Settings, or a built-in destination with a left panel drills the sidebar in:

| Route        | Drill-in panel                                                                              |
| ------------ | ------------------------------------------------------------------------------------------- |
| Workspace    | `workspace-sidebar.tsx`: Agents, Terminals, Files, Changes, then Recents                    |
| Settings     | The settings list, portalled in through `GUMLOOP_PANEL_HOST`                                |
| Plugin route | `BuiltinLeftPanel` from the built-in plugin host ([builtin-plugins.md](builtin-plugins.md)) |

The back arrow returns to root navigation without leaving the current page. The switcher next to the
title jumps to another item of the same kind.

A plugin sidebar view (`packages/app/src/plugins/sidebar-view/`) replaces only the middle region at
the root level. Settings → Sidebar selects it per device; a failed view offers recovery.

The collapse button and ⌘\ / Ctrl+\ (`use-sidebar-shortcut.web.ts`) hide the sidebar completely; the
panel store remembers the choice.

### Compact

There is no tab bar. The same `GumloopSidebar` opens as a drawer (`drawer.tsx`), `min(324, 85%)` of
the window wide. `compact-header.tsx` shows the menu button, a left-aligned title, and one action.
Panes, files, and subagents open on the shared sheet stack; the explorer opens full screen through
`GUMLOOP_INSPECTOR_HOST`. Motion and visibility belong to the mobile panel model in
[mobile-panels.md](mobile-panels.md).

### Composer

`GumloopComposerFrame` (`composer-frame.tsx`) draws a 2px gradient border from
`chrome.composerGradient` with the SVG painter in `gradient-fill.tsx`. The frame is decoration only;
the composer owns editing, queueing, and submission.

## Shell tokens

`theme.chrome` (`ShellChrome` in `theme.ts`) holds the tokens shared controls read where the shells
differ: the primary button fill, outline buttons, cards, switch geometry, title and row weights, the
composer and send gradients. Every theme carries the full set (`classicChrome` or `gumloopChrome`)
because Unistyles web compiles style factories against CSS variables; see
[unistyles.md](unistyles.md#never-branch-on-theme-values-inside-stylesheetcreate-web).

`ShellChrome` still declares rail, top bar, tab bar, search, and hero-glow tokens that nothing reads.
They are left over from the removed shell. Do not build on them.

Plugin themes derive hover, selected, neutral fill, and quiet text roles from contrast ratios
(`packages/app/src/styles/derive-colors.ts`); a contribution can override them. Gumloop's measured
surfaces are set explicitly.
