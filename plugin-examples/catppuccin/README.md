# Catppuccin plugin example

This example adds **Catppuccin Mocha** to Settings → Appearance. It contributes the palette as an
app theme.

A theme is data, so the whole plugin is one `addTheme` call in `index.ts` — no client file, no RPC.

Register it in `$JAGENTDESK_HOME/config.json`:

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "catppuccin": {
      "source": "directory",
      "path": "/absolute/path/to/jagentdesk/plugin-examples/catppuccin"
    }
  }
}
```

Then run `jagentdesk plugin reload` and pick **Catppuccin Mocha** in Settings → Appearance.

The colors come straight from the [Catppuccin Mocha](https://catppuccin.com/palette/) palette:
`base`, `text`, `surface0`, `surface1`, `mauve`, `subtext0`, and `overlay0`. JAgentDesk expands them
into the full token set, so `accent` (`mauve`) drives buttons and selection while `border`
(`surface1`, shared with `control`) stays the border and raised-surface tint.
