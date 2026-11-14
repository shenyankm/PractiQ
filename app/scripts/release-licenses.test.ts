import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectLicenses } from "./release-licenses.ts";
import { checksum, digest } from "./release-data.ts";

const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
function fixture(action: (root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "practiq-license-test-")));
  try {
    mkdirSync(join(root, "licenses/texts"), { recursive: true }); json(join(root, "licenses/supplemental.json"), {});
    const lock = { "node_modules/example": { version: "1.0.0", resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-test" }, "node_modules/frontend-only": { version: "1.0.0", resolved: "https://registry.npmjs.org/frontend-only/-/frontend-only-1.0.0.tgz", integrity: "sha512-test" } };
    json(join(root, "package-lock.json"), { packages: lock });
    for (const name of ["example", "frontend-only"]) { const directory = join(root, "node_modules", name); mkdirSync(directory, { recursive: true }); json(join(directory, "package.json"), { name, version: "1.0.0", license: "MIT", repository: "https://example.test/source" }); writeFileSync(join(directory, "LICENSE"), `Complete upstream terms for ${name}\n`); }
    action(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("license inventory covers renderer dependencies as well as runtime modules and embeds exact texts", () => fixture(root => {
  const result = collectLicenses(root, "arm64"); assert.equal(result.report.passed, true); assert.deepEqual(result.report.packages.map(item => item.name), ["example", "frontend-only"]);
  for (const item of result.report.packages) for (const text of item.texts) { assert.equal(digest(result.files.get(text.file)!), text.sha256); assert.ok(result.notices.includes(readFileSync(join(root, text.origin), "utf8"))); }
  mkdirSync(join(root, "node_modules/example/node_modules/ignored"), { recursive: true }); writeFileSync(join(root, "node_modules/example/node_modules/ignored/LICENSE"), "Nested licenses cannot supply this parent's missing terms");
  rmSync(join(root, "node_modules/example/LICENSE")); const failed = collectLicenses(root, "arm64"); assert.equal(failed.report.passed, false); assert.deepEqual(failed.report.missingTexts, ["example@1.0.0"]);
}));

test("verified supplemental texts retain provenance and reject drift or unreviewed applicability", () => fixture(root => {
  rmSync(join(root, "node_modules/example/LICENSE")); const text = join(root, "licenses/texts/license.txt"), proof = join(root, "licenses/proof.json"); writeFileSync(text, "Verbatim missing upstream license\n"); json(proof, { source: "https://example.test/commit/license", publishedIntegrity: "sha512-test" });
  const item = { file: "texts/license.txt", sha256: checksum(text), source: "https://example.test/commit/license", verification: "Exact published version and integrity checked", evidence: { file: "proof.json", sha256: checksum(proof) } };
  json(join(root, "licenses/supplemental.json"), { "npm:example@1.0.0": [item] }); const valid = collectLicenses(root, "arm64"); assert.equal(valid.report.passed, true); assert.ok(valid.notices.includes("Verbatim missing upstream license")); assert.ok(valid.notices.includes('"publishedIntegrity"'));
  json(join(root, "licenses/supplemental.json"), { "npm:example@1.0.0": [{ ...item, note: "Source applicability unreviewed" }] }); assert.equal(collectLicenses(root, "arm64").report.passed, false);
  json(join(root, "licenses/supplemental.json"), { "npm:example@1.0.0": [item] }); writeFileSync(proof, "changed proof"); assert.throws(() => collectLicenses(root, "arm64"), /provenance/);
  json(proof, { source: "https://example.test/commit/license", publishedIntegrity: "sha512-test" }); writeFileSync(text, "changed license"); assert.throws(() => collectLicenses(root, "arm64"), /supplemental license/);
}));

test("license selection excludes development and foreign-platform dependencies without hiding required inputs", () => fixture(root => {
  const lockPath = join(root, "package-lock.json"), lock = JSON.parse(readFileSync(lockPath, "utf8")); lock.packages["node_modules/dev-only"] = { dev: true, version: "1.0.0" }; lock.packages["node_modules/foreign"] = { optional: true, version: "1.0.0", os: ["linux"] }; json(lockPath, lock); assert.equal(collectLicenses(root, "arm64").report.passed, true);
  lock.packages["node_modules/foreign"].os = ["darwin"]; json(lockPath, lock); assert.throws(() => collectLicenses(root, "arm64"), /Missing production/);
  delete lock.packages["node_modules/foreign"].optional; lock.packages["node_modules/foreign"].os = ["linux"]; json(lockPath, lock); assert.throws(() => collectLicenses(root, "arm64"), /Missing production/);
}));

test("license reads reject escaping links and empty terms", () => fixture(root => {
  const path = join(root, "node_modules/example/LICENSE"); writeFileSync(path, ""); assert.throws(() => collectLicenses(root, "arm64"), /Empty license/); rmSync(path); symlinkSync("../../frontend-only/LICENSE", path); assert.throws(() => collectLicenses(root, "arm64"));
}));
