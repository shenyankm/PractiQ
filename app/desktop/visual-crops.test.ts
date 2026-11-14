import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiStorage } from "./ai-storage.js";
import { cropVisuals } from "./visual-crops.js";
import { modelDefaults } from "./model-defaults.js";
import type { VisualElement } from "../src/contracts.generated.js";
import corpus from "../fixtures/tencent/vision-crops.json" with { type: "json" };
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function setup() { const path = mkdtempSync(join(tmpdir(), "practiq-visual-crops-")); paths.push(path); const storage = new AiStorage(path), sourceSha = "a".repeat(64), bytes = Buffer.from(corpus.find(sample => sample.name === "left")!.png, "base64"), reference = await storage.putArtifact(bytes, sourceSha, "page", 0, "image/png"); return { storage, sourceSha, reference, bytes }; }
const visual = (kind = "diagram", extra = {}) => modelDefaults("VisualElement", { kind, page: 0, bbox: [.2, .2, .8, .8], description: "Source figure", questionIndexes: [0], ...extra }) as unknown as VisualElement;
it("retains full source evidence for rejected diagrams and verifies expanded crops instead of trusting subimages", async () => {
  const f = await setup(), input = [visual(), visual("image"), visual("diagram", { imageRef: f.reference, cropBbox: [.1, .1, .9, .9] })], before = structuredClone(input), result = await cropVisuals(f.storage, f.sourceSha, input, new Map([[0, f.reference]]), "pdf");
  expect(result.failures).toEqual([{ stage: "visual_crop", index: 0, code: "CROP_UNVERIFIED", retryable: false }]); expect(result.visuals[0].imageRef).toBeNull(); expect(result.visuals.every(visual => visual.sourceRef?.sha256 === f.reference.sha256)).toBe(true);
  expect(result.visuals[1].imageRef).toBeTruthy(); expect(result.visuals[2].imageRef!.objectKey).not.toBe(f.reference.objectKey); expect(result.visuals[2].description).toBe("[page crop] Source figure"); expect(result.visuals[2].bbox).toEqual(input[2].bbox); expect(result.visuals[2].cropBbox).toEqual(input[2].cropBbox); expect(input).toEqual(before); expect(f.storage.artifact(f.reference)).toEqual(f.bytes);
});
it("preserves the fifty-crop and thousand-visual bounds without losing full-page references", async () => {
  const f = await setup(), result = await cropVisuals(f.storage, f.sourceSha, Array.from({ length: 51 }, () => visual("image")), new Map([[0, f.reference]]), "image");
  expect(result.truncated).toBe(true); expect(result.limit).toBe(50); expect(result.visuals.filter(visual => visual.imageRef)).toHaveLength(50); expect(result.visuals[50]).toMatchObject({ imageRef: null, sourceRef: f.reference }); expect(result.failures).toEqual([]);
  const capped = await cropVisuals(f.storage, f.sourceSha, Array.from({ length: 1001 }, () => visual("image", { imageRef: f.reference })), new Map([[0, f.reference]]), "image"); expect(capped.truncated).toBe(true); expect(capped.visuals).toHaveLength(1000); expect(capped.failures).toEqual([]);
});
it("reports absent full-page pixels for expanded bounds and never recycles a mismatched native subimage", async () => {
  const f = await setup(), result = await cropVisuals(f.storage, f.sourceSha, [visual("image", { imageRef: f.reference, cropBbox: [.1, .1, .9, .9] })], new Map(), "text"); expect(result.visuals[0].imageRef).toBeNull(); expect(result.failures).toEqual([{ stage: "visual_crop", index: 0, code: "CROP_FAILED", retryable: false }]); expect(f.storage.artifact(f.reference)).toEqual(f.bytes);
});
