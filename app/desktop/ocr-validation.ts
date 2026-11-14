import type { ParsedGroup, Question } from "../src/contracts.generated.js";
import { sourceAnswerRecords } from "./answer-evidence.js";
import { sourceExerciseStarts } from "./source-chunks.js";
import { sourceAnswerHeading, sourceNumbers } from "./source-context.js";
import { sourceLines, sourceTrim, sourceWithoutWhitespace } from "./source-text.js";
import { evidenceText } from "./tencent-bundle.js";
import { missingFormulas, renderedText } from "./unit-results.js";

const counts = (values: (string | null)[]) => { const result = new Map<string | null, number>(); for (const value of values) result.set(value, (result.get(value) ?? 0) + 1); return result; };
function formulaSource(text: string, questions: Question[]): [string, string] {
  if (!text) return ["", ""];
  const heading = sourceAnswerHeading.exec(text), body = heading ? text.slice(0, heading.index) : text, numbers = new Set(questions.filter(question => question.id).map(question => question.id!.split(":").at(-1)!)), first = [...body.matchAll(sourceNumbers())].find(match => numbers.has(match[1]))?.index, starts = first === undefined ? [] : [first];
  if (!starts.includes(0)) for (const question of questions) if (question.stem) { const position = body.indexOf(question.stem); if (position >= 0 && body.indexOf(question.stem, position + 1) < 0) starts.push(position); }
  const start = starts.length ? Math.min(...starts) : body.length, source = body.slice(start), prefix = body.slice(0, start);
  if (!heading) return [source, prefix];
  const occurrences = counts([...source.matchAll(sourceNumbers())].map(match => match[1])), answers = sourceAnswerRecords(text.slice(heading.index + heading[0].length)), answerCounts = counts(answers.map(([number]) => number));
  return [[source, ...answers.filter(([number]) => number !== null && numbers.has(number) && occurrences.get(number) === 1 && answerCounts.get(number) === 1).map(([, body]) => body)].join("\n"), prefix];
}

/** Compare immutable reading order and literal math; ambiguity remains human review. */
export function ocrQuestionIssues(text: string, questions: Question[], groups: ParsedGroup[], nativeTable = false, figures = "", formulaText = ""): string[] {
  const issues: string[] = [], heading = sourceAnswerHeading.exec(text), source = heading ? text.slice(0, heading.index) : text;
  const material = questions.map(({ options, passage, items }) => evidenceText({ options, passage, items })).join("\n") + "\n" + questions.flatMap(question => question.contentBlocks.filter(block => ["material", "source_text", "starter_text"].includes(block.role ?? "")).map(evidence => evidenceText(evidence))).join("\n");
  const starts = nativeTable ? [] : [...source.matchAll(sourceNumbers())], occurrences = counts(starts.map(match => match[1])), stems = questions.map(question => sourceWithoutWhitespace(question.stem ?? "")), rendered = questions.map(renderedText), shared = figures + "\n" + evidenceText(groups.map(({ title, instructions }) => ({ title, instructions }))), positions = new Map<number, number>(), byNumber = new Map<string, number[]>();
  questions.forEach((question, index) => { if (question.id) { const number = question.id.split(":").at(-1)!; byNumber.set(number, [...byNumber.get(number) ?? [], index]); } });
  for (const [offset, match] of starts.entries()) {
    const record = sourceTrim(source.slice(match.index + match[0].length, starts[offset + 1]?.index ?? source.length)), firstLine = record ? sourceLines(record)[0] : "";
    // shortcut: untyped statements need human review, extend only with proven source boundaries.
    if (material.includes(firstLine)) continue;
    const anchors = occurrences.get(match[1]) === 1 ? byNumber.get(match[1]) ?? [] : [], line = sourceWithoutWhitespace(firstLine), owners = anchors.length ? anchors : stems.flatMap((stem, index) => stem && line.includes(stem) ? [index] : []), exercise = sourceExerciseStarts().exec(firstLine);
    if (!firstLine || !(/[?？]|_{2,}/u.test(firstLine) || exercise?.index === 0)) { if (owners.length !== 1) for (const question of questions) question.needsReview = true; else if (!positions.has(owners[0])) positions.set(owners[0], match.index); continue; }
    if (!owners.length) issues.push(`Retain source question ${match[1]}: ${[...firstLine].slice(0, 200).join("")}`);
    else if (owners.length === 1) { const index = owners[0]; if (positions.has(index)) issues.push(`Retain source question ${match[1]} as a separate record; repeated questions must not collapse`); positions.set(index, match.index); if (missingFormulas(record, rendered[index] + shared).length) issues.push(`Retain every source formula for question ${match[1]} in displayed content, not only sourceText`); }
  }
  questions.forEach((question, index) => { if (!positions.has(index) && question.stem) { const position = source.indexOf(question.stem); if (position >= 0 && source.indexOf(question.stem, position + 1) < 0) positions.set(index, position); } });
  const ordered = [...positions].sort(([a], [b]) => a - b).map(([, position]) => position); if (ordered.some((position, index) => index > 0 && position < ordered[index - 1])) issues.push("Retain source reading order for questions; remap groups and figure indexes after correction");
  const displayed = rendered.join(" ") + shared, sources = [text, formulaText].map(evidence => formulaSource(evidence, questions));
  if (questions.length && sources.some(([source]) => missingFormulas(source, displayed).length)) issues.push("Retain every source formula in displayed content, not only sourceText");
  if (sources.some(([, prefix]) => missingFormulas(prefix, displayed).length)) for (const question of questions) question.needsReview = true;
  return issues;
}
