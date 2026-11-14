import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonical, checkCandidate, checksum, command, containedFile, digest, externalAcceptanceStatus, externalSigningStatus, macosVersions, MODE, normalizedDigest, object, payloadFingerprint, publicReport, readBytes, readJson, SCHEMA, strictJson, version, versions } from "./release-data.ts";

const gates = ["desktop-bundle.json", "licenses.json", "desktop-version.json", "notices-match.json"];
const acceptances = [["cleanMachine", "clean-machine"], ["liveModel", "live-model"]] as const;
type Candidate = Record<string, any>;
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
function destination(path: string): string {
  let parent = resolve(path); const names: string[] = [];
  while (!lstatSync(parent, { throwIfNoEntry: false })) { names.unshift(basename(parent)); parent = dirname(parent); }
  return join(realpathSync(parent), ...names);
}
function fresh(path: string) { assert.ok(!lstatSync(path, { throwIfNoEntry: false }), "Choose a fresh release output directory"); }
function copyChecked(source: string, target: string, expected = checksum(source)) {
  mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target, 1); assert.equal(checksum(target), expected, "Release bytes changed while copying"); assert.equal(checksum(source), expected, "Release input changed while copying");
}
function buildRun(value: unknown): string {
  assert.equal(typeof value, "string"); const url = new URL(value as string);
  assert.ok(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.href === value && /^\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*$/.test(url.pathname), "Invalid immutable Actions build URL"); return value as string;
}
function identity(candidate: Candidate) {
  const required = ["packageSchemaVersion", "packageMode", "tag", "commit", "components", "os", "architecture", "file", "sha256", "sizeBytes", "signing", "cleanMachineAcceptance", "liveModelAcceptance", "buildRun", "evidence"], optional = ["restagedFinalBytes", "originalBuildCandidate", "signingVerification", "acceptanceVerification", "signingReport", "cleanMachineReport", "liveModelReport"];
  assert.ok(required.every(key => Object.hasOwn(candidate, key)) && Object.keys(candidate).every(key => required.includes(key) || optional.includes(key)), "Invalid release candidate schema");
  assert.equal(candidate.packageSchemaVersion, SCHEMA); assert.equal(candidate.packageMode, MODE, "Legacy and Electron package modes cannot be mixed");
  versionsTag(candidate.tag); assert.match(candidate.commit, /^[a-f0-9]{40}$/); assert.equal(candidate.os, "macos"); assert.ok(["arm64", "x64"].includes(candidate.architecture));
  assert.deepEqual(candidate.components, { desktop: versionsTag(candidate.tag) });
  assert.equal(candidate.file, `PractiQ_${candidate.components.desktop}_macos_${candidate.architecture}.dmg`);
  assert.equal(candidate.sha256, normalizedDigest(candidate.sha256)); assert.ok(Number.isSafeInteger(candidate.sizeBytes) && candidate.sizeBytes > 0); buildRun(candidate.buildRun);
}
function versionsTag(tag: string): string { assert.equal(typeof tag, "string"); return version(tag); }
function original(candidate: Candidate) { identity(candidate); assert.equal(candidate.signing, "unsigned", "Build provenance requires the original CI candidate"); for (const key of ["restagedFinalBytes", "originalBuildCandidate", "signingReport", "cleanMachineReport", "liveModelReport", "signingVerification", "acceptanceVerification"]) assert.ok(!Object.hasOwn(candidate, key), "Build provenance must be an original CI candidate"); }
function validateManifest(value: unknown, expectedVersion: string, architecture: string): void {
  const metadata = object(value); assert.deepEqual([metadata.version, metadata.appVersion, metadata.arch, metadata.minimumMacOS, metadata.signing, metadata.notarized], [1, expectedVersion, architecture, "14.0", "ad-hoc-local", false]); version(`v${metadata.electronVersion}`);
  for (const key of ["lockfileSha256", "runtimeLockfileSha256", "licenseInventorySha256"]) normalizedDigest(metadata[key]); assert.equal(object(metadata.execution).version, 1); normalizedDigest(metadata.execution.sha256);
  const names = metadata.runtimeDependencies; assert.ok(Array.isArray(names) && names.length > 0 && names.every(name => typeof name === "string" && /^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) && new Set(names).size === names.length, "Invalid runtime dependency inventory");
  assert.ok(Array.isArray(metadata.dependencies) && metadata.dependencies.length > 0);
  for (const dependency of metadata.dependencies) { const item = object(dependency); for (const key of ["name", "version", "license", "source"]) assert.ok(typeof item[key] === "string" && item[key].trim(), "Incomplete dependency notices"); assert.ok(item.integrity === null || typeof item.integrity === "string" && /^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(item.integrity)); }
}
export function validateCandidate(folder: string, tag: string, commit: string, components: unknown): Candidate {
  const raw = readBytes(containedFile(folder, "candidate.json"), 1024 * 1024), candidate = object(strictJson(raw)); identity(candidate);
  assert.deepEqual([candidate.tag, candidate.commit, candidate.components], [tag, commit, components], "Mixed release source or version");
  const asset = containedFile(folder, candidate.file); assert.equal(checksum(asset), normalizedDigest(candidate.sha256)); assert.equal(statSync(asset).size, candidate.sizeBytes);
  const evidence = object(candidate.evidence);
  const evidenceFile = (name: string) => { assert.ok(Object.hasOwn(evidence, name), `Unbound release evidence: ${name}`); return containedFile(folder, name); };
  for (const [name, sha] of Object.entries(evidence)) { assert.ok(name.startsWith("evidence/")); assert.equal(checksum(containedFile(folder, name)), normalizedDigest(sha), "Altered release evidence"); }
  for (const name of gates) assert.equal(readJson(evidenceFile(`evidence/${name}`)).passed, true, `Missing or failed ${name}`);
  for (const name of ["build-manifest.json", "THIRD-PARTY.txt", "expected-THIRD-PARTY.txt", "package-acceptance.json", "npm-license-inventory.json"]) assert.ok(Object.hasOwn(evidence, `evidence/${name}`), `Missing ${name}`);
  assert.equal(checksum(containedFile(folder, "evidence/THIRD-PARTY.txt")), checksum(containedFile(folder, "evidence/expected-THIRD-PARTY.txt")), "Final notices changed");
  assert.equal(readJson(containedFile(folder, "evidence/notices-match.json")).sha256, checksum(containedFile(folder, "evidence/THIRD-PARTY.txt")));
  assert.equal(readJson(containedFile(folder, "evidence/licenses.json")).noticesSha256, checksum(containedFile(folder, "evidence/THIRD-PARTY.txt")));
  const metadata = readJson(containedFile(folder, "evidence/build-manifest.json")); validateManifest(metadata, candidate.components.desktop, candidate.architecture);
  assert.equal(metadata.licenseInventorySha256, checksum(containedFile(folder, "evidence/npm-license-inventory.json"))); assert.equal(readJson(containedFile(folder, "evidence/licenses.json")).licenseInventorySha256, metadata.licenseInventorySha256); assert.equal(readJson(containedFile(folder, "evidence/npm-license-inventory.json")).passed, true);
  const bundle = readJson(containedFile(folder, "evidence/desktop-bundle.json")); assert.equal(bundle.noLegacyRuntime, true); normalizedDigest(bundle.payloadSha256); assert.ok(Number.isSafeInteger(bundle.files) && bundle.files > 0);
  assert.deepEqual([readJson(containedFile(folder, "evidence/desktop-version.json")).version, readJson(containedFile(folder, "evidence/desktop-version.json")).architecture], [candidate.components.desktop, candidate.architecture]);
  let build = candidate;
  if (candidate.restagedFinalBytes === true) {
    assert.equal(candidate.originalBuildCandidate, "evidence/build-candidate.json"); const provenance = readJson(evidenceFile(candidate.originalBuildCandidate));
    assert.equal(provenance.originalCandidate, "evidence/original-candidate.json"); const priorRaw = readBytes(evidenceFile(provenance.originalCandidate), 1024 * 1024), prior = object(strictJson(priorRaw)); original(prior);
    assert.equal(digest(priorRaw), normalizedDigest(provenance.candidateSha256)); assert.deepEqual(prior, provenance.candidate); assert.equal(provenance.verifiedCandidateSha256, digest(canonical(prior))); assert.equal(provenance.assetAndEvidenceVerified, true);
    assert.deepEqual(publicReport(prior, [[folder, "<candidate>"], [homedir(), "<home>"]]), prior, "Original candidate contains private paths");
    for (const key of ["tag", "commit", "components", "os", "architecture", "buildRun"]) assert.deepEqual(prior[key], candidate[key]);
    build = prior;
    const signing = candidate.signingReport ? (assert.equal(candidate.signingReport, "evidence/signing-report.json"), externalSigningStatus(readJson(evidenceFile(candidate.signingReport), 1024 * 1024), candidate.sha256)) : "unverified";
    assert.equal(candidate.signing, signing);
  } else { original(candidate); }
  validateAcceptance(readJson(containedFile(folder, "evidence/package-acceptance.json")), build);
  for (const [field, kind] of acceptances) {
    const report = candidate[`${field}Report`]; let status = "pending";
    if (report) { assert.equal(candidate.restagedFinalBytes, true); assert.equal(report, `evidence/${kind}-report.json`); status = externalAcceptanceStatus(readJson(evidenceFile(report), 1024 * 1024), kind, candidate); }
    assert.equal(candidate[`${field}Acceptance`], status, "Acceptance status differs from its bound external report");
  }
  return candidate;
}
export function validateAcceptance(value: unknown, identity: Candidate): void {
  const report = object(value); assert.equal(report.dmgSha256, identity.sha256); assert.equal(report.version, identity.components.desktop); assert.equal(report.arch, identity.architecture);
  for (const key of ["packaged", "codesignVerified", "sourceIndependentInstall", "isolatedUserData", "systemOnlyPath", "sandbox", "practice", "backupRestore", "restart", "corePassed", "credentialsEncrypted", "credentialsExcludedFromBackup", "credentialsDecryptAfterRestart"]) assert.equal(report[key], true, `Automated package acceptance is incomplete: ${key}`);
  assert.equal(report.paidCalls, 0); assert.equal(report.rendererHttpRequests, 0); assert.deepEqual([...report.codecs].sort(), ["0", "8", "12", "14", "93"].sort()); assert.ok(Number.isSafeInteger(report.pdfPages) && report.pdfPages > 0);
}

