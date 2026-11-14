import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { imageInputs, type ImageInputs } from "./image-inputs.js";

const signal = () => new AbortController().signal;
const limits = { inputBytes: 700, maxParts: 100, maxBytes: 50 * 1024 * 1024 };
function noise(size: number) { const data = Buffer.alloc(size); let seed = 7; for (let index = 0; index < size; index++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; data[index] = seed & 255; } return data; }
async function reconstruct(result: ImageInputs, channels: 3 | 4) {
  const output = Buffer.alloc(result.width * result.height * channels), seen = new Uint8Array(result.width * result.height);
  for (const part of result.parts) {
    const [left, top, right, bottom] = part.bounds, decoded = channels === 4 ? sharp(part.bytes).ensureAlpha() : sharp(part.bytes).removeAlpha(), data = await decoded.raw().toBuffer();
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { expect(seen[y * result.width + x]++).toBe(0); const from = ((y - top) * (right - left) + x - left) * channels, to = (y * result.width + x) * channels; data.copy(output, to, from, from + channels); }
  }
  expect([...seen].every(value => value === 1)).toBe(true); return output;
}
describe("lossless source-image preparation", () => {
  it.each([3, 4] as const)("reconstructs every %i-channel pixel with deterministic bounds and no overlap", async channels => {
    const pixels = noise(40 * 40 * channels), source = await sharp(pixels, { raw: { width: 40, height: 40, channels } }).png().toBuffer(), before = Buffer.from(source), result = await imageInputs(source, signal(), limits);
    expect(result.parts.length).toBeGreaterThan(1); expect(result.parts.every(part => part.bytes.length <= 700 && part.mediaType === "image/png")).toBe(true);
    expect(await reconstruct(result, channels)).toEqual(pixels); expect(source).toEqual(before);
    expect(await imageInputs(source, signal(), limits)).toEqual(result);
    await expect(imageInputs(source, signal(), { ...limits, maxParts: 1 })).rejects.toMatchObject({ code: "TENCENT_SOURCE_TOO_LARGE" });
    await expect(imageInputs(source, signal(), { ...limits, maxBytes: 700 })).rejects.toMatchObject({ code: "TENCENT_SOURCE_TOO_LARGE" });
  });
  it.each(["png", "jpeg"] as const)("keeps bounded %s bytes immutable after full validation", async format => {
    const source = await sharp(noise(12 * 12 * 3), { raw: { width: 12, height: 12, channels: 3 } })[format]().toBuffer(), result = await imageInputs(source, signal(), { ...limits, inputBytes: source.length });
    expect(result).toEqual({ width: 12, height: 12, parts: [{ bytes: source, mediaType: `image/${format}`, bounds: [0, 0, 12, 12] }] }); expect(result.parts[0].bytes).toBe(source);
  });
  it("matches the historical Pillow CMYK conversion pixel for pixel", async () => {
    const source = readFileSync(new URL("../fixtures/images/cmyk.jpg", import.meta.url)), expected = await sharp(readFileSync(new URL("../fixtures/images/cmyk-rgb.png", import.meta.url))).raw().toBuffer(), result = await imageInputs(source, signal(), limits);
    expect(result.parts.length).toBeGreaterThan(1); expect(await reconstruct(result, 3)).toEqual(expected);
    await expect(imageInputs(readFileSync(new URL("../fixtures/images/cmyk-invalid-icc.jpg", import.meta.url)), signal(), limits)).rejects.toMatchObject({ code: "IMAGE_FORMAT_UNSUPPORTED" });
  });
  it("preserves full 16-bit grayscale samples when tiling", async () => {
    const source = readFileSync(new URL("../fixtures/images/gray16.png", import.meta.url)), result = await imageInputs(source, signal(), limits), expected = await sharp(source).toColourspace("grey16").raw({ depth: "ushort" }).toBuffer(), restored = Buffer.alloc(expected.length);
    expect(result.parts.length).toBeGreaterThan(1);
    for (const part of result.parts) { expect((await sharp(part.bytes).metadata()).depth).toBe("ushort"); const [left, top, right, bottom] = part.bounds, data = await sharp(part.bytes).toColourspace("grey16").raw({ depth: "ushort" }).toBuffer(); for (let y = top; y < bottom; y++) data.copy(restored, (y * result.width + left) * 2, (y - top) * (right - left) * 2, (y - top + 1) * (right - left) * 2); }
    expect(restored).toEqual(expected);
  });
  it("rejects corrupt scans, CRC corruption, unsupported formats and multi-frame PNGs", async () => {
    const jpeg = readFileSync(new URL("../fixtures/tencent/image.jpg", import.meta.url)), png = await sharp({ create: { width: 12, height: 12, channels: 3, background: "red" } }).png().toBuffer(), corrupt = Buffer.from(png); corrupt[corrupt.length - 1] ^= 1;
    for (const source of [jpeg.subarray(0, Math.floor(jpeg.length * .7)), png.subarray(0, png.length - 10), corrupt, Buffer.from("unsupported")]) await expect(imageInputs(source, signal(), limits)).rejects.toMatchObject({ code: "IMAGE_FORMAT_UNSUPPORTED" });
    for (const name of ["multi-frame.png", "default-frame.png", "multi-picture.mpo"]) await expect(imageInputs(readFileSync(new URL(`../fixtures/tencent/${name}`, import.meta.url)), signal(), limits)).rejects.toMatchObject({ code: "IMAGE_MULTIFRAME_UNSUPPORTED" });
  });
  it("rejects oversized dimensions and cancellation without publishing a partial plan", async () => {
    const source = await sharp({ create: { width: 16385, height: 1, channels: 3, background: "red" } }).png().toBuffer(); await expect(imageInputs(source, signal(), limits)).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
    const stop = new AbortController(); stop.abort(new Error("stopped")); await expect(imageInputs(source, stop.signal, limits)).rejects.toThrow("stopped");
    const active = new AbortController(), valid = await sharp(noise(200 * 200 * 4), { raw: { width: 200, height: 200, channels: 4 } }).png().toBuffer(), work = imageInputs(valid, active.signal, limits); active.abort(new Error("active stop")); await expect(work).rejects.toThrow("active stop");
  });
});
