import { readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

export interface BundleAsset { file: string; mediaType: string; cacheControl: string }

const MEDIA: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const REVALIDATE_CACHE = "no-cache";

/**
 * Builds the served map once so a request can never choose a filesystem path: unknown names and
 * traversal attempts are rejected by lookup instead of being resolved and canonicalized per request.
 */
export function bundleIndex(root: string): Map<string, BundleAsset> {
  const index = new Map<string, BundleAsset>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) continue;
      const name = `/${relative(root, path).split(sep).join("/")}`;
      // Vite writes content-hashed files under assets/; only those may be cached forever.
      index.set(name, { file: path, mediaType: MEDIA[extname(name).toLowerCase()] ?? "application/octet-stream", cacheControl: name.startsWith("/assets/") ? IMMUTABLE_CACHE : REVALIDATE_CACHE });
    }
  };
  walk(root);
  return index;
}

/** Resolves a renderer request against the built index; a missing or foreign URL never reaches the disk. */
export function resolveBundleRequest(index: Map<string, BundleAsset>, target: string, origin: string): BundleAsset | null {
  let url: URL, expected: URL;
  try { url = new URL(target); expected = new URL(origin); } catch { return null; }
  // A privileged custom scheme has an opaque URL origin, so the scheme and host are compared directly.
  if (url.protocol !== expected.protocol || url.host !== expected.host || url.username || url.password || url.hash) return null;
  let name: string;
  try { name = decodeURIComponent(url.pathname); } catch { return null; }
  if (name === "/") name = "/index.html";
  return index.get(name) ?? null;
}
