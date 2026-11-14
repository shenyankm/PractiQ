import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const TAG = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9][0-9]*))?)$/;
export const MODE = "electron-desktop", SCHEMA = 1;
export function object(value: unknown): Record<string, any> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a release metadata object"); return value as Record<string, any>;
}
export function strictJson(raw: string | Buffer): any {
  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw), value = JSON.parse(text);
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]/g)) {
    const token = match[0], current = stack.at(-1);
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && current) current.key = true;
    else if (token.startsWith('"') && current?.key) { const name = JSON.parse(token); assert.ok(!current.keys.has(name), "Duplicate JSON object key"); current.keys.add(name); current.key = false; }
  }
  return value;
}
export function readBytes(path: string, limit = 8 * 1024 * 1024): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); assert.ok(stat.isFile() && stat.size <= limit, "Release JSON must be a bounded regular file"); const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); assert.ok(count > 0, "Release JSON changed while reading"); offset += count; }
    assert.equal(readSync(fd, Buffer.alloc(1)), 0, "Release JSON changed while reading"); return bytes;
  } finally { closeSync(fd); }
}
export function readJson(path: string, limit = 8 * 1024 * 1024): any { return strictJson(readBytes(path, limit)); }
export function checksum(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  try { const stat = fstatSync(fd); assert.ok(stat.isFile(), "Release input must be a regular file"); let remaining = stat.size; while (remaining) { const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null); assert.ok(count > 0, "Release input changed while hashing"); digest.update(buffer.subarray(0, count)); remaining -= count; } assert.equal(readSync(fd, buffer, 0, 1, null), 0, "Release input changed while hashing"); return digest.digest("hex"); } finally { closeSync(fd); }
}
export const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export function normalizedDigest(value: unknown): string { assert.ok(typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/i.test(value), "Expected a complete SHA-256 digest"); return value.toLowerCase(); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function version(tag: string): string { const match = TAG.exec(tag); assert.ok(match && match[0] === tag, "Use vX.Y.Z or vX.Y.Z-{alpha,beta,rc}.N without leading zeroes"); return match[1]; }
export function macosVersions(value: string) { const native = version(`v${value}`).split("-")[0]; return { CFBundleShortVersionString: native, CFBundleVersion: native, PractiQVersion: value }; }
export function versions(root: string, tag: string) {
  const expected = version(tag), packageJson = readJson(join(root, "app/package.json")), lock = readJson(join(root, "app/package-lock.json"));
  assert.deepEqual([packageJson.version, lock.version, lock.packages?.[""]?.version], [expected, expected, expected], "Tag, npm version and lockfile root must match");
  return { desktop: expected };
}
export function command(root: string, executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error; assert.equal(result.status, 0, `${executable} failed: ${result.stderr}`); return result.stdout.trim();
}
export function checkCandidate(root: string, tag: string) {
  const components = versions(root, tag), git = (...args: string[]) => command(root, "git", args), commit = git("rev-parse", "HEAD");
  assert.match(commit, /^[a-f0-9]{40}$/); assert.equal(git("cat-file", "-t", `refs/tags/${tag}`), "tag", "Use an existing annotated candidate tag");
  assert.equal(git("rev-parse", `refs/tags/${tag}^{commit}`), commit, "Checkout must identify the candidate tag");
  git("merge-base", "--is-ancestor", commit, "origin/main"); assert.equal(git("status", "--porcelain", "--untracked-files=all"), "", "Release source must be clean");
  return { tag, commit, components, prerelease: tag.includes("-") };
}
export function containedFile(root: string, name: string): string {
  assert.ok(name && !isAbsolute(name) && !name.includes("\\") && !name.includes("\0") && name.split("/").every(part => part && part !== "." && part !== ".."), "Invalid release evidence path");
  const base = realpathSync(root); assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), "Release directory cannot be a symbolic link");
  const parts = name.split("/"); let path = base;
  parts.forEach((part, index) => { path = join(path, part); const stat = lstatSync(path); assert.ok(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()), "Release input requires real contained files and directories"); }); return path;
}
export function payloadFingerprint(directory: string): string {
  const root = realpathSync(directory), entries: unknown[] = [];
  const walk = (path: string) => { for (const name of readdirSync(path).sort()) {
    const child = join(path, name), stat = lstatSync(child), key = relative(root, child);
    if (stat.isSymbolicLink()) { const target = readlinkSync(child), resolved = realpathSync(child); assert.ok(!isAbsolute(target) && resolved.startsWith(`${root}/`), "Package link must remain relative and inside its payload"); entries.push([key, "link", target]); }
    else if (stat.isDirectory()) { entries.push([key, "directory", stat.mode & 0o777]); walk(child); }
    else { assert.ok(stat.isFile(), "Unsupported package file type"); entries.push([key, stat.mode & 0o777, checksum(child)]); }
  } }; walk(root); return digest(canonical(entries));
}

