import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { optionalOtherPlatform } from "./package-audit.ts";
import { checksum, containedFile, digest, readBytes, readJson } from "./release-data.ts";

export function collectLicenses(app: string, architecture = process.arch) {
  const lock = readJson(join(app, "package-lock.json")).packages, supplemental = readJson(join(app, "licenses/supplemental.json")), files = new Map<string, Buffer>(), packages: Record<string, any>[] = [];
  const addText = (path: string) => { const data = readBytes(path, 2 * 1024 * 1024); new TextDecoder("utf-8", { fatal: true }).decode(data); assert.ok(data.length > 0, "Empty license text"); const sha256 = digest(data), file = `${sha256}.txt`; files.set(file, data); return { file, sha256 }; };
  for (const name of Object.keys(lock).filter(name => name && !lock[name].dev).sort()) {
    const locked = lock[name], directory = join(app, name);
    if (!existsSync(join(directory, "package.json"))) { assert.ok(optionalOtherPlatform(locked, architecture), `Missing production dependency: ${name}`); continue; }
    const metadata = readJson(containedFile(app, `${name}/package.json`)); assert.equal(metadata.version, locked.version); assert.equal(metadata.name, name.split("node_modules/").at(-1));
    const texts: { file: string; sha256: string; origin: string }[] = [];
    const scan = (directory: string, licenseDirectory = false) => {
      for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (["node_modules", ".git", "target"].includes(item.name)) continue; const path = join(directory, item.name), license = licenseDirectory || /^(?:licen[cs]e|copying|notice|copyright)/i.test(item.name);
        if (item.isDirectory()) scan(path, license); else if (license) { assert.ok(texts.length < 256, "Too many license files"); texts.push({ ...addText(containedFile(app, relative(app, path))), origin: relative(app, path) }); }
      }
    }; scan(directory);
    const supplements = supplemental[`npm:${metadata.name}@${metadata.version}`] ?? [];
    for (const item of supplements) {
      assert.ok(typeof item.source === "string" && /^https:\/\//.test(item.source), "Supplemental license requires an upstream source");
      const path = containedFile(join(app, "licenses"), item.file); assert.equal(checksum(path), item.sha256, "Altered supplemental license"); texts.push({ ...addText(path), origin: `licenses/${item.file}` });
      if (item.evidence) { const proof = containedFile(join(app, "licenses"), item.evidence.file); assert.equal(checksum(proof), item.evidence.sha256, "Altered license provenance"); texts.push({ ...addText(proof), origin: `licenses/${item.evidence.file}` }); }
    }
    const source = typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url ?? metadata.homepage ?? locked.resolved;
    packages.push({ name: metadata.name, version: metadata.version, declaration: metadata.license ?? "see retained upstream terms", source, integrity: locked.integrity ?? null, supplementalSources: supplements, texts });
  }
  assert.ok(packages.length > 0); const missingTexts = packages.filter(item => !item.texts.length).map(item => `${item.name}@${item.version}`), unverifiedSources = packages.filter(item => item.supplementalSources.some((source: Record<string, any>) => source.note)).map(item => `${item.name}@${item.version}`);
  const report = { version: 1, scope: "Installed macOS npm production closure, including bundled renderer and embedded AI workers; human redistribution-obligations review remains required", architecture, passed: missingTexts.length === 0 && unverifiedSources.length === 0, missingTexts, unverifiedSources, packages };
  const notices = ["Source-bound production dependency license texts", report.scope];
  for (const item of packages) {
    notices.push(`\n=== ${item.name}@${item.version} ===`, `Declaration: ${typeof item.declaration === "string" ? item.declaration : JSON.stringify(item.declaration)}`, `Source: ${item.source}`);
    for (const source of item.supplementalSources) notices.push(`Supplemental source: ${source.source}`, `Verification: ${source.verification ?? "Source and text hashes retained"}`);
    for (const text of item.texts) notices.push(`\n--- ${text.origin} (SHA-256 ${text.sha256}) ---`, files.get(text.file)!.toString("utf8"));
  }
  return { report, files, notices: notices.join("\n") + "\n" };
}
