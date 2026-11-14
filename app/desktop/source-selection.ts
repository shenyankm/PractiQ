import type { FailedUnit } from "../src/contracts.generated.js";
import type { DocumentRecord } from "./document-tasks.js";
import { invariant } from "./errors.js";

/** Retain original page/tile/fragment ordinals while limiting explicit model work. */
export function sourceIndexes(task: DocumentRecord, stage: "document_parse" | "vision_parse", total: number, parts: { sourcePage?: number }[] = []): number[] {
  const indexes = Array.from({ length: total }, (_, index) => index), pages = task.input.pages;
  let available = indexes;
  if (pages !== null && pages !== undefined) {
    invariant(stage === "vision_parse", "SOURCE_SELECTION_INVALID", "Page selection requires paginated recognition evidence");
    const original = indexes.map(index => parts[index]?.sourcePage ?? index), requested = new Set(pages);
    invariant(pages.every(page => Number.isSafeInteger(page) && page >= 1 && original.includes(page - 1)), "SOURCE_SELECTION_INVALID", "Selected pages are outside the retained source");
    available = indexes.filter(index => requested.has(original[index] + 1));
  }
  const selection = task.input.reparseSelection;
  if (!selection) return available;
  invariant(selection.units.length > 0 && selection.units.every(unit => unit.stage === stage && Number.isSafeInteger(unit.index) && available.includes(unit.index)), "SOURCE_SELECTION_INVALID", "Selected source units are unavailable");
  const selected = new Set(selection.units.map((unit: FailedUnit) => unit.index)); return available.filter(index => selected.has(index));
}

export const PAGE_SELECTION_WARNING = "Only selected original pages are structured. Tencent document recognition may process the complete file; review material outside the selection.";
export const REPARSE_WARNING = "Explicit source-unit reparse reuses verified Tencent evidence; original results are preserved.";
