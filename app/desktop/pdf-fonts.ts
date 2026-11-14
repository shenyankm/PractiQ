import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { hash } from "./assets.js";
import { invariant } from "./errors.js";

export interface PdfFont { path: string; name: string; size: number; stamp: string }
const stamp = (stat: NonNullable<ReturnType<typeof statSync>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
/** Only trusted OS font roots are visible to PDFium's otherwise in-memory filesystem. */
export function pdfFonts(): { fonts: PdfFont[]; digest: string } {
  invariant(process.platform === "darwin", "PDF_ENGINE_INVALID", "PDF rendering requires the supported macOS desktop");
  const fonts: PdfFont[] = [];
  for (const root of ["/System/Library/Fonts", "/Library/Fonts"]) {
    let entries: Dirent[]; try { entries = readdirSync(root, { recursive: true, withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const entry of entries.sort((a, b) => `${a.parentPath}/${a.name}` < `${b.parentPath}/${b.name}` ? -1 : `${a.parentPath}/${a.name}` > `${b.parentPath}/${b.name}` ? 1 : 0)) {
      if (!/\.(ttf|ttc|otf|otc|dfont)$/i.test(entry.name)) continue;
      try { const path = realpathSync(join(entry.parentPath, entry.name)); if (!["/System/Library/Fonts/", "/Library/Fonts/"].some(root => path.startsWith(root))) continue; const stat = statSync(path); if (stat.isFile() && stat.size > 0 && stat.size <= 256 * 1024 * 1024) fonts.push({ path, name: `${fonts.length}${entry.name.slice(entry.name.lastIndexOf("."))}`, size: stat.size, stamp: stamp(stat) }); } catch { /* Optional OS font assets can be absent. */ }
    }
  }
  invariant(fonts.length > 0 && fonts.length <= 2048, "PDF_FONT_UNAVAILABLE", "Trusted system fonts are unavailable"); return { fonts, digest: hash(JSON.stringify(fonts)) };
}
interface Stream { node: FontNode }
interface FontNode { usedBytes: number; stream_ops: Record<string, unknown> }
export interface PdfFilesystem { createPath(parent: string, path: string, read: boolean, write: boolean): unknown; createDataFile(parent: string, name: string, bytes: Uint8Array, read: boolean, write: boolean, own: boolean): void; lookupPath(path: string): { node: FontNode }; chmod(path: string, mode: number): void; ErrnoError: new (code: number) => Error }
export function mountPdfFonts(fs: PdfFilesystem, fonts: PdfFont[]): () => void {
  const descriptors = new Map<Stream, number>(); fs.createPath("/", "fonts", true, true);
  for (const font of fonts) {
    fs.createDataFile("/fonts", font.name, new Uint8Array(), true, false, true);
    const node = fs.lookupPath(`/fonts/${font.name}`).node; node.usedBytes = font.size;
    node.stream_ops = { ...node.stream_ops,
      read(stream: Stream, buffer: Uint8Array, offset: number, length: number, position: number): number {
        let fd = descriptors.get(stream);
        if (fd === undefined) { fd = openSync(font.path, constants.O_RDONLY | constants.O_NOFOLLOW); try { invariant(stamp(fstatSync(fd)) === font.stamp, "PDF_ENGINE_CHANGED", "System fonts changed during PDF rendering"); } catch (error) { closeSync(fd); throw error; } descriptors.set(stream, fd); }
        return readSync(fd, buffer, offset, Math.min(length, Math.max(0, font.size - position)), position);
      },
      close(stream: Stream) { const fd = descriptors.get(stream); if (fd !== undefined) { descriptors.delete(stream); closeSync(fd); } },
      write() { throw new fs.ErrnoError(69); }, // Emscripten EROFS
      mmap() { throw new fs.ErrnoError(43); }, // Emscripten ENODEV
    };
  }
  fs.chmod("/fonts", 0o555);
  return () => { for (const fd of descriptors.values()) closeSync(fd); descriptors.clear(); };
}