async function inspectPayload(root: string, bundle: string, tag: string): Promise<Record<string, any>> {
  const version = versions(root, tag).desktop, resources = join(bundle, "Contents/Resources"), runtime = join(resources, "app"), metadata = readJson(containedFile(resources, "PRACTIQ-BUILD.json"));
  const info = strictJson(command(root, "/usr/bin/plutil", ["-convert", "json", "-o", "-", containedFile(bundle, "Contents/Info.plist")]));
  for (const [key, value] of Object.entries(macosVersions(version))) assert.equal(info[key], value, "Final macOS version differs from the tag");
  assert.equal(info.CFBundleExecutable, "PractiQ"); assert.equal(info.CFBundleIdentifier, "com.practiq.desktop");
  const { checkMachO } = await import("./release-macho.ts"), architecture = metadata.arch;
  validateManifest(metadata, version, architecture);
  checkMachO(containedFile(bundle, "Contents/MacOS/PractiQ"), architecture);
  assert.equal(metadata.version, 1); assert.equal(metadata.appVersion, version); assert.equal(metadata.lockfileSha256, checksum(join(root, "app/package-lock.json")));
  assert.deepEqual(metadata.execution, readJson(join(root, "app/.build/electron/app/desktop/execution-version.json")), "Package code is not the tagged source build");
  assert.equal(metadata.runtimeLockfileSha256, checksum(containedFile(runtime, "package-lock.json")));
  assert.equal(payloadFingerprint(join(runtime, "dist")), payloadFingerprint(join(root, "app/dist")), "Renderer differs from the tagged source build");
  for (const group of ["app", "shared"]) {
    const compiled = join(root, "app/.build/electron", group), embedded = join(runtime, ".build/electron", group);
    const structure = (directory: string) => readdirSync(directory, { recursive: true, withFileTypes: true }).map(entry => [join(entry.parentPath, entry.name).slice(directory.length + 1), entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "unsupported"]).filter(([name]) => !["desktop/build.js", "desktop/vitest.config.js"].includes(name)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const actualStructure = structure(embedded); assert.ok(actualStructure.every(([, kind]) => kind !== "unsupported"), "Unsupported file type in compiled runtime"); assert.deepEqual(actualStructure, structure(compiled), "Compiled directory structure differs from source");
    const expected = readdirSync(compiled, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(compiled.length + 1)).filter(name => !["desktop/build.js", "desktop/vitest.config.js"].includes(name)).sort();
    const actual = readdirSync(embedded, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(embedded.length + 1)).sort(); assert.deepEqual(actual, expected, "Compiled package inventory differs from source");
    for (const name of expected) assert.equal(checksum(containedFile(embedded, name)), checksum(containedFile(compiled, name)), "Compiled code or resource differs from tagged source");
  }
  const project = readJson(join(root, "app/package.json")), packageJson = readJson(containedFile(runtime, "package.json"));
  assert.equal(metadata.electronVersion, project.devDependencies.electron); assert.equal(packageJson.version, version);
  const { runtimeDependencies, auditPackage, optionalOtherPlatform } = await import("./package-audit.ts"); const dependencies = runtimeDependencies(join(root, "app"), project);
  assert.deepEqual(packageJson.dependencies, dependencies); assert.deepEqual([...metadata.runtimeDependencies].sort(), Object.keys(dependencies).sort());
  const current = readJson(join(root, "app/package-lock.json")).packages, selected = readJson(containedFile(runtime, "package-lock.json")).packages;
  const notices = ["PractiQ third-party dependencies", "Electron and Chromium: see LICENSE and LICENSES.chromium.html; source https://github.com/electron/electron", "PDFium, Unicode and parser resources: see app/.build/electron/app/desktop/resources/licenses/"];
  const inventory: unknown[] = [];
  for (const name of Object.keys(selected).filter(name => name).sort()) {
    assert.match(name, /^(?:node_modules\/(?:@[\w.-]+\/)?[\w.-]+)(?:\/node_modules\/(?:@[\w.-]+\/)?[\w.-]+)*$/);
    const locked = selected[name], matches = Object.entries(current).filter(([key, value]: any) => key.split("node_modules/").at(-1) === name.split("node_modules/").at(-1) && value.version === locked.version && value.integrity === locked.integrity);
    assert.ok(matches.length > 0, "Runtime lock entry differs from reviewed lockfile");
    for (const key of ["os", "cpu", "libc"]) assert.ok(matches.some(([, value]: any) => canonical(value[key] ?? null) === canonical(locked[key] ?? null)), "Runtime platform metadata differs from reviewed lockfile");
    if (!existsSync(join(runtime, name, "package.json"))) {
      assert.ok(optionalOtherPlatform(locked, architecture), "Missing runtime dependency for this package target"); continue;
    }
    const source = matches.find(([key]) => existsSync(join(root, "app", key, "package.json")));
    assert.ok(source, "Runtime package differs from reviewed lockfile");
    const installed = readJson(containedFile(runtime, `${name}/package.json`)), expected = readJson(join(root, "app", source[0], "package.json"));
    for (const key of ["name", "version", "license", "repository", "homepage"]) assert.deepEqual(installed[key], expected[key], "Runtime dependency notices differ from the reviewed package");
    const license = typeof installed.license === "string" ? installed.license : "see bundled license files", origin = typeof installed.repository === "string" ? installed.repository : installed.repository?.url ?? installed.homepage ?? "see bundled package.json";
    inventory.push({ name: installed.name, version: installed.version, license, source: origin, integrity: locked.integrity ?? null }); notices.push(`${installed.name}@${installed.version}: ${license}; source ${origin}`);
  }
  assert.deepEqual(metadata.dependencies, inventory);
  const { collectLicenses } = await import("./release-licenses.ts"), licenses = collectLicenses(join(root, "app"), architecture), licenseDirectory = join(resources, "DEPENDENCY-LICENSES"); assert.equal(licenses.report.passed, true, "Production dependency license texts are missing or unverified");
  assert.deepEqual(readJson(containedFile(licenseDirectory, "inventory.json")), licenses.report); assert.equal(checksum(containedFile(licenseDirectory, "inventory.json")), metadata.licenseInventorySha256);
  assert.deepEqual(readdirSync(licenseDirectory).sort(), ["inventory.json", ...licenses.files.keys()].sort(), "License inventory differs from the source build");
  for (const [name, data] of licenses.files) assert.equal(checksum(containedFile(licenseDirectory, name)), digest(data), "Embedded license differs from verified source");
  notices.push("", licenses.notices); const expectedNotices = notices.join("\n") + "\n"; assert.equal(readFileSync(containedFile(resources, "THIRD-PARTY.txt"), "utf8"), expectedNotices);
  assert.equal(checksum(containedFile(resources, "PRACTIQ-LICENSE.txt")), checksum(join(root, "LICENSE")));
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) assert.equal(checksum(containedFile(resources, name)), checksum(join(root, "app/node_modules/electron/dist", name)));
  for (const name of readdirSync(join(root, "app/desktop/licenses"))) assert.equal(checksum(containedFile(runtime, `.build/electron/app/desktop/resources/licenses/${name}`)), checksum(join(root, "app/desktop/licenses", name)));
  command(root, "/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  return { metadata, architecture, expectedNotices, licenseReport: licenses.report, files: auditPackage(bundle) };
}
async function withInstaller<T>(root: string, installer: string, action: (snapshot: string, bundle: string, sha256: string) => Promise<T>): Promise<T> {
  assert.equal(process.platform, "darwin", "Installer staging requires macOS"); assert.ok(installer.endsWith(".dmg"));
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "practiq-release-installer-"))), snapshot = join(temporary, "installer.dmg"), mount = join(temporary, "mount"), sha = checksum(installer); let mounted = false;
  try {
    copyChecked(installer, snapshot, sha); chmodSync(snapshot, 0o400); mkdirSync(mount); command(root, "/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, snapshot]); mounted = true;
    const bundle = join(mount, "PractiQ.app"); assert.ok(lstatSync(bundle).isDirectory() && !lstatSync(bundle).isSymbolicLink());
    const fingerprint = payloadFingerprint(bundle), value = await action(snapshot, bundle, sha);
    assert.equal(payloadFingerprint(bundle), fingerprint, "Final package changed during validation"); assert.equal(checksum(snapshot), sha); assert.equal(checksum(installer), sha, "Installer changed during final handoff"); return value;
  } finally { if (mounted) command(root, "/usr/bin/hdiutil", ["detach", mount]); rmSync(temporary, { recursive: true, force: true }); }
}
export interface StageOptions { package?: string; output: string; reports: string; installer?: string; buildCandidate?: string; signingReport?: string; cleanMachineReport?: string; liveModelReport?: string; acceptance?: string }
export async function stage(root: string, tag: string, options: StageOptions, environment = process.env): Promise<void> {
  const checked = checkCandidate(root, tag), output = destination(options.output), reports = destination(options.reports);
  fresh(output); fresh(reports); assert.ok(output !== reports && !output.startsWith(`${reports}/`) && !reports.startsWith(`${output}/`), "Asset and report directories must be separate");
  const restaged = Boolean(options.installer); assert.equal(Boolean(options.buildCandidate), restaged, "Final staging requires the original build candidate");
  assert.ok(!restaged || !options.package && !options.acceptance, "Final-byte staging cannot replace the original package acceptance");
  assert.ok(restaged || !options.signingReport && !options.cleanMachineReport && !options.liveModelReport, "External reports require explicit final-byte staging");
  let prior: Candidate | undefined, originalBytes: Buffer | undefined;
  if (restaged) { const path = resolve(options.buildCandidate!); prior = validateCandidate(dirname(path), tag, checked.commit, checked.components); original(prior); originalBytes = readBytes(containedFile(dirname(path), "candidate.json"), 1024 * 1024); assert.equal(resolve(path), resolve(dirname(path), "candidate.json")); }
  const packageDirectory = options.package ? realpathSync(options.package) : undefined, packageReport = packageDirectory ? readJson(containedFile(packageDirectory, "package-report.json")) : undefined;
  assert.ok(restaged || packageReport, "Pass a freshly checked Electron package directory");
  const installer = options.installer ? resolve(options.installer) : containedFile(packageDirectory!, packageReport.dmg.file);
  if (!restaged) { assert.equal(packageReport.noLegacyRuntime, true); assert.equal(packageReport.codesignVerified, true); assert.equal(packageReport.appVersion, checked.components.desktop); assert.equal(packageReport.dmg.file, `PractiQ-${checked.components.desktop}-${packageReport.arch}.dmg`); assert.equal(checksum(installer), packageReport.dmg.sha256); }
  mkdirSync(reports, { recursive: true }); mkdirSync(dirname(output), { recursive: true }); const temporary = mkdtempSync(join(dirname(output), ".practiq-release-stage-")), staged = join(temporary, "assets");
  try {
    command(join(root, "app"), "npm", ["run", "build"]); command(join(root, "app"), "npm", ["run", "desktop:build"]);
    await withInstaller(root, installer, async (snapshot, bundle, sha256) => {
      const verified = await inspectPayload(root, bundle, tag), resources = join(bundle, "Contents/Resources");
      const candidate: Candidate = { packageSchemaVersion: SCHEMA, packageMode: MODE, tag, commit: checked.commit, components: checked.components, os: "macos", architecture: verified.architecture, file: `PractiQ_${checked.components.desktop}_macos_${verified.architecture}.dmg`, sha256, sizeBytes: statSync(snapshot).size, signing: restaged ? "unverified" : "unsigned", cleanMachineAcceptance: "pending", liveModelAcceptance: "pending", buildRun: prior?.buildRun ?? buildRun(`${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`) };
      const accepted = restaged ? readJson(containedFile(dirname(options.buildCandidate!), "evidence/package-acceptance.json")) : readJson(options.acceptance ?? join(root, "app/.build/evidence/electron-package-acceptance.json")); validateAcceptance(accepted, prior ?? candidate);
      json(join(reports, "package-acceptance.json"), accepted); json(join(reports, "build-manifest.json"), verified.metadata); json(join(reports, "desktop-bundle.json"), { passed: true, files: verified.files, noLegacyRuntime: true, payloadSha256: payloadFingerprint(bundle) });
      json(join(reports, "desktop-version.json"), { passed: true, version: checked.components.desktop, architecture: verified.architecture }); json(join(reports, "licenses.json"), { passed: true, noticesSha256: checksum(containedFile(resources, "THIRD-PARTY.txt")), licenseInventorySha256: verified.metadata.licenseInventorySha256, packages: verified.licenseReport.packages.length }); copyChecked(containedFile(resources, "DEPENDENCY-LICENSES/inventory.json"), join(reports, "npm-license-inventory.json"));
      copyChecked(containedFile(resources, "THIRD-PARTY.txt"), join(reports, "THIRD-PARTY.txt")); writeFileSync(join(reports, "expected-THIRD-PARTY.txt"), verified.expectedNotices, { flag: "wx" }); json(join(reports, "notices-match.json"), { passed: true, sha256: checksum(join(reports, "THIRD-PARTY.txt")) });
      if (prior) {
        candidate.restagedFinalBytes = true; candidate.originalBuildCandidate = "evidence/build-candidate.json";
        assert.deepEqual(publicReport(prior, [[root, "<source>"], [homedir(), "<home>"]]), prior, "Original candidate contains private paths"); writeFileSync(join(reports, "original-candidate.json"), originalBytes!, { flag: "wx" });
        json(join(reports, "build-candidate.json"), { candidate: prior, candidateSha256: digest(originalBytes!), originalCandidate: "evidence/original-candidate.json", verifiedCandidateSha256: digest(canonical(prior)), assetAndEvidenceVerified: true, provenanceReview: "Original Actions provenance requires independent verification" });
        candidate.signingVerification = "External signing declarations are not publisher or notarization verification"; candidate.acceptanceVerification = "External acceptance report identities checked; acceptance not executed by staging";
        if (options.signingReport) { const report = readJson(options.signingReport, 1024 * 1024); candidate.signing = externalSigningStatus(report, sha256); candidate.signingReport = "evidence/signing-report.json"; json(join(reports, "signing-report.json"), report); }
        for (const [field, kind] of acceptances) { const path = options[field === "cleanMachine" ? "cleanMachineReport" : "liveModelReport"]; if (path) { const report = readJson(path, 1024 * 1024); candidate[`${field}Acceptance`] = externalAcceptanceStatus(report, kind, candidate); candidate[`${field}Report`] = `evidence/${kind}-report.json`; json(join(reports, `${kind}-report.json`), report); } }
      }
      mkdirSync(join(staged, "evidence"), { recursive: true }); copyChecked(snapshot, join(staged, candidate.file), sha256);
      for (const name of readdirSync(reports).sort()) {
        const path = containedFile(reports, name), target = join(staged, "evidence", name);
        if (name.endsWith(".json") && name !== "original-candidate.json") json(target, publicReport(readJson(path), [[root, "<source>"], [reports, "<reports>"], [homedir(), "<home>"]])); else copyChecked(path, target);
      }
      candidate.evidence = Object.fromEntries(readdirSync(join(staged, "evidence")).sort().map(name => [`evidence/${name}`, checksum(join(staged, "evidence", name))])); json(join(staged, "candidate.json"), candidate); validateCandidate(staged, tag, checked.commit, checked.components);
    });
    assert.deepEqual(checkCandidate(root, tag), checked, "Candidate source changed during staging"); fresh(output); renameSync(staged, output);
  } catch (error) { json(join(reports, "stage-failure.json"), { passed: false, message: error instanceof Error ? error.message : "Release staging failed" }); throw error; }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}

