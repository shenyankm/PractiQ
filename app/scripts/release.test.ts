import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble, checkExisting, main, stage, validateAcceptance, validateCandidate } from "./release.ts";
import { canonical, checksum, digest, readJson } from "./release-data.ts";
import { publicXml, readAiReports } from "./release-reports.ts";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url)), tag = "v0.2.2";
type Value = Record<string, any>;
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
function accepted(candidate: Value): Value {
  return { version: candidate.components.desktop, arch: candidate.architecture, dmgSha256: candidate.sha256, packaged: true, codesignVerified: true, sourceIndependentInstall: true, isolatedUserData: true, systemOnlyPath: true, sandbox: true, practice: true, backupRestore: true, restart: true, corePassed: true, credentialsEncrypted: true, credentialsExcludedFromBackup: true, credentialsDecryptAfterRestart: true, paidCalls: 0, rendererHttpRequests: 0, codecs: ["0", "8", "12", "14", "93"], pdfPages: 2 };
}
function ci(folder: string) {
  const reports: Record<string, string> = {
    "app/.build/reports/desktop.xml": '<?xml version="1.0"?><testsuites tests="2" failures="0" errors="0"><testsuite tests="2" failures="0" errors="0" hostname="private-host"><testcase name="works"/><testcase name="open &quot;/Users/private/file with spaces&quot;"><system-out><![CDATA[read /Users/private/result.json]]></system-out></testcase></testsuite></testsuites>',
    "coverage/desktop/coverage-summary.json": JSON.stringify({ total: Object.fromEntries(["statements", "lines", "functions", "branches"].map(name => [name, { total: 10, covered: 9, skipped: 0, pct: 90 }])), "/Users/private/project/app/desktop/example.ts": { lines: { total: 10, covered: 9, pct: 90 } } }),
    "coverage/desktop/cobertura-coverage.xml": '<?xml version="1.0"?><!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd"><coverage lines-valid="10" lines-covered="9" line-rate="0.9" branches-valid="10" branches-covered="9" branch-rate="0.9"><sources><source>/Users/private/project/app</source></sources></coverage>',
    "coverage/desktop/lcov.info": "TN:\nSF:/Users/private/project/app/desktop/example.ts\nLF:10\nLH:9\nFNF:10\nFNH:9\nBRF:10\nBRH:9\nend_of_record\n"
  };
  for (const [name, text] of Object.entries(reports)) { const path = join(folder, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
}
async function fixture(action: (value: { root: string; folder: string; inputs: string; candidate: Value; save: () => void }) => void | Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "practiq-release-test-")));
  try {
    mkdirSync(join(root, "app")); json(join(root, "app/package.json"), { version: "0.2.2" }); json(join(root, "app/package-lock.json"), { version: "0.2.2", packages: { "": { version: "0.2.2" } } });
    mkdirSync(join(root, ".github")); copyFileSync(join(projectRoot, ".github/RELEASE_TEMPLATE.md"), join(root, ".github/RELEASE_TEMPLATE.md")); writeFileSync(join(root, ".gitignore"), ".work/\napp/.build/\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Release test", "-c", "user.email=release@example.test", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", `core.hooksPath=${join(root, "no-hooks")}`, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q"); git("add", "."); git("commit", "-qm", "Release fixture"); git("update-ref", "refs/remotes/origin/main", "HEAD"); git("tag", "-am", "Candidate", tag);
    const inputs = join(root, ".work/inputs"), folder = join(inputs, "release-macOS"), evidence = join(folder, "evidence"); mkdirSync(evidence, { recursive: true });
    const file = "PractiQ_0.2.2_macos_arm64.dmg"; writeFileSync(join(folder, file), "Synthetic installer bytes; never executed");
    const candidate: Value = { packageSchemaVersion: 1, packageMode: "electron-desktop", tag, commit: git("rev-parse", "HEAD"), components: { desktop: "0.2.2" }, os: "macos", architecture: "arm64", file, sha256: checksum(join(folder, file)), sizeBytes: readFileSync(join(folder, file)).length, signing: "unsigned", cleanMachineAcceptance: "pending", liveModelAcceptance: "pending", buildRun: "https://github.com/test/practiq/actions/runs/42", evidence: {} };
    for (const name of ["THIRD-PARTY.txt", "expected-THIRD-PARTY.txt"]) writeFileSync(join(evidence, name), "Synthetic notices\n");
    json(join(evidence, "build-manifest.json"), { version: 1, appVersion: "0.2.2", arch: "arm64", minimumMacOS: "14.0", electronVersion: "45.3.1", lockfileSha256: "a".repeat(64), runtimeLockfileSha256: "b".repeat(64), execution: { version: 1, sha256: "c".repeat(64) }, runtimeDependencies: ["example"], dependencies: [{ name: "example", version: "1.0.0", license: "MIT", source: "https://example.test", integrity: null }], signing: "ad-hoc-local", notarized: false }); json(join(evidence, "desktop-bundle.json"), { passed: true, files: 1, noLegacyRuntime: true, payloadSha256: "d".repeat(64) }); json(join(evidence, "desktop-version.json"), { passed: true, version: "0.2.2", architecture: "arm64" }); json(join(evidence, "licenses.json"), { passed: true, noticesSha256: checksum(join(evidence, "THIRD-PARTY.txt")) }); json(join(evidence, "notices-match.json"), { passed: true, sha256: checksum(join(evidence, "THIRD-PARTY.txt")) }); json(join(evidence, "package-acceptance.json"), accepted(candidate));
    json(join(evidence, "npm-license-inventory.json"), { version: 1, passed: true, packages: [{ name: "example", version: "1.0.0" }] });
    const manifest = readJson(join(evidence, "build-manifest.json")), licenseReport = readJson(join(evidence, "licenses.json")); manifest.licenseInventorySha256 = licenseReport.licenseInventorySha256 = checksum(join(evidence, "npm-license-inventory.json")); json(join(evidence, "build-manifest.json"), manifest); json(join(evidence, "licenses.json"), licenseReport);
    const save = () => { candidate.evidence = Object.fromEntries(Object.keys(candidate.evidence).length ? Object.keys(candidate.evidence).map(name => [name, checksum(join(folder, name))]) : ["build-manifest.json", "desktop-bundle.json", "desktop-version.json", "licenses.json", "npm-license-inventory.json", "notices-match.json", "package-acceptance.json", "THIRD-PARTY.txt", "expected-THIRD-PARTY.txt"].map(name => [`evidence/${name}`, checksum(join(evidence, name))])); json(join(folder, "candidate.json"), candidate); };
    save(); ci(join(inputs, "embedded-ai-checks")); await action({ root, inputs, folder, candidate, save });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("assembly archives exact candidate/evidence bytes, sanitizes CI reports and stays a draft", () => fixture(async ({ root, inputs, folder, candidate }) => {
  const yaml = createRequire(new URL("../package.json", import.meta.url))("js-yaml"), workflow = yaml.load(readFileSync(join(projectRoot, ".github/workflows/release.yml"), "utf8"));
  const downloads = workflow.jobs.draft.steps.filter((step: Value) => step.uses?.startsWith("actions/download-artifact@"));
  assert.deepEqual(downloads.map((step: Value) => step.with.name), ["release-macOS", "embedded-ai-checks"]);
  for (const step of downloads) cpSync(join(inputs, step.with.name), join(root, step.with.path), { recursive: true });
  const downloaded = join(root, "app/.build/release-inputs"), output = join(root, ".work/assets"); await assemble(root, tag, downloaded, output);
  assert.deepEqual(readJson(join(output, "release-manifest.json")).assets, [candidate]); assert.match(readJson(join(output, "release-manifest.json")).publicationStatus, /^draft;/);
  assert.equal(checksum(join(output, candidate.file)), candidate.sha256);
  const { BoundedZip } = await import(new URL("../.build/electron/app/desktop/zip.js", import.meta.url).href) as typeof import("../desktop/zip.js");
  const zip = await BoundedZip.open(join(output, "release-evidence.zip"), { archiveBytes: 64 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024, entries: 512 });
  try {
    assert.deepEqual(await zip.read("macos/candidate.json", 1024 * 1024), readFileSync(join(folder, "candidate.json")));
    for (const [name, hash] of Object.entries(candidate.evidence)) assert.equal(digest(await zip.read(`macos/${name}`, 1024 * 1024)), hash);
    for (const name of [...zip.entries.keys()].filter(name => name.startsWith("embedded-ai/"))) { const text = (await zip.read(name, 16 * 1024 * 1024)).toString("utf8"); assert.doesNotMatch(text, /private|private-host/); if (name.endsWith(".xml")) await publicXml(text, name.endsWith("desktop.xml") ? "testsuites" : "coverage"); }
  } finally { zip.close(); }
  for (const line of readFileSync(join(output, "SHA256SUMS.txt"), "utf8").trim().split("\n")) { const [hash, name] = line.split("  "); assert.equal(checksum(join(output, name)), hash); }
  const notes = readFileSync(join(output, "RELEASE_NOTES.md"), "utf8"); assert.doesNotMatch(notes, /@[A-Z_]+@|\[x\]/); assert.ok(notes.includes(candidate.commit));
  await assert.rejects(assemble(root, tag, inputs, output)); assert.equal(checksum(join(output, candidate.file)), candidate.sha256);
}));

for (const mutation of ["commit", "components", "schema", "mode", "architecture", "file", "buildRun", "asset", "size", "evidence", "gate", "missingGate", "notice", "version", "licenseHash", "acceptance", "duplicate", "link"])
  test(`candidate rejects ${mutation} drift before publishing`, () => fixture(async ({ root, inputs, folder, candidate, save }) => {
    const path = (name: string) => join(folder, "evidence", name);
    if (mutation === "commit") candidate.commit = "a".repeat(40);
    if (mutation === "components") candidate.components.desktop = "0.0.0";
    if (mutation === "schema") candidate.packageSchemaVersion = 2;
    if (mutation === "mode") candidate.packageMode = "desktop-practice";
    if (mutation === "architecture") candidate.architecture = "x64";
    if (mutation === "file") candidate.file = "../outside.dmg";
    if (mutation === "buildRun") candidate.buildRun = "https://github.com/test/practiq/actions/runs/42?token=secret";
    if (mutation === "asset") writeFileSync(join(folder, candidate.file), "Different installer");
    if (mutation === "size") candidate.sizeBytes++;
    if (mutation === "gate") json(path("licenses.json"), { passed: false });
    if (mutation === "missingGate") delete candidate.evidence["evidence/licenses.json"];
    if (mutation === "notice") writeFileSync(path("expected-THIRD-PARTY.txt"), "Different notices");
    if (mutation === "version") json(path("desktop-version.json"), { passed: true, version: "0.2.1", architecture: "arm64" });
    if (mutation === "licenseHash") json(path("licenses.json"), { passed: true, noticesSha256: "a".repeat(64) });
    if (mutation === "acceptance") json(path("package-acceptance.json"), { ...accepted(candidate), credentialsEncrypted: false });
    save();
    if (mutation === "evidence") writeFileSync(path("licenses.json"), "Altered evidence without updating hash");
    if (mutation === "duplicate") { const p = join(folder, "candidate.json"); writeFileSync(p, readFileSync(p, "utf8").replace('"signing": "unsigned"', '"signing": "unsigned", "signing": "unsigned"')); }
    if (mutation === "link") { const p = path("licenses.json"), copy = join(root, ".work/external.json"); copyFileSync(p, copy); rmSync(p); symlinkSync(copy, p); }
    const output = join(root, ".work/rejected"); await assert.rejects(assemble(root, tag, inputs, output)); assert.equal(existsSync(output), false);
  }));

test("original candidates cannot claim signing, acceptance or restaged provenance", () => fixture(({ folder, candidate, save }) => {
  for (const patch of [{ signing: "verified" }, { cleanMachineAcceptance: "passed" }, { liveModelAcceptance: "passed" }, { restagedFinalBytes: false }, { originalBuildCandidate: "evidence/build-candidate.json" }, { unexpected: true }]) {
    const before = structuredClone(candidate); Object.assign(candidate, patch); save(); assert.throws(() => validateCandidate(folder, tag, candidate.commit, { desktop: "0.2.2" })); for (const key of Object.keys(candidate)) delete candidate[key]; Object.assign(candidate, before);
  }
}));

test("candidate build metadata requires bounded source hashes, runtime identities and notices", () => fixture(({ folder, candidate, save }) => {
  const path = join(folder, "evidence/build-manifest.json"), valid = readJson(path);
  for (const patch of [{ minimumMacOS: "13.0" }, { electronVersion: "unknown" }, { lockfileSha256: "partial" }, { execution: { version: 1, sha256: "partial" } }, { runtimeDependencies: ["example", "example"] }, { runtimeDependencies: ["../outside"] }, { dependencies: [] }, { dependencies: [{ name: "example", version: "1.0.0", license: "", source: "https://example.test", integrity: null }] }, { notarized: true }]) { json(path, { ...valid, ...patch }); save(); assert.throws(() => validateCandidate(folder, tag, candidate.commit, candidate.components)); }
}));

test("restaged provenance retains original raw bytes and external declarations bind to final bytes", () => fixture(async ({ root, inputs, folder, candidate, save }) => {
  const raw = readFileSync(join(folder, "candidate.json")), prior = structuredClone(candidate);
  writeFileSync(join(folder, candidate.file), "Synthetic re-signed final bytes"); candidate.sha256 = checksum(join(folder, candidate.file)); candidate.sizeBytes = readFileSync(join(folder, candidate.file)).length;
  writeFileSync(join(folder, "evidence/original-candidate.json"), raw); json(join(folder, "evidence/build-candidate.json"), { candidate: prior, candidateSha256: digest(raw), originalCandidate: "evidence/original-candidate.json", verifiedCandidateSha256: digest(canonical(prior)), assetAndEvidenceVerified: true });
  json(join(folder, "evidence/signing-report.json"), { artifactSha256: candidate.sha256.toUpperCase(), status: "verified" }); candidate.signing = "externally_reported_verified"; candidate.restagedFinalBytes = true; candidate.originalBuildCandidate = "evidence/build-candidate.json"; candidate.signingReport = "evidence/signing-report.json";
  for (const name of ["original-candidate.json", "build-candidate.json", "signing-report.json"]) candidate.evidence[`evidence/${name}`] = ""; save();
  assert.equal(validateCandidate(folder, tag, candidate.commit, candidate.components).signing, "externally_reported_verified");
  await assemble(root, tag, inputs, join(root, ".work/restaged")); assert.deepEqual(readFileSync(join(folder, "evidence/original-candidate.json")), raw);
  for (const patch of [{ signing: "verified" }, { signingReport: "evidence/unbound.json" }, { cleanMachineAcceptance: "externally_reported_passed" }]) { const before = structuredClone(candidate); Object.assign(candidate, patch); save(); assert.throws(() => validateCandidate(folder, tag, prior.commit, prior.components)); Object.assign(candidate, before); }
  writeFileSync(join(folder, "evidence/original-candidate.json"), raw.toString().replace('"signing": "unsigned"', '"signing": "unsigned", "signing": "unsigned"')); save(); assert.throws(() => validateCandidate(folder, tag, prior.commit, prior.components));
}));

test("automated package acceptance requires every native guarantee and prohibits paid/renderer calls", () => {
  const identity = { components: { desktop: "0.2.2" }, architecture: "arm64", sha256: "a".repeat(64) }, valid = accepted(identity); validateAcceptance(valid, identity);
  for (const [key, value] of Object.entries(valid)) { const bad = typeof value === "boolean" ? false : typeof value === "number" ? value + 1 : Array.isArray(value) ? value.slice(1) : "wrong"; if (key === "pdfPages") continue; assert.throws(() => validateAcceptance({ ...valid, [key]: bad }, identity), key); }
  for (const pdfPages of [0, -1, 0.5, null]) assert.throws(() => validateAcceptance({ ...valid, pdfPages }, identity));
});

for (const mutation of ["missing", "failedJUnit", "emptyJUnit", "wrongCount", "skippedJUnit", "lowCoverage", "inconsistentPct", "wrongXML", "wrongLCOV", "duplicateJSON", "DTD", "entity", "malformedXML", "link"])
  test(`embedded AI evidence rejects ${mutation}`, () => fixture(async ({ inputs, root }) => {
    const folder = join(inputs, "embedded-ai-checks"), junit = join(folder, "app/.build/reports/desktop.xml"), summary = join(folder, "coverage/desktop/coverage-summary.json"), xml = join(folder, "coverage/desktop/cobertura-coverage.xml"), lcov = join(folder, "coverage/desktop/lcov.info");
    if (mutation === "missing") rmSync(lcov);
    if (mutation === "failedJUnit") writeFileSync(junit, readFileSync(junit, "utf8").replace('failures="0"', 'failures="1"'));
    if (mutation === "emptyJUnit") writeFileSync(junit, '<testsuites tests="0" failures="0" errors="0"/>');
    if (mutation === "wrongCount") writeFileSync(junit, readFileSync(junit, "utf8").replace('tests="2"', 'tests="1"'));
    if (mutation === "skippedJUnit") writeFileSync(junit, '<testsuites tests="1" failures="0" errors="0"><testcase><skipped/></testcase></testsuites>');
    if (mutation === "lowCoverage") { const value = readJson(summary); value.total.functions = { total: 10, covered: 8, pct: 80 }; json(summary, value); }
    if (mutation === "inconsistentPct") { const value = readJson(summary); value.total.lines.covered = 8; json(summary, value); }
    if (mutation === "wrongXML") writeFileSync(xml, readFileSync(xml, "utf8").replace('lines-valid="10"', 'lines-valid="11"'));
    if (mutation === "wrongLCOV") writeFileSync(lcov, readFileSync(lcov, "utf8").replace("LF:10", "LF:11"));
    if (mutation === "duplicateJSON") writeFileSync(summary, '{"total":{},"total":{}}');
    if (mutation === "DTD") writeFileSync(xml, '<!DOCTYPE coverage SYSTEM "file:///etc/passwd"><coverage/>');
    if (mutation === "entity") writeFileSync(xml, '<!DOCTYPE coverage [<!ENTITY private SYSTEM "file:///etc/passwd">]><coverage>&private;</coverage>');
    if (mutation === "malformedXML") writeFileSync(xml, "<coverage><broken></coverage>");
    if (mutation === "link") { const external = join(root, ".work/external.xml"); copyFileSync(junit, external); rmSync(junit); symlinkSync(external, junit); }
    await assert.rejects(readAiReports(folder));
  }));

test("assembly rejects extra candidates, aliased outputs and unknown template fields", () => fixture(async ({ root, inputs, candidate }) => {
  const extra = join(inputs, "release-extra"); mkdirSync(extra); json(join(extra, "candidate.json"), candidate);
  await assert.rejects(assemble(root, tag, inputs, join(root, ".work/extra")), /Exactly one/); rmSync(extra, { recursive: true });
  await assert.rejects(assemble(root, tag, inputs, join(inputs, "nested-output")), /separate/);
  const alias = join(root, ".work/alias"); symlinkSync(inputs, alias); await assert.rejects(assemble(root, tag, inputs, join(alias, "nested-output")), /separate/);
  writeFileSync(join(root, ".github/RELEASE_TEMPLATE.md"), "Unknown @UNRECOGNIZED@ field"); await assert.rejects(assemble(root, tag, inputs, join(root, ".work/template"))); assert.equal(existsSync(join(root, ".work/template")), false);
}));

test("CLI rejects duplicate/mixed options and preserves existing evidence before running package checks", () => fixture(async ({ root, folder }) => {
  for (const args of [["check", "--tag", tag, "--tag", tag], ["check", "--tag", tag, "--installer", "bad.dmg"], ["check", "--tag", tag, "extra"], ["assemble", "--tag", tag], ["stage", "--tag", tag, "--output", "new"], ["unknown", "--tag", tag]]) await assert.rejects(main(root, args));
  const output = join(root, ".work/existing"); mkdirSync(output); writeFileSync(join(output, "prior.txt"), "preserve");
  await assert.rejects(stage(root, tag, { installer: join(folder, "fake.dmg"), buildCandidate: join(folder, "candidate.json"), output, reports: join(root, ".work/reports") })); assert.equal(readFileSync(join(output, "prior.txt"), "utf8"), "preserve");
  await assert.rejects(main(root, ["check", "--tag", tag], { WORKFLOW_REF: "refs/heads/main" }));
  const existing = join(root, ".work/releases.json"); json(existing, [[{ tag_name: "v0.1.0" }], [{ tag_name: tag }]]); assert.throws(() => checkExisting(existing, tag)); json(existing, [[{ tag_name: "v0.1.0" }]]); checkExisting(existing, tag);
  const outputs = join(root, ".work/outputs"); await main(root, ["check", "--tag", tag], { GITHUB_OUTPUT: outputs, WORKFLOW_REF: `refs/tags/${tag}` }); assert.match(readFileSync(outputs, "utf8"), /sha=[a-f0-9]{40}\nprerelease=false\n/);
}));

test("generated changes remain literal content and invalid UTF-8 cannot publish notes", () => fixture(async ({ root, inputs }) => {
  const changes = join(root, ".work/changes.md"), output = join(root, ".work/notes"); writeFileSync(changes, "Fix literal @TAG@ parsing\n"); await assemble(root, tag, inputs, output, changes); assert.ok(readFileSync(join(output, "RELEASE_NOTES.md"), "utf8").includes("Fix literal @TAG@ parsing\n"));
  writeFileSync(changes, Buffer.from([0xff])); await assert.rejects(assemble(root, tag, inputs, join(root, ".work/invalid-notes"), changes)); assert.equal(existsSync(join(root, ".work/invalid-notes")), false);
}));
