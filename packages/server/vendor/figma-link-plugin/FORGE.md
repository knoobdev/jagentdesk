# Figma MCP Forge

Fork of [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge)
(MIT, pinned at `v0.0.25`) that adds the authoring tools the bridge leaves out:
components and instances, variables, styles, prototype reactions, child layout
sizing, and document utilities. Tool names and parameters for the added tools
follow the figma-mcp-go plugin (MIT) so agents that know those tools can use
them unchanged.

Upstream code stays untouched where possible. Additions live in:

- `plugin/src/main/forge.ts`: plugin-side handlers;
- `server/src/forgeTools.ts`: MCP tool definitions;

and are wired in with a few lines in `plugin/src/main/code.ts` and
`server/src/index.ts`.

## Install

Requirements: Node 20+, the Figma **desktop** app (the browser version cannot import
development plugins), and an MCP client such as Claude Code.

Install the npm package and import its bundled plugin following
[the README](README.md#install). Both parts ship together as `figma-mcp-forge`.
For source development, use `node /absolute/path/server/dist/index.js` after
building; the plugin manifest is `plugin/manifest.json` in this repository.
Run `figma-mcp-forge plugin install`, restart MCP clients and reopen the plugin
after upgrading. Use `figma-mcp-forge doctor` to diagnose installation/version issues.

### Configuration

| Variable                         | Default | Meaning                                                                                                                                                                                                                  |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FIGMA_BRIDGE_ENABLE_RUN_SCRIPT` | off     | `1` enables `run_script` (arbitrary Plugin API JavaScript). Needed for anything the typed tools do not cover.                                                                                                            |
| `FIGMA_FORGE_ASSET_DIRS`         | none    | Extra directories (`:`-separated, `~` allowed) that `create_image`, `create_svg`, `import_html_layers` and `save_screenshots` may read or write. Without it only the directory the MCP client was started in is allowed. |
| `FIGMA_BRIDGE_PORT`              | `1995`  | WebSocket port. The plugin manifest only allows 1995, so change both together.                                                                                                                                           |

### Building from source

```bash
bun install && (cd server && bun install) && (cd plugin && bun install)
bun run check          # builds server and plugin, typechecks, prettier
cd server && npm test  # asset-path unit tests
```

## Bridge selection

Forge listens on `ws://localhost:1995` (upstream and figma-mcp-go use 1994), the
plugin is named "Figma MCP Forge" with id `figma-mcp-forge`, and the MCP server
reports itself as `figma-forge`. When using Forge alone, remove other Figma bridge entries from your MCP clients
and run only the Forge plugin. Keep the upstream attribution, not its install configuration.

## Added tools

| Area            | Tools                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Components      | `create_component`, `create_instance`, `combine_as_variants`, `get_local_components`, `swap_component`, `detach_instance`                                                                |
| Variables       | `create_variable_collection`, `add_variable_mode`, `create_variable`, `set_variable_value`, `bind_variable_to_node`, `delete_variable`, `export_tokens`                                  |
| Styles          | `create_paint_style`, `create_text_style`, `create_effect_style`, `create_grid_style`, `update_paint_style`, `delete_style`, `apply_style_to_node`                                       |
| Reactions       | `get_reactions`, `set_reactions`, `remove_reactions`                                                                                                                                     |
| Layout          | `set_layout_child` (FILL/HUG/FIXED, grow, align, absolute positioning, min/max size), `set_constraints`, `rotate_nodes`, `reorder_nodes`, `set_blend_mode`, `lock_nodes`, `unlock_nodes` |
| Text and search | `find_replace_text`, `scan_text_nodes`, `search_nodes`, `scan_nodes_by_types`, `batch_rename_nodes`, `get_fonts`                                                                         |
| Pages and view  | `navigate_to_page`, `rename_page`, `delete_page`, `get_viewport`, `get_annotations`                                                                                                      |

`run_script` from upstream stays opt-in (`FIGMA_BRIDGE_ENABLE_RUN_SCRIPT=1`).

## Updating from upstream

```bash
git fetch upstream --tags
git merge <tag>        # conflicts should be limited to the wiring lines
bun run check
```

## Plan and progress

- [x] Fork at v0.0.25, `upstream` remote kept, baseline `bun run check` green.
- [x] Plugin handlers in `forge.ts`, wired into `code.ts`.
- [x] MCP tools in `forgeTools.ts`, wired into `index.ts`.
- [x] Port 1995, plugin identity, server name.
- [x] `bun run check` green.
- [x] Register in Claude Code beside figma-mcp-go.
- [x] Import `plugin/manifest.json` in Figma Desktop (Plugins → Development → Import plugin from manifest).
- [x] Live proof in a Figma Draft (2026-10-23): rebuilt the MOSA Agents page option 1 with `run_script`
      (28 Phosphor icon components, auto-layout FILL/HUG throughout); typed tools proven live:
      `create_variable_collection`, `create_variable`, `bind_variable_to_node` (fillColor),
      `create_paint_style`, `apply_style_to_node`, `get_local_components`, `create_instance`,
      `export_tokens` (css), `set_layout_child` (rejects FILL outside auto-layout with a clear error).
      Not yet exercised live: reactions, grid/effect/text styles, variable modes, `swap_component`,
      `combine_as_variants`, page tools, `find_replace_text`.

## Backlog (found during live proof)

- [x] Asset paths: `create_image`, `create_svg` and `save_screenshots` only accepted paths under the
      server's `process.cwd()`. Fixed with the `FIGMA_FORGE_ASSET_DIRS` allowlist
      (`server/src/forgeAssets.ts`); upstream's realpath/symlink checks still run against the chosen
      root. Proven live with `scripts/smoke-assets.mjs`.
- [x] `get_screenshot` returned base64 as a text block. PNG/JPG now come back as MCP `image`
      content plus a metadata text block; SVG/PDF are unchanged. Proven live.

## Gotchas for scripts (move into the figma-rebuild skill)

- `listAvailableFontsAsync` lists "SF Pro" and `loadFontAsync` succeeds, but text renders with
  `hasMissingFont: true` and width 0. Check `hasMissingFont` on the first text node; resolve the exact installed face (SF Pro Text/Display static OTFs worked in live proof). Restart Figma after font installation. Do not silently substitute Inter.
- A text node set to FILL while its width is 0 stays at 0 after the font is fixed. Kick it:
  FIXED → `textAutoResize = "WIDTH_AND_HEIGHT"` → `"HEIGHT"` → FILL.
- Create text, set characters, append to the auto-layout parent, and only then set FILL.
- `globalThis` persists across `run_script` calls while the plugin stays open, so helpers can be
  defined once and reused (re-run `loadFontAsync` per script).

## License

MIT. Upstream notice: Copyright (c) gethopp, see `LICENSE.md`. Added tool
surface modeled on figma-mcp-go by vkhanhqui (MIT).

## Reliable design workflow (27 October upgrade)

New tools: `design_preflight`, `audit_design`, `get_build_checkpoint`,
`commit_build_checkpoint`. Restart the MCP client and reopen the Figma development
plugin after rebuilding: the plugin runs the JavaScript loaded when it was opened.

1. `list_files` first; reconnects can change unsaved file keys. Select an explicit file.
2. Read source tokens/components and approved scope. Call `design_preflight` with
   exact `{family, style}` faces and optional `roots` IDs. It loads requested fonts
   but cannot prove glyph metrics. Never replace a required font to pass a check.
3. `get_build_checkpoint({key})` returns stable owned node IDs and a revision.
   Inspect those nodes before drawing. Update existing owned nodes; do not blindly
   rerun initial creation scripts. Preserve reviewed content outside the scope.
4. Build in small batches. Use async Plugin APIs with dynamic-page documents;
   append children before setting FILL. Reload fonts in each script. Use wrappers
   rather than appending arbitrary children to instances.
5. `audit_design({rootId, allowedRadii, allowedFontSizes})` checks a bounded subtree.
   Supply the FULL scales from current source, not a shortened design summary.
   `complete:false` means the node/time cap was reached; audit smaller subtrees.
   `timedOut:true` can indicate slow/offline Figma component resolution. The default
   wall-time budget is 5000ms (`maxDurationMs`, maximum 30000); this is not a clean audit. Hidden
   branches are skipped. Clipping findings may be intentional. Mixed text runs,
   internal glyph overflow, transforms and URL navigation need visual/manual proof.
6. Export a fresh screenshot and inspect actual pixels, required copy and states.
   Structural success is not visual acceptance. Use unique export paths; retain
   the best prior version and compare after targeted fixes.
7. `commit_build_checkpoint({key,expectedRevision,operationId,roots,note})` records
   a completed, inspected batch. Use a unique operation ID per batch; retrying the
   last identical commit is safe. The receipt is NOT a transaction or rollback of
   drawing operations. After a timeout, inspect live nodes before retrying drawing.
   A revision conflict means another writer changed the receipt: read/reconcile.

Keep one writer per owned design subtree. Review at most 2–3 deliberate refinement
rounds initially, report remaining issues, and present options for human approval.
A source/PRD checkpoint and screenshot paths belong in the receipt note; full specs
remain in the repository. No auto-repair or deletion is performed by the audit.
