import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { audioInfo, validateImage, validateSegment } from "./media.js";

it.skipIf(process.platform !== "darwin").each(["wav", "aac", "m4a"])("fully decodes the existing %s listening fixture with macOS CoreAudio", async extension => {
  const bytes = readFileSync(new URL(`../fixtures/resources/audio/chimes.${extension}`, import.meta.url));
  const audio = await audioInfo(bytes);
  expect(audio.media).toBe(extension === "m4a" ? "audio/mp4" : extension === "wav" ? "audio/wav" : "audio/aac");
  expect(audio.duration).toBeGreaterThan(2.9); expect(audio.duration).toBeLessThan(3.3);
  expect(() => validateSegment({ audioStartSeconds: 0, audioEndSeconds: 3 }, audio.duration)).not.toThrow();
  expect(() => validateSegment({ audioStartSeconds: audio.duration }, audio.duration)).toThrow("exceeds");
});

it("decodes image pixels, verifies MIME and enforces legacy dimensions", async () => {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
  await expect(validateImage(bytes, "image/png")).resolves.toBeUndefined();
  await expect(validateImage(bytes, "image/jpeg")).rejects.toThrow("Invalid image");
  await expect(validateImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/png")).rejects.toThrow("signature");
  await expect(validateImage(bytes.subarray(0, 40), "image/png")).rejects.toThrow("decoding failed");
  const oversized = await sharp({ create: { width: 16385, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  await expect(validateImage(oversized, "image/png")).rejects.toThrow("dimensions");
});

it.skipIf(process.platform !== "darwin")("rejects invalid audio rather than accepting a filename or MIME hint", async () => {
  await expect(audioInfo(Buffer.from("not an audio stream"))).rejects.toThrow();
});
