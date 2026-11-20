import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";
import { createPackageWithOptions } from "@electron/asar";
import { auditPackage, runtimeDependencies } from "./package-audit.ts";
import { macosVersions } from "./release-data.ts";
import { collectLicenses } from "./release-licenses.ts";
import { checkWindowsExecutable, writeWindowsPackage } from "./release-windows.ts";

const windows = process.platform === "win32";
assert.ok(process.platform === "darwin" || windows && process.arch === "x64", "Electron packages target macOS or Windows x64");
const root = fileURLToPath(new URL("..", import.meta.url)), project = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const destination = resolve(process.argv[2] ?? join(root, ".build/packages", `PractiQ-${project.version}-${process.arch}-${Date.now()}`));
assert.ok(!existsSync(destination), "Package output already exists; choose a new output directory");
mkdirSync(dirname(destination), { recursive: true }); const temporary = mkdtempSync(join(dirname(destination), ".practiq-electron-")), stage = join(temporary, "stage"), release = join(temporary, "release"), bundle = join(stage, windows ? "PractiQ" : "PractiQ.app"), resources = join(bundle, windows ? "resources" : "Contents/Resources"), runtime = join(resources, "app");
const electronDirectory = join(root, "node_modules/electron/dist"), executable = join(bundle, windows ? "PractiQ.exe" : "Contents/MacOS/PractiQ");
const run = (command: string, args: string[], cwd = root, capture = false) => {
  if (windows && command === "npm") { assert.ok(process.env.npm_execpath, "Run packaging through npm"); args = [process.env.npm_execpath, ...args]; command = process.execPath; }
  const result = spawnSync(command, args, { cwd, stdio: capture ? "pipe" : "inherit", encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  if (result.error) throw result.error; assert.equal(result.status, 0, `${command} failed${capture ? `: ${result.stderr}` : ""}`); return result.stdout;
};
const copy = (source: string, target: string) => cpSync(source, target, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/**
 * The packaged runtime must not act as a general Node interpreter, honour `NODE_OPTIONS`, grant
 * `file://` extra privileges or load application code from outside the archive. `--inspect` stays
 * available because the Playwright acceptance harness attaches to this process through the Node
 * inspector; `RunAsNode` closes the interpreter vector that a local attacker would otherwise use.
 */
const fuses = { RunAsNode: false, EnableNodeOptionsEnvironmentVariable: false, GrantFileProtocolExtraPrivileges: false, OnlyLoadAppFromAsar: true } as const;
/** Native modules stay outside the archive so dyld loads them beside their own libraries. */
const asarUnpack = { unpack: "**/*.{node,dylib,so}", unpackDir: "{node_modules/sharp,node_modules/@img}" } as const;
/** Every Mach-O file and bundle nested in the app, deepest first: `--deep` verifies but never signs. */
function signable(contents: string): { binaries: string[]; bundles: string[] } {
  const binaries: string[] = [], bundles: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      // Symbolic links inside a framework version directory point at files already visited.
      if (entry.isDirectory()) { if (/\.(?:framework|app)$/.test(entry.name)) bundles.push(path); walk(path); }
      else if (entry.isFile() && run("/usr/bin/file", ["-b", path], root, true).includes("Mach-O")) binaries.push(path);
    }
  };
  walk(contents);
  // Frameworks and helper apps are signed after their contents, and the outer app after both.
  return { binaries, bundles: bundles.sort((left, right) => right.split("/").length - left.split("/").length) };
}
function plist(path: string, changes: Record<string, string>) {
  const value = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], root, true));
  Object.assign(value, changes); writeFileSync(path, JSON.stringify(value)); run("/usr/bin/plutil", ["-convert", "xml1", path]);
}

