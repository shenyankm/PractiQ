import type { OcrFigureAssociation } from "../src/contracts.generated.js";
import { validateContract } from "./contracts.js";
import { invariant } from "./errors.js";
import { modelDefaults } from "./model-defaults.js";
import { validatePageFigure } from "./page-figures.js";
import { validatePageResult, type ParsedPage } from "./page-results.js";
import { object } from "./question-contract.js";
import { validateSourceFields, type SourceFieldContext } from "./source-fields.js";
import type { TencentFigure } from "./tencent-bundle.js";
import { evidenceText, type TencentPage } from "./tencent-bundle.js";
import { ocrQuestionIssues } from "./ocr-validation.js";
import { ModelOutputError } from "./model.js";

/** The complete PRIMARY inventory owns identity/order/bounds; models only describe associations. */
export function validateOcrPageAssociations(input: unknown, inventory: Pick<TencentFigure, "elementIndex" | "bbox">[], scope: SourceFieldContext, primary?: ParsedPage, page?: Pick<TencentPage, "elements" | "format">): { page: ParsedPage; associations: OcrFigureAssociation[] } {
  const value = object(structuredClone(input)), { figures: raw = [], ...base } = value;
  invariant(input !== null && typeof input === "object" && !Array.isArray(input) && Array.isArray(raw) && raw.length <= 1000, "UNIT_RESULT_INVALID", "Invalid OCR association list");
  invariant(inventory.length <= 1000 && inventory.every(item => Number.isSafeInteger(item.elementIndex) && item.elementIndex >= 0) && new Set(inventory.map(item => item.elementIndex)).size === inventory.length, "UNIT_RESULT_INVALID", "Invalid immutable OCR figure inventory");
  for (const item of inventory) validatePageFigure({ description: "Fixed source figure", bbox: item.bbox });
  const parsed = validateSourceFields(base, scope), associations = raw.map(item => { const candidate = modelDefaults("OcrFigureAssociation", { questionIndexes: [], ...object(item) }); invariant(item !== null && typeof item === "object" && !Array.isArray(item), "UNIT_RESULT_INVALID", "Invalid OCR figure association"); validateContract("OcrFigureAssociation", candidate); return candidate as OcrFigureAssociation; });
  validateContract("OcrPageParseResult", { ...parsed, figures: associations });
  if (page) {
    const formulaText = page.elements.some(element => Object.hasOwn(element, "formula_info")) ? evidenceText(page.elements.map(element => Object.hasOwn(element, "formula_info") ? { ...element, formula_info: `$$${evidenceText(element.formula_info)}$$` } : element)) : "";
    const issues = ocrQuestionIssues(scope.ocr?.text ?? "", parsed.questions, parsed.groups, page.format === "table", evidenceText(associations.map(({ tableRows, extractedText }) => ({ tableRows, extractedText }))), formulaText);
    if (issues.length) throw new ModelOutputError(issues.join("; "));
  }
  const byId = new Map(associations.map(figure => [figure.elementIndex, figure]));
  invariant(associations.length === inventory.length && byId.size === inventory.length && inventory.every(item => byId.has(item.elementIndex)), "UNIT_RESULT_INVALID", "Retain every supplied OCR figure exactly once by elementIndex; never invent figures");
  const ordered = inventory.map(item => byId.get(item.elementIndex)!), figures = ordered.map(({ elementIndex, ...figure }, index) => ({ ...figure, bbox: inventory[index].bbox }));
  return { page: validatePageResult({ ...parsed, figures }, scope, primary, inventory.map(item => item.elementIndex)), associations: ordered };
}