const machinePath = /(?<![\w:/\\>])(?:("|')(?:[A-Za-z]:[\\/]|\\\\|\/)[^"']*\1|(?:[A-Za-z]:[\\/][^\s"'<>|;]*|\\\\[^\\\s"'<>|;]+\\[^\s"'<>|;]*|\/\/[^/\s"'<>|;]+\/[^\s"'<>|;]*|\/[^/\s"'<>|;]+\/[^\s"'<>|;]*))/g;
export function publicReport(value: unknown, roots: [string, string][] = []): any {
  if (Array.isArray(value)) return value.map(item => publicReport(item, roots));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value), cleaned = entries.map(([key]) => publicReport(key, roots) as string), reserved = new Set(cleaned), unchanged = new Set(entries.filter(([key], index) => key === cleaned[index]).map(([key]) => key)), used = new Set<string>();
    return Object.fromEntries(entries.map(([key, item], index) => { let name = cleaned[index]; if (used.has(name) || key !== name && unchanged.has(name)) { let suffix = 2; while (reserved.has(`${name}#${suffix}`) || used.has(`${name}#${suffix}`)) suffix++; name += `#${suffix}`; } used.add(name); return [name, publicReport(item, roots)]; }));
  }
  if (typeof value !== "string") return value;
  const integrity = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (integrity && Buffer.from(integrity[2], "base64").length === Number(integrity[1].slice(3)) / 8 && Buffer.from(integrity[2], "base64").toString("base64") === integrity[2]) return value;
  let text = value.replace(/(?<![\w:/\\>])(?:("|')file:(?:[/\\]|[A-Za-z]:[\\/])[^"']*\1|file:(?:[/\\]|[A-Za-z]:[\\/])[^\s"'<>|;]*)/gi, (_match, quote) => `${quote ?? ""}<local>${quote ?? ""}`);
  for (const [path, label] of [...roots].sort((a, b) => b[0].length - a[0].length)) text = text.split(resolve(path)).join(label);
  if (isAbsolute(text) || /^[A-Za-z]:[\\/]|^\\\\/.test(text)) return "<local>";
  const scrub = (text: string) => text.replace(machinePath, (_match, quote) => `${quote ?? ""}<local>${quote ?? ""}`);
  let output = "", offset = 0;
  for (const match of text.matchAll(/\b(?:https?|git\+https?):\/\/[^\s"'<>]+/g)) {
    const url = match[0], boundary = url.search(/[?#]/), prefix = boundary < 0 ? url : url.slice(0, boundary), tail = boundary < 0 ? "" : url.slice(boundary);
    output += scrub(text.slice(offset, match.index)) + prefix + scrub(tail); offset = match.index + url.length;
  }
  return output + scrub(text.slice(offset));
}
export function externalSigningStatus(report: unknown, artifact: string): string {
  const value = object(report); assert.equal(normalizedDigest(value.artifactSha256), artifact, "Signing report identifies different final bytes"); assert.ok(["verified", "unsigned", "failed"].includes(value.status)); return `externally_reported_${value.status}`;
}
export function externalAcceptanceStatus(report: unknown, kind: string, identity: Record<string, unknown>): string {
  const value = object(report), required = ["schemaVersion", "kind", "artifactSha256", "tag", "commit", "components", "os", "architecture", "status", "reviewedBy", "verificationResults"], optional = ["verificationCommands", "limitations", "reviewedAt", "osVersion"];
  assert.ok(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), "Invalid acceptance schema");
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, kind); assert.equal(normalizedDigest(value.artifactSha256), identity.sha256);
  for (const key of ["tag", "commit", "components", "os", "architecture"]) assert.deepEqual(value[key], identity[key], "Acceptance identifies different source, platform or artifact");
  for (const key of ["reviewedBy", "reviewedAt", "osVersion"]) if (Object.hasOwn(value, key)) assert.ok(typeof value[key] === "string" && value[key].trim() && value[key].length <= 8192, "Invalid acceptance reviewer metadata");
  for (const key of ["verificationResults", "verificationCommands", "limitations"]) if (Object.hasOwn(value, key)) { const items = value[key]; assert.ok(Array.isArray(items) && items.length <= 128 && (key !== "verificationResults" || items.length > 0) && items.every(item => typeof item === "string" && item.trim() && item.length <= 8192), "Invalid acceptance results"); }
  assert.ok(["passed", "failed"].includes(value.status)); return `externally_reported_${value.status}`;
}
