import { expect, it } from "vitest";
import { assembleOcrUnits } from "./ocr-assembly.js";
import type { AssemblyUnit } from "./assembly-finish.js";
import { validateParsedQuestion } from "./question-contract.js";
import type { ArtifactReference, VisualElement } from "../src/contracts.generated.js";

const reference = (page: number): ArtifactReference => ({ objectKey: `source/page-${page}.png`, sha256: "a".repeat(64), mediaType: "image/png", sizeBytes: 1 });
const page = (index: number, text = "Printed prompt?") => ({ page: index, width: 100, height: 100, elements: [{ type: 2, text_info: { content: text } }], figures: [] });
const unit = (index: number, visuals: VisualElement[] = []): AssemblyUnit => ({ index, payload: { parsed: { questions: [validateParsedQuestion({ id: `page:${index + 1}:1`, stem: "Printed prompt?", sourceText: "Printed prompt?", answerMode: "short_answer" })], groups: [] }, visuals } });
const options = (count = 1) => ({ pageRefs: Array.from({ length: count }, (_, index) => reference(index)), failures: [], visualTotal: count, sourceType: "pdf" });
const unchanged = async (visuals: VisualElement[]) => ({ visuals, failures: [], truncated: false, limit: 10 });

it("orders saved pages and remaps figure ownership without changing immutable unit artifacts", async () => {
  const units = [1, 0].map(index => unit(index, [{ kind: "image", description: `Figure ${index}`, page: index, bbox: [0.1, 0.1, 0.8, 0.8], questionIndexes: [0] }])), before = structuredClone(units);
  const output = await assembleOcrUnits(units, [page(0), page(1)], options(2), async visuals => {
    expect(visuals.map(v => v.questionIndexes)).toEqual([[0], [1]]);
    return unchanged(visuals.map(v => ({ ...v, sourceRef: reference(v.page!), imageRef: reference(v.page!) })));
  });
  expect(output.status).toBe("SUCCEEDED"); expect(output.result.visualElements.map(v => v.questionIds)).toEqual([["q0"], ["q1"]]);
  expect(output.processing.questionSources.map(item => item.unitIndex)).toEqual([0, 1]); expect(units).toEqual(before);
});

it("does not use OCR wording as original-text overlap or automatic deduplication proof", async () => {
  const output = await assembleOcrUnits([unit(0), unit(1)], [page(0), page(1)], { ...options(2), deduplicateQuestions: true, originalText: "Printed prompt?" }, unchanged);
  expect(output.result.questions).toHaveLength(2);
  expect(output.result.warnings.join(" ")).toContain("All copies were retained");
});

it("retains an unverified figure as reviewable evidence without inventing an image", async () => {
  const input = unit(0, [{ kind: "image", description: "No trusted coordinates", page: 0, bbox: null, questionIndexes: [0], sourceRef: reference(0) }]);
  const output = await assembleOcrUnits([input], [page(0)], options(), unchanged);
  expect(output).toMatchObject({ status: "PARTIAL", result: { missingFields: ["media"], visualElements: [{ description: "No trusted coordinates", sourceRef: reference(0) }] } });
  expect(output.processing.failures).toContainEqual(expect.objectContaining({ stage: "visual_crop", code: "CROP_UNVERIFIED" }));
  expect(output.result.questions[0].missingFields).toContain("media");
  expect(output.result.visualElements[0].imageRef ?? null).toBeNull();
});

it("retains the full source and partial crop failure when decoding fails", async () => {
  const input = unit(0, [{ kind: "image", description: "Source figure", page: 0, bbox: [0, 0, 1, 1], questionIndexes: [0], sourceRef: reference(0) }]);
  const output = await assembleOcrUnits([input], [page(0)], options(), async visuals => ({ visuals, failures: [{ stage: "visual_crop", index: 0, code: "CROP_PROCESSING_FAILED", retryable: false }], truncated: false, limit: 10 }));
  expect(output.status).toBe("PARTIAL"); expect(output.result.missingFields).toContain("media");
  expect(output.result.visualElements[0]).toMatchObject({ sourceRef: reference(0), questionIds: ["q0"] });
  expect(output.result.questions[0]).toMatchObject({ needsReview: true, missingFields: expect.arrayContaining(["media"]) });
});

it("reports a crop limit explicitly while retaining the extracted questions and figure descriptions", async () => {
  const input = unit(0, [{ kind: "image", description: "Retained description", page: 0, bbox: [0, 0, 1, 1], questionIndexes: [0] }]);
  const output = await assembleOcrUnits([input], [page(0)], options(), async visuals => ({ visuals, failures: [], truncated: true, limit: 1 }));
  expect(output.status).toBe("PARTIAL"); expect(output.result.questions).toHaveLength(1); expect(output.result.visualElements).toHaveLength(1);
  expect(output.result.missingFields).toContain("media"); expect(output.result.warnings.join(" ")).toContain("Figure crop limit of 1 reached");
});

it.each(["image/png", "application/pdf"])("keeps failed-page evidence without treating %s as an arbitrary image", async mediaType => {
  const config = { ...options(2), pageRefs: [reference(0), { ...reference(1), mediaType }], failures: [{ stage: "vision_parse" as const, index: 1, code: "OUTPUT_INVALID", retryable: false }] };
  const output = await assembleOcrUnits([unit(0), { index: 1, payload: null }], [page(0), { page: 1, failed: true }], config, unchanged);
  expect(output).toMatchObject({ status: "PARTIAL", result: { missingFields: ["questions"], questions: [{ stem: "Printed prompt?" }] } });
  const failed = output.result.visualElements.find(v => v.label === "未完成识别的原页")!;
  expect(failed).toBeDefined(); expect(failed.questionIds).toEqual([]);
  expect(failed.sourceRef).toEqual(mediaType === "image/png" ? config.pageRefs[1] : null);
});

it("does not use an answer page across a failed source-page barrier", async () => {
  const input = unit(0); input.payload!.parsed.questions![0].answerPayload = { text: "Printed answer" };
  const pages = [page(0, "17. Printed prompt?"), { page: 1, failed: true as const }, page(2, "Material"), page(3, "Answer key\n17. Printed answer")];
  const output = await assembleOcrUnits([input], pages, options(4), unchanged);
  expect(output.result.questions[0]).toMatchObject({ answerPayload: null, needsReview: true });
  expect(input.payload!.parsed.questions![0].answerPayload).toEqual({ text: "Printed answer" });
});

it("retains PRIMARY extraction when optional context is skipped and exposes that limitation", async () => {
  const input = unit(0); input.payload!.contextSkipped = true;
  const output = await assembleOcrUnits([input], [page(0)], options(), unchanged);
  expect(output.result.questions[0].stem).toBe("Printed prompt?");
  expect(output.result.warnings.join(" ")).toContain("oversized optional context was skipped");
});

it.each([-1, 1])("rejects a unit with no immutable source page before cropping: %s", async index => {
  let cropped = false;
  await expect(assembleOcrUnits([unit(index)], [page(0)], options(), async visuals => { cropped = true; return unchanged(visuals); })).rejects.toMatchObject({ code: "UNIT_RESULT_INVALID" });
  expect(cropped).toBe(false);
});
