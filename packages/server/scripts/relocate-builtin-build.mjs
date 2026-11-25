// Keep the daemon's published paths and asset-relative URLs stable while tsc checks static features.
import fs from "node:fs";
import path from "node:path";
const staged = path.resolve("dist/.builtin-build");
const output = path.resolve("dist/server");
fs.cpSync(path.join(staged, "packages/server/src"), output, { recursive: true });
fs.cpSync(path.join(staged, "plugins"), path.join(output, "builtin-features"), { recursive: true });
// Rebase source maps before removing the temporary compilation layout.
function rebaseMaps(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (fs.statSync(file).isDirectory()) {
      rebaseMaps(file);
      continue;
    }
    if (!file.endsWith(".map")) continue;
    const features = path.join(output, "builtin-features");
    const original = file.startsWith(features + path.sep)
      ? path.join(staged, "plugins", path.relative(features, file))
      : path.join(staged, "packages/server/src", path.relative(output, file));
    const map = JSON.parse(fs.readFileSync(file, "utf8"));
    map.sources = map.sources.map((source) =>
      path
        .relative(
          path.dirname(file),
          path.resolve(path.dirname(original), map.sourceRoot ?? "", source),
        )
        .replaceAll(path.sep, "/"),
    );
    map.sourceRoot = "";
    fs.writeFileSync(file, JSON.stringify(map));
  }
}
rebaseMaps(output);
// Only the generated loader and public API imports cross the layout relocation boundary.
function walk(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (fs.statSync(file).isDirectory()) {
      walk(file);
      continue;
    }
    if (!/\.(?:js|ts)$/.test(file)) continue;
    let source = fs.readFileSync(file, "utf8");
    source = source.replace(
      /(["'])([^"']*plugins\/([^/]+)\/server\/[^"']+)\1/g,
      (all, quote, spec, id) => {
        if (!spec.startsWith(".")) return all;
        const target = path.join(
          output,
          "builtin-features",
          id,
          "server",
          spec.split("/server/").at(-1),
        );
        return quote + path.relative(path.dirname(file), target).replaceAll(path.sep, "/") + quote;
      },
    );
    source = source.replace(
      /(["'])([^"']*packages\/server\/src\/server\/plugins\/builtin\/host-api\.js)\1/g,
      (_all, quote) =>
        quote +
        path
          .relative(path.dirname(file), path.join(output, "server/plugins/builtin/host-api.js"))
          .replaceAll(path.sep, "/") +
        quote,
    );
    fs.writeFileSync(file, source);
  }
}
walk(path.join(output, "builtin-features"));
walk(path.join(output, "server/plugins/builtin"));
fs.rmSync(staged, { recursive: true, force: true });
