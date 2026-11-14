import sharp from "sharp";
import { AppError, invariant } from "./errors.js";
import { verifySourceJpeg, verifySourcePng } from "./tencent-bundle.js";

export type PixelBounds = [number, number, number, number];
export interface ImagePart { bytes: Buffer; mediaType: "image/png" | "image/jpeg"; bounds: PixelBounds }
export interface ImageInputs { width: number; height: number; parts: ImagePart[] }
export interface ImageInputLimits { inputBytes: number; maxParts: number; maxBytes: number }

/** Fully decode before paid work, then split in deterministic top/left order without resizing. */
export async function imageInputs(bytes: Buffer, signal: AbortSignal, limits: ImageInputLimits): Promise<ImageInputs> {
  signal.throwIfAborted();
  invariant(bytes.length > 0 && bytes.length <= 150 * 1024 * 1024 && Number.isSafeInteger(limits.inputBytes) && limits.inputBytes >= 4 && limits.inputBytes <= 150 * 1024 * 1024 && Number.isSafeInteger(limits.maxParts) && limits.maxParts > 0 && limits.maxParts <= 300 && Number.isSafeInteger(limits.maxBytes) && limits.maxBytes > 0 && limits.maxBytes <= 50 * 1024 * 1024, "TENCENT_SOURCE_TOO_LARGE", "Invalid image input limits");
  const mediaType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg" : null;
  invariant(mediaType, "IMAGE_FORMAT_UNSUPPORTED", "Only PNG and JPEG source images are supported");
  const decoder = sharp(bytes, { limitInputPixels: false, failOn: "warning", ignoreIcc: true }).timeout({ seconds: 5 });
  let normalized: ReturnType<typeof sharp> | undefined;
  try {
    const metadata = await decoder.metadata(), width = metadata.width ?? 0, height = metadata.height ?? 0;
    invariant(metadata.format === (mediaType === "image/png" ? "png" : "jpeg"), "IMAGE_FORMAT_UNSUPPORTED", "Source image format differs from its signature");
    invariant(width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 25_000_000 && width * height * metadata.channels * (metadata.depth === "ushort" ? 2 : 1) <= 200_000_000, "IMAGE_TOO_LARGE", "Source image exceeds dimension or pixel limits");
    invariant((metadata.pages ?? 1) === 1, "IMAGE_MULTIFRAME_UNSUPPORTED", "Multi-frame source images are not supported");
    if (mediaType === "image/png") verifySourcePng(bytes); else verifySourceJpeg(bytes);
    // stats decodes the complete scan even when the immutable original can be submitted directly.
    await decoder.stats(); signal.throwIfAborted();
    if (bytes.length <= limits.inputBytes) { invariant(bytes.length <= limits.maxBytes, "TENCENT_SOURCE_TOO_LARGE", "Source image exceeds the shared visual byte limit"); return { width, height, parts: [{ bytes, mediaType, bounds: [0, 0, width, height] }] }; }
    if (metadata.space === "cmyk") {
      if (metadata.icc) {
        invariant(metadata.icc.length >= 128 && metadata.icc.readUInt32BE(0) >= 128 && metadata.icc.readUInt32BE(0) <= metadata.icc.length && metadata.icc.subarray(36, 40).toString() === "acsp", "IMAGE_FORMAT_UNSUPPORTED", "CMYK color profile is invalid");
        const converted = await sharp(bytes, { limitInputPixels: 25_000_000, failOn: "warning" }).timeout({ seconds: 5 }).withIccProfile("srgb").png().toBuffer();
        normalized = sharp(converted, { limitInputPixels: 25_000_000, failOn: "warning" });
      } else {
        const data = await decoder.clone().pipelineColourspace("cmyk").toColourspace("cmyk").raw().toBuffer(), rgb = Buffer.alloc(width * height * 3);
        for (let pixel = 0; pixel < width * height; pixel++) for (let channel = 0; channel < 3; channel++) rgb[pixel * 3 + channel] = Math.floor(((255 - data[pixel * 4 + channel]) * (255 - data[pixel * 4 + 3]) + 127) / 255);
        normalized = sharp(rgb, { raw: { width, height, channels: 3 } });
      }
    } else normalized = decoder.clone().keepIccProfile().toColourspace(metadata.depth === "ushort" ? metadata.channels < 3 ? "grey16" : "rgb16" : metadata.space === "b-w" ? "b-w" : "srgb");
    const pending: PixelBounds[] = [[0, 0, width, height]], parts: ImagePart[] = []; let total = 0;
    while (pending.length) {
      signal.throwIfAborted(); const bounds = pending.pop()!, [left, top, right, bottom] = bounds;
      const tile = normalized.clone().timeout({ seconds: 5 }); let data: Buffer;
      try { data = await tile.extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer(); } finally { tile.destroy(); }
      signal.throwIfAborted();
      if (data.length <= limits.inputBytes) { total += data.length; invariant(total <= limits.maxBytes, "TENCENT_SOURCE_TOO_LARGE", "Image tiles exceed the shared visual byte limit"); parts.push({ bytes: data, mediaType: "image/png", bounds }); }
      else if (bottom - top >= right - left && bottom - top > 1) { const middle = Math.floor((top + bottom) / 2); pending.push([left, middle, right, bottom], [left, top, right, middle]); }
      else if (right - left > 1) { const middle = Math.floor((left + right) / 2); pending.push([middle, top, right, bottom], [left, top, middle, bottom]); }
      else throw new AppError("TENCENT_SOURCE_TOO_LARGE", "An image pixel exceeds the input limit");
      invariant(parts.length + pending.length <= limits.maxParts, "TENCENT_SOURCE_TOO_LARGE", "Image exceeds the split-part limit");
    }
    return { width, height, parts };
  } catch (error) { if (signal.aborted) throw signal.reason; if (error instanceof AppError && ["IMAGE_TOO_LARGE", "IMAGE_MULTIFRAME_UNSUPPORTED", "TENCENT_SOURCE_TOO_LARGE", "IMAGE_FORMAT_UNSUPPORTED"].includes(error.code)) throw error; throw new AppError("IMAGE_FORMAT_UNSUPPORTED", "Source image scan or color conversion is invalid"); }
  finally { normalized?.destroy(); decoder.destroy(); }
}
