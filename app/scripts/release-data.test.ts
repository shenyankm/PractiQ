import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCandidate, checksum, containedFile, externalAcceptanceStatus, externalSigningStatus, macosVersions, normalizedDigest, payloadFingerprint, publicReport, readJson, strictJson, version, versions } from "./release-data.ts";
import { bumpVersion } from "./bump-version.ts";

function fixture(action: (root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "practiq-release-data-")));
  try { mkdirSync(join(root, "app")); writeFileSync(join(root, "app/package.json"), JSON.stringify({ name: "practiq", version: "0.2.2", dependencies: { example: "^1.0.0" } })); writeFileSync(join(root, "app/package-lock.json"), JSON.stringify({ version: "0.2.2", packages: { "": { name: "practiq", version: "0.2.2" }, "node_modules/example": { version: "1.0.1", integrity: "unchanged" } } })); action(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
test("shipping Electron version matches the reviewed npm lockfile roots", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)), packageJson = readJson(join(root, "app/package.json")); assert.deepEqual(versions(root, `v${packageJson.version}`), { desktop: packageJson.version });
});
test("version rules preserve exact prereleases and macOS native/full mapping", () => {
  for (const value of ["0.2.2", "1.2.3-alpha.0", "1.2.3-beta.1", "1.2.3-rc.12"]) { assert.equal(version(`v${value}`), value); assert.deepEqual(macosVersions(value), { CFBundleShortVersionString: value.split("-")[0], CFBundleVersion: value.split("-")[0], PractiQVersion: value }); }
  for (const value of ["1.2.3", "v01.2.3", "v1.2.3-rc.01", "v1.2.3-preview.1", "v1.2.3\n", "v1.2.3 ", "v1.2.3+build", "v1.2.3;echo"]) assert.throws(() => version(value), value);
});
test("bumping validates all inputs before writes and never resolves dependency versions", () => fixture(root => {
  for (const value of ["01.2.3", "1.2.3-rc.01", "1.2.3\n"]) { const before = readFileSync(join(root, "app/package.json")); assert.throws(() => bumpVersion(root, value)); assert.deepEqual(readFileSync(join(root, "app/package.json")), before); }
  bumpVersion(root, "0.3.0-rc.2"); assert.deepEqual(versions(root, "v0.3.0-rc.2"), { desktop: "0.3.0-rc.2" });
  assert.deepEqual(readJson(join(root, "app/package.json")).dependencies, { example: "^1.0.0" });
  assert.deepEqual(readJson(join(root, "app/package-lock.json")).packages["node_modules/example"], { version: "1.0.1", integrity: "unchanged" });
  const before = readFileSync(join(root, "app/package.json")), lock = readJson(join(root, "app/package-lock.json")); lock.packages[""].version = "0.0.0"; writeFileSync(join(root, "app/package-lock.json"), JSON.stringify(lock));
  assert.throws(() => bumpVersion(root, "0.4.0")); assert.deepEqual(readFileSync(join(root, "app/package.json")), before);
}));
test("candidate requires an annotated tag, clean checkout and main ancestry", () => fixture(root => {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Release test", "-c", "user.email=release@example.test", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", `core.hooksPath=${join(root, "no-hooks")}`, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet"); git("add", "."); git("commit", "-qm", "Candidate"); git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("tag", "v0.2.2"); assert.throws(() => checkCandidate(root, "v0.2.2")); git("tag", "-d", "v0.2.2"); git("tag", "-a", "v0.2.2", "-m", "Candidate");
  const candidate = checkCandidate(root, "v0.2.2"); assert.equal(candidate.commit, git("rev-parse", "HEAD")); assert.equal(candidate.prerelease, false);
  writeFileSync(join(root, "untracked"), "private\n"); assert.throws(() => checkCandidate(root, "v0.2.2")); rmSync(join(root, "untracked"));
  const unrelated = git("commit-tree", git("write-tree"), "-m", "Unrelated root"); git("update-ref", "refs/remotes/origin/main", unrelated); assert.throws(() => checkCandidate(root, "v0.2.2"));
}));
test("strict JSON rejects ambiguous nested keys and invalid UTF-8", () => {
  for (const value of ['{"a":1,"a":2}', '{"nested":[{"a":1,"\\u0061":2}]}', '{"a":{"x":1,"x":2}}']) assert.throws(() => strictJson(value), /Duplicate/);
  assert.deepEqual(strictJson('{"a":"{\\\"a\\\":1}","b":[{"a":1},{"a":2}]}'), { a: '{"a":1}', b: [{ a: 1 }, { a: 2 }] });
  assert.throws(() => strictJson(Buffer.from([0xff]))); assert.throws(() => strictJson('{"a":undefined}'));
});
test("evidence rejects links and escapes, and payload fingerprints detect content and mode changes", () => fixture(root => {
  const evidence = join(root, "evidence"); mkdirSync(evidence); const file = join(evidence, "report.json"); writeFileSync(file, "{}");
  assert.equal(containedFile(root, "evidence/report.json"), file); assert.match(checksum(file), /^[a-f0-9]{64}$/);
  for (const value of ["../outside", "/absolute", "evidence//report.json", "evidence/./report.json", "evidence\\report.json"]) assert.throws(() => containedFile(root, value));
  const first = payloadFingerprint(evidence); chmodSync(file, 0o400); assert.notEqual(payloadFingerprint(evidence), first); chmodSync(file, 0o600); const mode = payloadFingerprint(evidence); writeFileSync(file, "{\"changed\":true}"); assert.notEqual(payloadFingerprint(evidence), mode);
  symlinkSync("report.json", join(evidence, "link")); assert.throws(() => containedFile(evidence, "link")); const linked = payloadFingerprint(evidence); assert.ok(linked);
  symlinkSync(join(root, "app/package.json"), join(evidence, "outside")); assert.throws(() => payloadFingerprint(evidence));
  assert.throws(() => readJson(join(evidence, "link"))); assert.throws(() => readJson(file, 1));
}));
test("public diagnostics redact local paths in values, keys, file URIs and URL query paths without collisions", () => {
  const value = publicReport({ "/Users/private/a": "open '/Users/private/name with spaces/file.json'", "/Users/private/b": "https://example.test/page?source=/Users/private/file", "<local>": "reserved", "<local>#2": "reserved suffix", raw: "file:///Users/private/file.json", windows: "C:\\Users\\private\\app.db", share: "\\\\host\\private\\file" });
  assert.equal(Object.keys(value).length, 7); assert.equal(value["<local>"], "reserved"); assert.equal(value["<local>#2"], "reserved suffix");
  assert.ok(!JSON.stringify(value).includes("private")); assert.ok(JSON.stringify(value).includes("https://example.test/page?source="));
});
test("external signing and acceptance remain declarations bound to exact final bytes", () => {
  const identity = { tag: "v0.2.2", commit: "a".repeat(40), components: { desktop: "0.2.2" }, os: "macos", architecture: "arm64", sha256: "b".repeat(64) };
  const report = { schemaVersion: 1, kind: "clean-machine", artifactSha256: identity.sha256, tag: identity.tag, commit: identity.commit, components: identity.components, os: identity.os, architecture: identity.architecture, status: "passed", reviewedBy: "Reviewer", verificationResults: ["Installed and restored"] };
  assert.equal(externalSigningStatus({ artifactSha256: identity.sha256, status: "verified" }, identity.sha256), "externally_reported_verified");
  assert.equal(externalAcceptanceStatus(report, "clean-machine", identity), "externally_reported_passed");
  for (const patch of [{ commit: "c".repeat(40) }, { artifactSha256: "c".repeat(64) }, { architecture: "x64" }, { status: "verified" }, { verificationResults: [] }, { reviewedBy: " " }, { unexpected: true }, { schemaVersion: true }]) assert.throws(() => externalAcceptanceStatus({ ...report, ...patch }, "clean-machine", identity));
  assert.throws(() => externalSigningStatus({ artifactSha256: "c".repeat(64), status: "verified" }, identity.sha256));
});

