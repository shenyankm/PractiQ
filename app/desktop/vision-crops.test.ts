import { expect, it } from "vitest";
import sharp from "sharp";
import { checkedCropFigures, MAX_CROP_BYTES } from "./vision-crops.js";
import corpus from "../fixtures/tencent/vision-crops.json" with { type: "json" };
it.each(corpus)("preserves real source crop calibration and failure positions: $name", async sample => {
  const bytes = Buffer.from(sample.png, "base64"), before = Buffer.from(bytes), actual = await checkedCropFigures(bytes, sample.boxes, sample.kinds);
  expect(actual.map(result => ({ rejected: result.rejected, hasBytes: result.bytes !== null }))).toEqual(sample.expected.map(result => ({ rejected: result.rejected, hasBytes: result.hasBytes })));
  for (const [index, crop] of actual.entries()) if (crop.bytes) { expect(crop.bytes.length).toBeLessThanOrEqual(MAX_CROP_BYTES); const info = await sharp(crop.bytes).metadata(); expect([info.width, info.height]).toEqual(sample.expected[index].size); }
  expect(bytes).toEqual(before);
});
it("retains an invalid image's failure positions and honors cancellation", async () => {
  expect(await checkedCropFigures(Buffer.from("invalid image"), [[0, 0, 1, 1]], ["diagram"])).toEqual([{ bytes: null, rejected: false }]);
  const controller = new AbortController(); controller.abort(); await expect(checkedCropFigures(Buffer.from("invalid"), [[0, 0, 1, 1]], [null], controller.signal)).rejects.toThrow();
});
