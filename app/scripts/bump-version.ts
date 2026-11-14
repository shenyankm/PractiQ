import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, version as releaseVersion, versions } from "./release-data.ts";

export function bumpVersion(root: string, version: string): void {
  releaseVersion(`v${version}`);
  const current = readJson(join(root, "app/package.json")).version; versions(root, `v${current}`);
  if (current === version) return;
  const updates = ["app/package.json", "app/package-lock.json"].map(name => {
    const path = join(root, name), original = readFileSync(path), value = readJson(path);
    value.version = version; if (name.endsWith("package-lock.json")) value.packages[""].version = version;
    return { path, original, updated: JSON.stringify(value, null, 2) + "\n" };
  });
  try { for (const item of updates) writeFileSync(item.path, item.updated); }
  catch (error) { for (const item of updates) writeFileSync(item.path, item.original); throw error; }
  versions(root, `v${version}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error("Pass a complete client version without the v prefix");
  bumpVersion(fileURLToPath(new URL("../../", import.meta.url)), process.argv[2]);
  console.log(`Desktop version synchronized to ${process.argv[2]}`);
}
