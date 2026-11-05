// Builds the JAgentDesk Figma Link plugin with the repo's own esbuild — no
// vite, no React, no network. Outputs the committed `dist/` bundle that the
// manifest points at: `dist/code.js` (sandbox) + `dist/index.html` (UI with
// inlined script and styles, Figma's single-file UI requirement).
//
//   node build.mjs          # from vendor/figma-link-plugin
//   npm run build           # same, via the vendor package.json
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  legalComments: "none"
};

// 1. The UI iframe: one script + one stylesheet inlined into index.html.
await build({ ...common, entryPoints: [path.join(here, "src/ui/main.ts")], outfile: path.join(dist, "ui.js") });
const uiScript = readFileSync(path.join(dist, "ui.js"), "utf8").replaceAll("</script", "<\\/script");
const uiCss = readFileSync(path.join(here, "src/ui/index.css"), "utf8").replaceAll("</style", "<\\/style");
const template = readFileSync(path.join(here, "src/ui/index.html"), "utf8");
const html = template
  .replace("/*__CSS__*/", () => uiCss)
  .replace("/*__JS__*/", () => uiScript);
writeFileSync(path.join(dist, "index.html"), html);
rmSync(path.join(dist, "ui.js"));

// 2. The sandbox. Figma injects the UI html by replacing the `__html__` global,
// so the built code.js embeds it as a string literal (same as the vite build
// it replaced, via vite-plugin-singlefile's define).
await build({
  ...common,
  entryPoints: [path.join(here, "src/main/code.ts")],
  outfile: path.join(dist, "code.js"),
  define: { __html__: JSON.stringify(html) }
});

console.log("figma-link-plugin: built dist/code.js + dist/index.html");
