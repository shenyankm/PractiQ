import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMMUTABLE_CACHE, REVALIDATE_CACHE, bundleIndex, resolveBundleRequest } from "./protocol-assets.js";

const bundle = () => {
  const root = mkdtempSync(join(tmpdir(), "practiq-protocol-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  writeFileSync(join(root, "assets", "index-abc123.js"), "export {};");
  writeFileSync(join(root, "assets", "katex.woff2"), "font");
  writeFileSync(join(root, "favicon.ico"), "icon");
  writeFileSync(join(root, "notes.unknown"), "bytes");
  return root;
};
const origin = "practiq://app";

it("indexes the built bundle with media types and only content-hashes assets forever", () => {
  const index = bundleIndex(bundle());
  expect([...index.keys()].sort()).toEqual(["/assets/index-abc123.js", "/assets/katex.woff2", "/favicon.ico", "/index.html", "/notes.unknown"]);
  expect(index.get("/index.html")).toMatchObject({ mediaType: "text/html; charset=utf-8", cacheControl: REVALIDATE_CACHE });
  expect(index.get("/assets/index-abc123.js")).toMatchObject({ mediaType: "text/javascript; charset=utf-8", cacheControl: IMMUTABLE_CACHE });
  expect(index.get("/assets/katex.woff2")?.mediaType).toBe("font/woff2");
  expect(index.get("/notes.unknown")?.mediaType).toBe("application/octet-stream");
});

it("serves the index document for the application root and tolerates a cache-busting query", () => {
  const index = bundleIndex(bundle());
  expect(resolveBundleRequest(index, `${origin}/`, origin)?.file.endsWith("index.html")).toBe(true);
  expect(resolveBundleRequest(index, `${origin}/index.html?v=2`, origin)?.file.endsWith("index.html")).toBe(true);
  expect(resolveBundleRequest(index, `${origin}/assets/index-abc123.js`, origin)?.mediaType).toContain("javascript");
});

it("refuses traversal, encoded traversal, foreign origins and unknown files without touching the disk", () => {
  const index = bundleIndex(bundle());
  for (const target of [
    `${origin}/../package.json`, `${origin}/assets/../../package.json`, `${origin}/%2e%2e/package.json`,
    `${origin}/assets/%00index.js`, "https://example.com/index.html", "file:///etc/passwd", "practiq://other/index.html",
    "http://127.0.0.1:1420/", `${origin}/missing.js`, `${origin}/index.html#fragment`, "not a url",
  ]) expect(resolveBundleRequest(index, target, origin)).toBeNull();
  expect(resolveBundleRequest(index, `${origin}/%E0%A4%A`, origin)).toBeNull();
});