test("public diagnostics preserve canonical npm integrity hashes containing path-shaped Base64", () => {
  const fragment = "+/Users/private/path", base64 = "a".repeat(32) + fragment + "a".repeat(85 - 32 - fragment.length) + "A==", integrity = `sha512-${base64}`;
  assert.equal(Buffer.from(base64, "base64").length, 64); assert.equal(Buffer.from(base64, "base64").toString("base64"), base64);
  assert.equal(publicReport(integrity), integrity); assert.notEqual(publicReport("sha512-/Users/private/path"), "sha512-/Users/private/path");
});

test("public diagnostics preserve npm tarball URL namespaces while redacting local query and fragment paths", () => {
  const url = "https://registry.npmjs.org/@img/sharp-libvips-darwin-arm64/-/sharp-libvips-darwin-arm64-1.3.4.tgz#package/README.md";
  assert.equal(publicReport(url), url); assert.equal(publicReport(`Source: ${url}`), `Source: ${url}`);
  for (const suffix of ["?source=/Users/private/file", "#source=/Users/private/file"]) assert.equal(publicReport(`https://example.test/-/license${suffix}`), `https://example.test/-/license${suffix.split("=")[0]}=<local>`);
});

test("complete SHA-256 inputs reject trailing whitespace and incomplete digests", () => {
  for (const value of ["a".repeat(63), "g".repeat(64), "a".repeat(64) + "\n", "a".repeat(64) + " ", null]) assert.throws(() => normalizedDigest(value)); assert.equal(normalizedDigest("A".repeat(64)), "a".repeat(64));
});
