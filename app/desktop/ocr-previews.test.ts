import { afterEach, expect, it } from "vitest";
import sharp from "sharp";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiStorage } from "./ai-storage.js";
import { MAX_OCR_PREVIEW_BYTES, ocrPreviews } from "./ocr-previews.js";
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() { const path = mkdtempSync(join(tmpdir(), "practiq-ocr-previews-")); paths.push(path); return new AiStorage(path); }
it("preserves small native image bytes, fixed labels and inventory order with a fifty-preview cap", async () => {
  const storage = setup(), bytes = await sharp({ create: { width: 24, height: 24, channels: 4, background: "transparent" } }).png().toBuffer(), imageRef = await storage.putArtifact(bytes, "a".repeat(64), "native-image", 0, "image/png");
  const figures = Array.from({ length: 51 }, (_, index) => ({ elementIndex: 100 - index, bbox: null, imageMember: null, kind: "image" as const, imageRef })), images = await ocrPreviews(storage, { page: 0, elements: [], figures });
  expect(images).toHaveLength(50); expect(images.every(image => Buffer.from(image.bytes).equals(bytes) && image.mediaType === "image/png")).toBe(true); expect(images[0].label).toContain("elementIndex=100."); expect(images[49].label).toContain("elementIndex=51."); expect(storage.artifact(imageRef)).toEqual(bytes);
});
// Include cold worker startup and compression; each image operation remains bounded.
it("bounds oversized provider previews and leaves source bytes intact", async () => {
  const storage = setup(), pixels = Buffer.alloc(1024 * 1024 * 3); let state = 12345; for (let index = 0; index < pixels.length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; pixels[index] = state & 255; }
  const bytes = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer(), imageRef = await storage.putArtifact(bytes, "a".repeat(64), "native-image", 0, "image/png"), result = await ocrPreviews(storage, { page: 0, elements: [], figures: [{ elementIndex: 7, kind: "image", bbox: null, imageMember: null, imageRef }] });
  expect(bytes.length).toBeGreaterThan(MAX_OCR_PREVIEW_BYTES); expect(result[0].bytes.length).toBeLessThanOrEqual(MAX_OCR_PREVIEW_BYTES); expect(result[0].mediaType).toBe("image/jpeg"); const info = await sharp(result[0].bytes).metadata(); expect(info.width).toBeLessThan(1024); expect(info.width).toBeGreaterThan(0); expect(storage.artifact(imageRef)).toEqual(bytes);
}, 15000);
it("does not invent crops for unavailable images or failed pages", async () => {
  const storage = setup(); expect(await ocrPreviews(storage, { page: 0, failed: true })).toEqual([]); expect(await ocrPreviews(storage, { page: 0, elements: [], figures: [{ elementIndex: 0, kind: "image", imageMember: null, bbox: [0, 0, 1, 1] }] })).toEqual([]);
});
it("honors cancellation before preview work", async () => {
  const controller = new AbortController(); controller.abort(); await expect(ocrPreviews(setup(), { page: 0, elements: [], figures: [] }, controller.signal)).rejects.toThrow();
});
