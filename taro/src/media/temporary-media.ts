export function mediaIdForUrl(url: string, baseUrl: string): number | null {
  const base = baseUrl.trim().replace(/\/$/, "");
  const path = url.startsWith(`${base}/`) ? url.slice(base.length) : url;
  const match = /^\/api\/v1\/media\/([1-9]\d*)\/content$/.exec(path);
  const id = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function validImage(bytes: Uint8Array, mime: string, size: number): boolean {
  if (!size || size > 10 * 1024 * 1024 || bytes.length !== size) return false;
  const starts = (signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  if (mime === "image/png") return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (mime === "image/jpeg") return starts([255, 216, 255]);
  if (mime === "image/gif") return starts([71, 73, 70, 56]) && [55, 57].includes(bytes[4]) && bytes[5] === 97;
  if (mime === "image/webp") return starts([82, 73, 70, 70]) && [87, 69, 66, 80].every((byte, i) => bytes[i + 8] === byte);
  return false;
}

// Only paths returned by our authenticated downloads are ever registered/deleted.
export class TemporaryMedia {
  private revision = 0;
  private readonly paths = new Set<string>();
  constructor(private readonly unlink: (path: string) => void) {}
  generation(): number { return this.revision; }
  accept(path: string, generation: number): boolean {
    if (generation !== this.revision) { this.paths.add(path); this.remove(path); return false; }
    this.paths.add(path);
    return true;
  }
  remove(path: string): void {
    if (!this.paths.has(path)) return;
    try { this.unlink(path); this.paths.delete(path); } catch { console.warn("Temporary media cleanup failed; will retry on next invalidation"); }
  }
  clear(): void { this.revision += 1; for (const path of [...this.paths]) this.remove(path); }
}
