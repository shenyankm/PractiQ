import type { ContentBlock, PageFigure, VisualElement } from "../src/contracts.generated.js";
import { modelDefaults } from "./model-defaults.js";
import { isAnswerRole, tableContentKey, tableMarkdown } from "./page-figures.js";
import type { ParsedPage } from "./page-results.js";
import { SourceText, sourceTrim } from "./source-text.js";
import type { UnitPayload } from "./unit-results.js";

/** Share answer roles across equivalent table copies before adding practice blocks. */
export function completePageResult(input: ParsedPage, index: number, verified: number[]): UnitPayload {
  const page = structuredClone(input), { questions, figures } = page, copies = new Map<string, (ContentBlock | PageFigure)[]>(), keysByCopy = new Map<ContentBlock | PageFigure, string[]>(), pending: (ContentBlock | PageFigure)[] = [], markdowns = new Map(figures.filter(figure => figure.kind === "table").map(figure => [figure, tableMarkdown(figure)]));
  const entries: { content: ContentBlock | PageFigure; indexes: number[]; texts: (string | null | undefined)[] }[] = questions.flatMap((question, index) => question.contentBlocks.filter(block => block.partType === "table").map(block => ({ content: block, indexes: [index], texts: [block.markdownValue, block.textValue] })));
  for (const figure of figures) if (figure.kind === "table") { figure.extractedText = markdowns.get(figure) || figure.extractedText; entries.push({ content: figure, indexes: figure.questionIndexes?.length ? [...figure.questionIndexes] : questions.map((_, index) => index), texts: [figure.extractedText] }); }
  for (const { content, indexes, texts } of entries) {
    const textKeys = new Set(texts.filter((text): text is string => Boolean(text)).map(tableContentKey)), keys = [...textKeys].flatMap(key => indexes.map(index => JSON.stringify([index, key]))); keysByCopy.set(content, keys);
    for (const key of keys) copies.set(key, [...copies.get(key) ?? [], content]); if (isAnswerRole(content.role)) pending.push(content);
  }
  while (pending.length) { const content = pending.pop()!; content.role = "answer"; for (const key of keysByCopy.get(content)!) { const linked = copies.get(key) ?? []; copies.delete(key); for (const item of linked) if (item.role !== "answer") { item.role = "answer"; pending.push(item); } } }
  let budget = 1024 * 1024;
  for (const figure of figures) if (figure.kind === "table") {
    const table = markdowns.get(figure), bytes = table ? Buffer.byteLength(JSON.stringify(table)) : 0; if (table) figure.extractedText = table;
    const owners = figure.questionIndexes?.length ? figure.questionIndexes : table ? [] : questions.map((_, index) => index);
    for (const index of owners) {
      const question = questions[index];
      if (table) {
        const existing = question.contentBlocks.find(block => block.partType === "table" && block.markdownValue === table), added = bytes * (Number(!existing) + Number(!(question.sourceText ?? "").includes(table)));
        if (added > budget) { question.needsReview = true; continue; } budget -= added;
        if (existing) { if (figure.role === "answer" || existing.role == null) existing.role = figure.role; }
        else if (question.contentBlocks.length >= 1000) question.needsReview = true;
        else question.contentBlocks.push(modelDefaults("ContentBlock", { partType: "table", role: figure.role, markdownValue: table }) as ContentBlock);
        if (!(question.sourceText ?? "").includes(table)) { const combined = new SourceText(sourceTrim((question.sourceText ?? "") + "\n" + table)); question.sourceText = combined.slice(0, Math.min(120000, combined.length)); question.needsReview ||= combined.length > 120000; }
      } else { question.needsReview = true; question.missingFields = [...new Set([...question.missingFields, "material" as const])]; }
    }
  }
  const proven = new Set(verified), visuals = figures.map((figure, position) => { const { tableRows: _rows, ...content } = figure; return modelDefaults("VisualElement", { ...content, bbox: proven.has(position) ? figure.bbox : null, page: index }) as unknown as VisualElement; });
  return { parsed: { questions, groups: page.groups }, visuals };
}
