import assert from "node:assert/strict";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { createHash } from "node:crypto";
import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "Electron packages target macOS only");
const root = fileURLToPath(new URL("..", import.meta.url)), project = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const destination = resolve(process.argv[2] ?? join(root, ".build/packages", `PractiQ-${project.version}-${process.arch}-${Date.now()}`));
assert.ok(!existsSync(destination), "Package output already exists; choose a new output directory");
mkdirSync(dirname(destination), { recursive: true }); const temporary = mkdtempSync(join(dirname(destination), ".practiq-electron-")), stage = join(temporary, "stage"), release = join(temporary, "release"), bundle = join(stage, "PractiQ.app"), resources = join(bundle, "Contents/Resources"), runtime = join(resources, "app");
const run = (command: string, args: string[], cwd = root, capture = false) => {
  const result = spawnSync(command, args, { cwd, stdio: capture ? "pipe" : "inherit", encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  if (result.error) throw result.error; assert.equal(result.status, 0, `${command} failed${capture ? `: ${result.stderr}` : ""}`); return result.stdout;
};
const copy = (source: string, target: string) => cpSync(source, target, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function moduleNames(source: string): string[] {
  const imports: string[] = [];
  const isNode = (value: unknown): value is Node => value !== null && typeof value === "object" && "type" in value && typeof value.type === "string";
  const visit = (node: Node) => {
    if ((node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ImportExpression") && node.source?.type === "StringLiteral") imports.push(node.source.value);
    if (node.type === "CallExpression" && node.arguments[0]?.type === "StringLiteral") {
      const call = node.callee, require = call.type === "Identifier" && call.name === "require", resolve = call.type === "MemberExpression" && !call.computed && call.property.type === "Identifier" && call.property.name === "resolve" && call.object.type === "MetaProperty" && call.object.meta.name === "import" && call.object.property.name === "meta";
      if (require || resolve) imports.push(node.arguments[0].value);
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.filter(isNode).forEach(visit); else if (isNode(value)) visit(value);
  };
  visit(parse(source, { sourceType: "module" })); return imports;
}
function runtimeDependencies() {
  const directory = join(root, ".build/electron"), desktop = join(directory, "app/desktop"), pending = readdirSync(desktop).filter(name => name.endsWith(".js") && !["build.js", "vitest.config.js"].includes(name)).map(name => join(desktop, name)), seen = new Set<string>(), packages = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!; if (seen.has(path)) continue; seen.add(path);
    for (const name of moduleNames(readFileSync(path, "utf8"))) {
      if (name.startsWith(".")) { const local = resolve(dirname(path), name); assert.ok(local.startsWith(`${directory}/`) && existsSync(local), "Compiled dependency is missing or outside the runtime"); if (local.endsWith(".js")) pending.push(local); }
      else if (!name.startsWith("node:") && name !== "electron") packages.add(name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]);
    }
  }
  return Object.fromEntries([...packages].sort().map(name => { assert.ok(project.dependencies[name], `Declare runtime dependency ${name}`); return [name, project.dependencies[name]]; }));
}
function plist(path: string, changes: Record<string, string>) {
  const value = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], root, true));
  Object.assign(value, changes); writeFileSync(path, JSON.stringify(value)); run("/usr/bin/plutil", ["-convert", "xml1", path]);
}
function audit(directory: string) {
  let files = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) { assert.ok(realpathSync(path).startsWith(`${realpathSync(bundle)}/`), "Package link escapes the app bundle"); continue; }
    if (stat.isDirectory()) files += audit(path);
    else { assert.ok(stat.isFile() && !/^(?:python(?:[0-9.]*)?|soffice|libreoffice|postgres|pg_ctl|rabbitmq-server|erl)$/i.test(name) && !/\.(?:py|pyc|rs)$/.test(name) && !/^\.env(?:\.|$)/.test(name), `Forbidden legacy runtime or environment file: ${relative(bundle, path)}`); files++; }
  }
  return files;
}
try {
  run("npm", ["run", "build"]); run("npm", ["run", "desktop:build"]);
  mkdirSync(stage); mkdirSync(release);
  copy(join(root, "node_modules/electron/dist/Electron.app"), bundle); mkdirSync(runtime);
  const dependencies = runtimeDependencies();
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ ...project, dependencies, devDependencies: {}, scripts: {}, main: ".build/electron/app/desktop/main.js" }, null, 2));
  cpSync(join(root, "package-lock.json"), join(runtime, "package-lock.json"));
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], runtime);
  const locked = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages, selected = JSON.parse(readFileSync(join(runtime, "package-lock.json"), "utf8")).packages;
  for (const [path, item] of Object.entries(selected) as [string, { version: string; integrity?: string }][]) if (path) assert.ok(Object.entries(locked).some(([originalPath, original]) => originalPath.split("node_modules/").at(-1) === path.split("node_modules/").at(-1) && (original as typeof item).version === item.version && (original as typeof item).integrity === item.integrity), "Runtime dependency differs from the reviewed lockfile");
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], runtime);
  copy(join(root, "dist"), join(runtime, "dist"));
  for (const name of ["app", "shared"]) copy(join(root, ".build/electron", name), join(runtime, ".build/electron", name));
  for (const name of ["build.js", "vitest.config.js"]) rmSync(join(runtime, ".build/electron/app/desktop", name), { force: true });
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: project.name, productName: "PractiQ", version: project.version, type: "module", main: ".build/electron/app/desktop/main.js", dependencies }, null, 2) + "\n");
  cpSync(join(root, "../LICENSE"), join(resources, "PRACTIQ-LICENSE.txt"));
  const electronDirectory = join(root, "node_modules/electron/dist");
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) if (existsSync(join(electronDirectory, name))) cpSync(join(electronDirectory, name), join(resources, name));
  rmSync(join(resources, "default_app.asar"), { force: true });
  cpSync(join(root, "desktop/icons/practiq.icns"), join(resources, "practiq.icns"));
  const inventory: { name: string; version: string; license: string; source: string; integrity: string | null }[] = [];
  const notices = ["PractiQ third-party dependencies", "Electron and Chromium: see LICENSE and LICENSES.chromium.html; source https://github.com/electron/electron", "PDFium, Unicode and parser resources: see app/.build/electron/app/desktop/resources/licenses/"];
  for (const path of Object.keys(selected).filter(path => path && existsSync(join(runtime, path, "package.json"))).sort()) {
    const metadata = JSON.parse(readFileSync(join(runtime, path, "package.json"), "utf8"));
    inventory.push({ name: metadata.name, version: metadata.version, license: typeof metadata.license === "string" ? metadata.license : "see bundled license files", source: typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url ?? metadata.homepage ?? "see bundled package.json", integrity: selected[path].integrity ?? null });
    notices.push(`${metadata.name}@${metadata.version}: ${typeof metadata.license === "string" ? metadata.license : "see bundled license files"}; source ${typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url ?? metadata.homepage ?? "see bundled package.json"}`);
  }
  writeFileSync(join(resources, "THIRD-PARTY.txt"), notices.join("\n") + "\n");
  const identifier = "com.practiq.desktop";
  plist(join(bundle, "Contents/Info.plist"), { CFBundleExecutable: "PractiQ", CFBundleName: "PractiQ", CFBundleDisplayName: "PractiQ", CFBundleIdentifier: identifier, CFBundleShortVersionString: project.version, CFBundleVersion: project.version, CFBundleIconFile: "practiq.icns", LSMinimumSystemVersion: "14.0", LSApplicationCategoryType: "public.app-category.education" });
  renameSync(join(bundle, "Contents/MacOS/Electron"), join(bundle, "Contents/MacOS/PractiQ"));
  const frameworks = join(bundle, "Contents/Frameworks");
  for (const name of readdirSync(frameworks).filter(name => /^Electron Helper.*\.app$/.test(name))) {
    const path = join(frameworks, name), title = name.replace(/^Electron/, "PractiQ").slice(0, -4), old = name.slice(0, -4), suffix = /\(([^)]+)\)/.exec(name)?.[1].toLowerCase();
    plist(join(path, "Contents/Info.plist"), { CFBundleExecutable: title, CFBundleName: title, CFBundleDisplayName: title, CFBundleIdentifier: `${identifier}.helper${suffix ? `.${suffix}` : ""}` });
    renameSync(join(path, "Contents/MacOS", old), join(path, "Contents/MacOS", title)); renameSync(path, join(frameworks, `${title}.app`));
  }
  const files = audit(bundle); run("npm", ["ls", "--omit=dev", "--all", "--json"], runtime, true);
  assert.ok(!existsSync(join(runtime, "node_modules/electron")) && !existsSync(join(runtime, "node_modules/typescript")), "Development toolchain was bundled");
  writeFileSync(join(resources, "PRACTIQ-BUILD.json"), JSON.stringify({ version: 1, appVersion: project.version, electronVersion: JSON.parse(readFileSync(join(root, "node_modules/electron/package.json"), "utf8")).version, arch: process.arch, minimumMacOS: "14.0", lockfileSha256: sha256(join(root, "package-lock.json")), runtimeLockfileSha256: sha256(join(runtime, "package-lock.json")), runtimeDependencies: Object.keys(dependencies), execution: JSON.parse(readFileSync(join(runtime, ".build/electron/app/desktop/execution-version.json"), "utf8")), dependencies: inventory, signing: "ad-hoc-local", notarized: false }, null, 2) + "\n");
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]); run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  symlinkSync("/Applications", join(stage, "Applications")); const dmgName = `PractiQ-${project.version}-${process.arch}.dmg`;
  run("/usr/bin/hdiutil", ["create", "-volname", "PractiQ", "-srcfolder", stage, "-format", "UDZO", join(release, dmgName)]);
  renameSync(bundle, join(release, "PractiQ.app"));
  writeFileSync(join(release, "package-report.json"), JSON.stringify({ checkedAt: new Date().toISOString(), appVersion: project.version, arch: process.arch, files, codesignVerified: true, noLegacyRuntime: true, notarized: false, signing: "ad-hoc-local", dmg: { file: dmgName, sha256: sha256(join(release, dmgName)) } }, null, 2) + "\n");
  renameSync(release, destination); console.log(`Electron package ready: ${destination}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