try {
  run("npm", ["run", "build"]); run("npm", ["run", "desktop:build"]);
  mkdirSync(stage); mkdirSync(release);
  copy(windows ? electronDirectory : join(electronDirectory, "Electron.app"), bundle); mkdirSync(runtime);
  const dependencies = runtimeDependencies(root, project);
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
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) if (existsSync(join(electronDirectory, name))) cpSync(join(electronDirectory, name), join(resources, name));
  rmSync(join(resources, "default_app.asar"), { force: true });
  const inventory: { name: string; version: string; license: string; source: string; integrity: string | null }[] = [];
  const notices = ["PractiQ third-party dependencies", "Electron and Chromium: see LICENSE and LICENSES.chromium.html; source https://github.com/electron/electron", "PDFium, Unicode and parser resources: see app/.build/electron/app/desktop/resources/licenses/"];
  for (const path of Object.keys(selected).filter(path => path && existsSync(join(runtime, path, "package.json"))).sort()) {
    const metadata = JSON.parse(readFileSync(join(runtime, path, "package.json"), "utf8"));
    inventory.push({ name: metadata.name, version: metadata.version, license: typeof metadata.license === "string" ? metadata.license : "see bundled license files", source: typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url ?? metadata.homepage ?? "see bundled package.json", integrity: selected[path].integrity ?? null });
    notices.push(`${metadata.name}@${metadata.version}: ${typeof metadata.license === "string" ? metadata.license : "see bundled license files"}; source ${typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url ?? metadata.homepage ?? "see bundled package.json"}`);
  }
  const licenses = collectLicenses(root, process.arch, process.platform), licenseDirectory = join(resources, "DEPENDENCY-LICENSES"), licenseReport = JSON.stringify(licenses.report, null, 2) + "\n";
  mkdirSync(join(root, ".build/evidence"), { recursive: true }); writeFileSync(join(root, ".build/evidence", `electron-licenses-${Date.now()}.json`), licenseReport);
  assert.equal(licenses.report.passed, true, `Missing or unverified production license texts: ${[...licenses.report.missingTexts, ...licenses.report.unverifiedSources].join(", ")}`);
  mkdirSync(licenseDirectory); writeFileSync(join(licenseDirectory, "inventory.json"), licenseReport);
  for (const [name, data] of licenses.files) writeFileSync(join(licenseDirectory, name), data);
  notices.push("", licenses.notices); writeFileSync(join(resources, "THIRD-PARTY.txt"), notices.join("\n") + "\n");
  if (windows) {
    renameSync(join(bundle, "electron.exe"), executable);
    checkWindowsExecutable(executable);
    cpSync(join(root, "desktop/icons/practiq.png"), join(resources, "practiq.png"));
  } else {
    const identifier = "com.practiq.desktop";
    cpSync(join(root, "desktop/icons/practiq.icns"), join(resources, "practiq.icns"));
    plist(join(bundle, "Contents/Info.plist"), { CFBundleExecutable: "PractiQ", CFBundleName: "PractiQ", CFBundleDisplayName: "PractiQ", CFBundleIdentifier: identifier, ...macosVersions(project.version), CFBundleIconFile: "practiq.icns", LSMinimumSystemVersion: "14.0", LSApplicationCategoryType: "public.app-category.education" });
    renameSync(join(bundle, "Contents/MacOS/Electron"), executable);
    const frameworks = join(bundle, "Contents/Frameworks");
    for (const name of readdirSync(frameworks).filter(name => /^Electron Helper.*\.app$/.test(name))) {
      const path = join(frameworks, name), title = name.replace(/^Electron/, "PractiQ").slice(0, -4), old = name.slice(0, -4), suffix = /\(([^)]+)\)/.exec(name)?.[1].toLowerCase();
      plist(join(path, "Contents/Info.plist"), { CFBundleExecutable: title, CFBundleName: title, CFBundleDisplayName: title, CFBundleIdentifier: `${identifier}.helper${suffix ? `.${suffix}` : ""}` });
      renameSync(join(path, "Contents/MacOS", old), join(path, "Contents/MacOS", title)); renameSync(path, join(frameworks, `${title}.app`));
    }
  }
  run("npm", ["ls", "--omit=dev", "--all", "--json"], runtime, true);
  assert.ok(!existsSync(join(runtime, "node_modules/electron")) && !existsSync(join(runtime, "node_modules/typescript")), "Development toolchain was bundled");
  const execution = JSON.parse(readFileSync(join(runtime, ".build/electron/app/desktop/execution-version.json"), "utf8")), runtimeLockfileSha256 = sha256(join(runtime, "package-lock.json"));
  // The runtime tree is archived once; opening the app then reads one file instead of thousands.
  const archive = join(resources, "app.asar");
  await createPackageWithOptions(runtime, archive, asarUnpack);
  rmSync(runtime, { recursive: true, force: true });
  assert.ok(existsSync(archive) && existsSync(`${archive}.unpacked/node_modules/sharp`), "Archived runtime and its unpacked native directory are required");
  const asarSha256 = sha256(archive), files = auditPackage(bundle);
  // Fuse state is part of the shipped bytes, so it is flipped before the bundle is signed.
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: fuses.RunAsNode,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: fuses.EnableNodeOptionsEnvironmentVariable,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: fuses.GrantFileProtocolExtraPrivileges,
    [FuseV1Options.OnlyLoadAppFromAsar]: fuses.OnlyLoadAppFromAsar,
  });
  const signing = windows ? { signing: "unsigned" } : { signing: "ad-hoc-local", notarized: false, hardenedRuntime: true };
  const platformMetadata = windows ? { platform: "win32" } : { minimumMacOS: "14.0", entitlements: ["com.apple.security.cs.allow-jit"] };
  writeFileSync(join(resources, "PRACTIQ-BUILD.json"), JSON.stringify({ version: 1, appVersion: project.version, electronVersion: JSON.parse(readFileSync(join(root, "node_modules/electron/package.json"), "utf8")).version, arch: process.arch, ...platformMetadata, lockfileSha256: sha256(join(root, "package-lock.json")), runtimeLockfileSha256, licenseInventorySha256: sha256(join(licenseDirectory, "inventory.json")), runtimeDependencies: Object.keys(dependencies), execution, dependencies: inventory, ...signing, asar: true, asarSha256, asarUnpack, fuses }, null, 2) + "\n");
  const file = `PractiQ-${project.version}-${windows ? "windows-" : ""}${process.arch}.${windows ? "zip" : "dmg"}`, asset = join(release, file);
  if (windows) {
    await writeWindowsPackage(bundle, asset);
  } else {
    const entitlements = join(root, "scripts/desktop-entitlements.plist"), signableContents = signable(join(bundle, "Contents"));
    for (const path of [...signableContents.binaries, ...signableContents.bundles, bundle]) run("/usr/bin/codesign", ["--force", "--options", "runtime", "--entitlements", entitlements, "--sign", "-", path]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    symlinkSync("/Applications", join(stage, "Applications"));
    run("/usr/bin/hdiutil", ["create", "-volname", "PractiQ", "-srcfolder", stage, "-format", "UDZO", asset]);
    renameSync(bundle, join(release, "PractiQ.app"));
  }
  writeFileSync(join(release, "package-report.json"), JSON.stringify({ checkedAt: new Date().toISOString(), appVersion: project.version, arch: process.arch, files, ...(windows ? { platform: "win32" } : { codesignVerified: true }), noLegacyRuntime: true, ...signing, asar: true, asarSha256, fuses, [windows ? "portableZip" : "dmg"]: { file, sha256: sha256(asset) } }, null, 2) + "\n");
  renameSync(release, destination); console.log(`Electron package ready: ${destination}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
