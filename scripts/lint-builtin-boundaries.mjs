import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const allowedApis = new Set([
  "packages/server/src/server/plugins/builtin/host-api.ts",
  "packages/app/src/plugins/builtin/host-api.ts",
  "packages/server/src/server/plugins/builtin/host-test-api.ts",
]);
let violations = 0;
// Repository path for absolute, relative, and workspace-alias specifiers; null for packages.
function resolveLocal(file, spec) {
  if (path.isAbsolute(spec)) return path.relative(root, spec).replaceAll(path.sep, "/");
  if (spec.startsWith("."))
    return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  if (spec.startsWith("@/")) return "packages/app/src/" + spec.slice(2);
  if (spec.startsWith("@server/")) return "packages/server/src/" + spec.slice(8);
  if (spec.startsWith("@jagentdesk/server"))
    return "packages/server/src/" + spec.slice("@jagentdesk/server".length);
  return null;
}
// Packages installed only for the app do not resolve from plugins/ (tsc or Metro).
function appLocalPackage(file, spec) {
  const packageName = spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");
  return (
    /^plugins\/[^/]+\/client\//.test(file) &&
    !fs.existsSync(path.join(root, "node_modules", packageName)) &&
    fs.existsSync(path.join(root, "packages/app/node_modules", packageName))
  );
}
function walk(dir) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (["node_modules", "dist", ".git"].includes(name)) continue;
    const file = path.posix.join(dir, name);
    if (fs.statSync(path.join(root, file)).isDirectory()) {
      walk(file);
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(path.join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      let spec;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        spec = node.moduleSpecifier.text;
      if (
        ts.isCallExpression(node) &&
        node.arguments.length &&
        ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === "require")
      )
        spec = node.arguments[0].text;
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      )
        spec = node.moduleReference.expression.text;
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        spec = node.argument.literal.text;
      if (spec) check(spec, node);
      ts.forEachChild(node, visit);
    }
    function check(spec, node) {
      let resolved = resolveLocal(file, spec);
      if (!resolved) {
        if (appLocalPackage(file, spec)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          console.error(
            `${file}:${line}: feature imports an app-local package; use the host API: ${spec}`,
          );
          violations++;
        }
        return;
      }
      resolved = resolved.replace(/\.[cm]?jsx?$/, ".ts");
      const api = allowedApis.has(resolved) || allowedApis.has(resolved + ".ts");
      const feature = /^plugins\/([^/]+)\//.exec(file);
      const targetFeature = /^plugins\/([^/]+)\//.exec(resolved);
      let reason;
      if (feature && /^packages\/(?:server|app)\/src\//.test(resolved) && !api)
        reason = "feature imports core internals outside its host API";
      if (feature && resolved.endsWith("host-test-api.ts") && !/\.test\./.test(file))
        reason = "production feature imports a test API";
      if (feature && targetFeature && feature[1] !== targetFeature[1])
        reason = "feature imports another feature directly";
      if (
        /^packages\/(?:server|app)\/src\//.test(file) &&
        targetFeature &&
        !file.endsWith("/plugins/builtin/load.generated.ts")
      )
        reason = "core imports a feature outside the generated built-in loader";
      if (reason) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        console.error(`${file}:${line}: ${reason}: ${spec}`);
        violations++;
      }
    }
    visit(source);
  }
}
for (const dir of ["plugins", "packages/server/src", "packages/app/src"]) walk(dir);
if (violations) process.exitCode = 1;
else console.log("Built-in plugin boundaries passed");
