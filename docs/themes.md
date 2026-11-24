# Themes

JAgentDesk starts with **Gumloop**. Gumloop Dark is a separate choice; System follows
Paseo Light / Dark. The Paseo palettes and plugin themes retain the Paseo shell.
UI and monospace font stacks stay unchanged.

Theme objects and semantic chrome live in `packages/app/src/styles/theme.ts`.
`styles/unistyles.ts` registers them. Appearance applies font and size preferences
at runtime; Gumloop keeps its own syntax palette when that patch runs.

## Default and migration

Settings version 2 migrates `clickup` to `gumloop`, `clickupDark` to `gumloopDark`,
and the previous default `auto` to `gumloop`. Loading persists that migration.
Choosing System after migration keeps System. Plugin themes fall back to Gumloop
when their contribution is unavailable.

## Shell ownership

`components/gumloop-shell/` owns the desktop Gumloop shell. There is one 324px
sidebar, with no global top bar or icon rail. Its header and footer stay fixed;
primary navigation, Tools and Projects share the scrolling middle. Collapsing the
sidebar hides it completely. The panel store persists that choice; ⌘\\ reopens it.
Tools and Projects folds are device-local. Tools starts folded above six entries.

Destinations come from the shared navigation model and installed-plugin registry,
so pushed plugin enablement changes the visible entries without a reload. Workspace
routes drill into workspace navigation and Recents. Resource destinations render
their existing panels; Settings portals its sections into the same sidebar.
The Back button returns to global navigation without leaving the current page.

A plugin sidebar view replaces only the middle region. Settings → Sidebar selects
it per device. Missing contributions show Projects; a failed view offers recovery.
Device-scoped plugin settings use local storage with revision checks and migration.

The compact shell remains on its existing layout until the mobile Gumloop work.

## Shared styling

Read semantic tokens through `StyleSheet.create`. Do not branch on theme values
inside its factory: Unistyles web turns theme leaves into CSS variables before
those expressions run. Use `useIsGumloopTheme` for structure, or theme-reactive
leaf wrappers for third-party props. See [unistyles.md](unistyles.md).

Shared buttons, cards, segmented controls, status chips, switches, modals and
notifications read semantic chrome. Composer styling changes its frame and action
buttons; the composer continues to own editing, queueing and submission behavior.
The gradient painter preserves commas inside rgba stops for the dark border.

Plugin themes derive neutral fills, hover, selected rows and passive text from
contrast relationships. Contributions can override those roles. Sidebar status
badges receive their row's semantic backdrop so selected and hovered rows do not
leave a halo around the badge. Gumloop's measured surfaces remain explicit.

Created / Last prompt sorting uses daemon-owned timestamps, including prompts on
archived agents. Manual sorting retains its separate stored order. Long workspace
groups show seven ordinary rows plus active overflow. Wide web rename holds the
submitted title until a workspace update confirms or supersedes it; compact and
native layouts keep the modal.
