import sharp from "sharp";
import { invariant } from "./errors.js";

export const MAX_CROPS = 50, MAX_CROP_BYTES = 200 * 1024;
export interface RgbImage { data: Uint8Array; width: number; height: number }
function pixelBounds(image: RgbImage, bbox: number[]): [number, number, number, number] {
  invariant(bbox.length === 4 && bbox.every(value => Number.isFinite(value) && value >= 0 && value <= 1), "CROP_FAILED", "Invalid normalized crop bounds");
  const [left, top, right, bottom] = bbox.map((value, index) => Math.trunc(value * (index % 2 ? image.height : image.width)));
  invariant(0 <= left && left < right && right <= image.width && 0 <= top && top < bottom && bottom <= image.height, "CROP_FAILED", "Crop must have positive area inside its source image"); return [left, top, right, bottom];
}
/** Sampled white-paper guard; faint/detached content still requires human review. */
export function diagramCropHasCutInk(image: RgbImage, bbox: number[]): boolean {
  invariant(image.data.length === image.width * image.height * 3, "CROP_FAILED", "Diagram guard requires RGB pixels");
  const [left, top, right, bottom] = pixelBounds(image, bbox), sx = Math.max(0, left - 2), sy = Math.max(0, top - 2), ex = Math.min(image.width, right + 2), ey = Math.min(image.height, bottom + 2);
  const channel = (x: number, y: number) => { const index = (y * image.width + x) * 3; return Math.min(image.data[index], image.data[index + 1], image.data[index + 2]); };
  let white = 0, total = 0; for (let y = sy; y < ey; y += Math.max(1, Math.floor((ey - sy + 63) / 64))) for (let x = sx; x < ex; x += Math.max(1, Math.floor((ex - sx + 63) / 64))) { total++; if (channel(x, y) >= 245) white++; }
  if (white * 5 < total * 4) return false;
  const ink = (x: number, y: number) => channel(x, y) < 150;
  for (const [inner, outer] of [[left, left - 1], [right - 1, right]]) if (0 <= outer && outer < image.width) for (let y = top; y < bottom; y++) if (ink(inner, y)) for (let yy = Math.max(0, y - 1); yy < Math.min(image.height, y + 2); yy++) if (ink(outer, yy)) return true;
  for (const [inner, outer] of [[top, top - 1], [bottom - 1, bottom]]) if (0 <= outer && outer < image.height) for (let x = left; x < right; x++) if (ink(x, inner)) for (let xx = Math.max(0, x - 1); xx < Math.min(image.width, x + 2); xx++) if (ink(xx, outer)) return true;
  return false;
}

export async function boundedCrop(image: RgbImage, bbox: number[], signal?: AbortSignal): Promise<Buffer | null> {
  signal?.throwIfAborted(); const [left, top, right, bottom] = pixelBounds(image, bbox);
  let raw = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } }).timeout({ seconds: 5 }).extract({ left, top, width: right - left, height: bottom - top }).raw().toBuffer({ resolveWithObject: true });
  for (;;) {
    signal?.throwIfAborted(); const bytes = await sharp(raw.data, { raw: raw.info }).timeout({ seconds: 5 }).jpeg({ quality: 80 }).toBuffer();
    if (bytes.length <= MAX_CROP_BYTES) return bytes;
    if (raw.info.width < 64 || raw.info.height < 64) return null;
    raw = await sharp(raw.data, { raw: raw.info }).timeout({ seconds: 5 }).resize(Math.floor(raw.info.width / 2), Math.floor(raw.info.height / 2), { kernel: "cubic" }).raw().toBuffer({ resolveWithObject: true });
  }
}

/** Decode once and composite on paper before both boundary verification and JPEG encoding. */
export async function checkedCropFigures(bytes: Uint8Array, boxes: number[][], kinds: (string | null)[], signal?: AbortSignal): Promise<{ bytes: Buffer | null; rejected: boolean }[]> {
  invariant(boxes.length === kinds.length && boxes.length <= 1000, "CROP_FAILED", "Each bounded crop requires one kind"); signal?.throwIfAborted();
  const failed = () => boxes.map(() => ({ bytes: null, rejected: false })), image = sharp(bytes, { limitInputPixels: 32000000, failOn: "warning" }).timeout({ seconds: 5 });
  try {
    const info = await image.metadata(), sampleBytes = ({ uchar: 1, char: 1, ushort: 2, short: 2, uint: 4, int: 4, float: 4, double: 8 } as Record<string, number>)[info.depth] ?? 1; invariant(bytes.byteLength <= 50 * 1024 * 1024 && info.width * info.height * info.channels * sampleBytes <= 128 * 1024 * 1024 && (info.pages ?? 1) === 1 && info.width > 0 && info.height > 0 && info.width <= 16384 && info.height <= 16384 && ["png", "jpeg"].includes(info.format), "CROP_FAILED", "Invalid source crop image");
    const decoded = await image.flatten({ background: "white" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true }), rgb = { data: decoded.data, width: decoded.info.width, height: decoded.info.height }, result = [];
    for (const [index, bbox] of boxes.entries()) {
      signal?.throwIfAborted();
      try { const rejected = kinds[index] === "diagram" && diagramCropHasCutInk(rgb, bbox); result.push({ bytes: rejected ? null : await boundedCrop(rgb, bbox, signal), rejected }); }
      catch { signal?.throwIfAborted(); result.push({ bytes: null, rejected: false }); }
    }
    return result;
  } catch { signal?.throwIfAborted(); return failed(); }
  finally { image.destroy(); }
}
