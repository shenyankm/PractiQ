export type MediaKind = 'image' | 'video';

export const MAX_IMAGE_DIMENSION = 8_192;
export const MAX_IMAGE_PIXELS = 24_000_000;

export function assertImageDimensions(width: number, height: number) {
  if (
    !Number.isFinite(width) || !Number.isFinite(height) ||
    width < 1 || height < 1 ||
    width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) throw new Error('图片尺寸过大，请缩小到 2400 万像素以内');
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

/** Identifies the bounded raster/video formats the native renderers can open. */
export function sniffMediaKind(bytes: Uint8Array): MediaKind | null {
  if (bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG'
    || bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    || ascii(bytes, 0, 6) === 'GIF87a'
    || ascii(bytes, 0, 6) === 'GIF89a'
    || ascii(bytes, 0, 2) === 'BM'
    || ascii(bytes, 0, 4) === 'II*\0'
    || ascii(bytes, 0, 4) === 'MM\0*'
  ) return 'image';

  if (ascii(bytes, 0, 4) === 'RIFF') {
    if (ascii(bytes, 8, 4) === 'WEBP') return 'image';
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).toLocaleLowerCase('en-US');
    if (['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
      return 'image';
    }
    if (['isom', 'iso2', 'mp41', 'mp42', 'm4v ', 'qt  ', 'avc1'].includes(brand)) return 'video';
  }
  return null;
}