export async function assemble(root: string, tag: string, inputs: string, outputPath: string, changes?: string): Promise<void> {
  const checked = checkCandidate(root, tag), source = realpathSync(inputs), output = destination(outputPath); fresh(output);
  assert.ok(!output.startsWith(`${source}/`) && !source.startsWith(`${output}/`) && output !== source, "Release output must be separate from its inputs");
  const folders = readdirSync(source, { withFileTypes: true }).filter(entry => entry.name.startsWith("release-") && existsSync(join(source, entry.name, "candidate.json")));
  assert.equal(folders.length, 1, "Exactly one gated macOS candidate is required"); assert.ok(folders[0].isDirectory() && !folders[0].isSymbolicLink());
  const folder = join(source, folders[0].name), candidate = validateCandidate(folder, tag, checked.commit, checked.components), raw = readBytes(containedFile(folder, "candidate.json"), 1024 * 1024);
  assert.deepEqual(strictJson(raw), candidate, "Candidate changed during assembly");
  const { readAiReports } = await import("./release-reports.ts"), reports = await readAiReports(join(source, "embedded-ai-checks"), [[root, "<source>"], [source, "<inputs>"], [homedir(), "<home>"]]);
  const { writeZip, BoundedZip } = await import(new URL("../.build/electron/app/desktop/zip.js", import.meta.url).href) as typeof import("../desktop/zip.js");
  const entries: import("../desktop/zip.js").ZipSource[] = [{ name: "macos/candidate.json", data: raw }], expected: Record<string, string> = { "macos/candidate.json": digest(raw) };
  for (const [name, sha] of Object.entries(candidate.evidence)) {
    const path = containedFile(folder, name); entries.push({ name: `macos/${name}`, path, sha256: normalizedDigest(sha), size: statSync(path).size }); expected[`macos/${name}`] = normalizedDigest(sha);
  }
  for (const report of reports) { entries.push({ name: report.name, data: report.data }); expected[report.name] = digest(report.data); }
  mkdirSync(dirname(output), { recursive: true }); const temporary = mkdtempSync(join(dirname(output), ".practiq-release-assemble-")), staged = join(temporary, "assets"); mkdirSync(staged);
  try {
    copyChecked(containedFile(folder, candidate.file), join(staged, candidate.file), candidate.sha256);
    const archivePath = join(staged, "release-evidence.zip"), limit = 64 * 1024 * 1024;
    await writeZip(archivePath, entries, limit); const archive = await BoundedZip.open(archivePath, { archiveBytes: limit, expandedBytes: limit, entries: 512 });
    try { assert.deepEqual([...archive.entries.keys()].sort(), Object.keys(expected).sort(), "Evidence archive inventory changed"); for (const [name, sha] of Object.entries(expected)) assert.equal(digest(await archive.read(name, 16 * 1024 * 1024)), sha, "Evidence archive bytes changed"); } finally { archive.close(); }
    const manifest = { packageSchemaVersion: SCHEMA, packageMode: MODE, componentScope: "Single Electron application with embedded AI workers", ...checked, publicationStatus: "draft; independent signing and manual/live acceptance pending", assets: [candidate], evidenceSha256: checksum(archivePath), embeddedAiReports: reports.map(report => ({ file: report.name, sourceSha256: report.sourceSha256, publicSha256: digest(report.data), sanitized: true })) };
    json(join(staged, "release-manifest.json"), manifest);
    writeFileSync(join(staged, "SHA256SUMS.txt"), readdirSync(staged).sort().map(name => `${checksum(containedFile(staged, name))}  ${name}\n`).join(""), { flag: "wx" });
    const decode = (path: string) => new TextDecoder("utf-8", { fatal: true }).decode(readBytes(path, 1024 * 1024));
    const substitutions = { TAG: tag, VERSION: checked.components.desktop, COMMIT: checked.commit, ARCH: candidate.architecture, CHANGES: changes ? decode(changes) : "<!-- Add reviewed user-visible additions and fixes. -->" };
    let notes = decode(join(root, ".github/RELEASE_TEMPLATE.md"));
    notes = notes.replace(/@([A-Z_]+)@/g, (placeholder, key: string) => { assert.ok(Object.hasOwn(substitutions, key), `Unknown release template field: ${placeholder}`); return substitutions[key as keyof typeof substitutions]; });
    writeFileSync(join(staged, "RELEASE_NOTES.md"), notes, { flag: "wx" });
    assert.deepEqual(checkCandidate(root, tag), checked, "Candidate source changed during assembly"); assert.equal(checksum(containedFile(folder, "candidate.json")), digest(raw)); validateCandidate(folder, tag, checked.commit, checked.components);
    for (const report of reports) assert.equal(checksum(containedFile(join(source, "embedded-ai-checks"), report.name.slice("embedded-ai/".length))), report.sourceSha256, "CI evidence changed during assembly");
    assert.equal(checksum(join(staged, candidate.file)), candidate.sha256); fresh(output); renameSync(staged, output);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function checkExisting(path: string, tag: string): void {
  version(tag); const pages = readJson(path); assert.ok(Array.isArray(pages) && pages.every(page => Array.isArray(page)), "Expected paginated GitHub release metadata");
  for (const page of pages) for (const release of page) { assert.equal(typeof object(release).tag_name, "string"); assert.notEqual(release.tag_name, tag, "Release already exists; do not replace its assets"); }
}

export async function main(root: string, args = process.argv.slice(2), environment = process.env): Promise<void> {
  const names = ["tag", "package", "output", "reports", "installer", "build-candidate", "signing-report", "clean-machine-report", "live-model-report", "acceptance", "inputs", "changes"];
  const parsed = parseArgs({ args, options: Object.fromEntries(names.map(name => [name, { type: "string" as const }])), allowPositionals: true, tokens: true, strict: true }), values = parsed.values;
  const used = parsed.tokens.filter(token => token.kind === "option").map(token => token.name); assert.equal(new Set(used).size, used.length, "Duplicate release options");
  assert.equal(parsed.positionals.length, 1, "Choose check, check-existing, stage or assemble"); const operation = parsed.positionals[0], tag = values.tag; assert.ok(tag); version(tag);
  const allowed: Record<string, string[]> = { check: ["tag"], "check-existing": ["tag", "inputs"], stage: ["tag", "package", "output", "reports", "installer", "build-candidate", "signing-report", "clean-machine-report", "live-model-report", "acceptance"], assemble: ["tag", "inputs", "output", "changes"] };
  assert.ok(Object.hasOwn(allowed, operation) && used.every(name => allowed[operation].includes(name)), "Unknown command or inapplicable release option");
  if (operation === "check-existing") { assert.ok(values.inputs); checkExisting(values.inputs, tag); return; }
  if (operation === "check") {
    const checked = checkCandidate(root, tag); if (environment.WORKFLOW_REF !== undefined) assert.equal(environment.WORKFLOW_REF, `refs/tags/${tag}`); if (environment.WORKFLOW_SHA !== undefined) assert.equal(environment.WORKFLOW_SHA, checked.commit);
    console.log(JSON.stringify(checked)); if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, `sha=${checked.commit}\nprerelease=${checked.prerelease}\n`); return;
  }
  assert.ok(values.output, "An explicit fresh output directory is required");
  if (operation === "assemble") { assert.ok(values.inputs); await assemble(root, tag, values.inputs, values.output, values.changes); return; }
  assert.ok(values.reports, "An explicit fresh report directory is required");
  await stage(root, tag, { package: values.package, output: values.output, reports: values.reports, installer: values.installer, buildCandidate: values["build-candidate"], signingReport: values["signing-report"], cleanMachineReport: values["clean-machine-report"], liveModelReport: values["live-model-report"], acceptance: values.acceptance }, environment);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(fileURLToPath(new URL("../../", import.meta.url)));
