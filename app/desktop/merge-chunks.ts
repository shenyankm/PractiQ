import type { DocumentQualityIssue, DocumentQuestionSource, ParsedGroup, Question } from "../src/contracts.generated.js";
import { invariant } from "./errors.js";
import { parsedQuestionDefaults } from "./model-defaults.js";
import { canonical } from "./questions.js";
import type { ChunkSpan } from "./source-chunks.js";
import { SourceText, sourceSpace, sourceWithoutWhitespace } from "./source-text.js";

export interface MergeSource { questionIndex: number; stage: DocumentQuestionSource["stage"]; unitIndex: number }
export interface MergeIssue { questionIndex: number; code: DocumentQualityIssue["code"] }
export interface MergeQuality { reviewRequired: boolean; reviewQuestionCount: number; issues: MergeIssue[] }
export interface MergeUnit { index: number; questions: Question[]; groups: ParsedGroup[] }
export interface MergeResult { questions: Question[]; groups: ParsedGroup[]; warnings: string[]; truncated: boolean; sources: MergeSource[]; quality: MergeQuality }
type Location = [number, number];
interface NormalizedSource { text: string; positions: number[]; source: SourceText }
export function normalizedSource(source: SourceText, span: ChunkSpan): NormalizedSource {
  const chars: string[] = [], positions: number[] = []; let index = span.start;
  for (const char of source.slice(span.start, span.end)) { if (!sourceSpace(char)) { positions.push(index); chars.push(char); } index++; }
  const text = chars.join(""); return { text, positions, source: new SourceText(text) };
}
export function locations(source: NormalizedSource, quote: string | null | undefined): Location[] {
  const needle = sourceWithoutWhitespace(quote ?? ""), result: Location[] = []; if (!needle) return result;
  let offset = source.text.indexOf(needle);
  while (offset >= 0 && result.length < 2) {
    const begin = source.source.point(offset), end = source.source.point(offset + needle.length);
    result.push([source.positions[begin], source.positions[end - 1] + 1]); offset = source.text.indexOf(needle, offset + 1);
  } return result;
}
const locationKey = (value: Location | null): string => value ? value.join(":") : "unlocated";
function content(question: Question): string {
  const value = parsedQuestionDefaults(question);
  for (const key of ["confidence", "needsReview", "missingFields", "sourceText", "id"]) delete value[key];
  if (question.questionTypeId === question.answerMode || question.questionTypeId === question.questionKind) value.questionTypeId = null;
  return canonical(value);
}
function groupLocation(source: NormalizedSource, group: ParsedGroup): Location | null {
  const matches = [group.title, group.instructions].filter(Boolean).map(quote => locations(source, quote));
  return matches.every(values => values.length === 1) ? [Math.min(...matches.map(values => values[0][0])), Math.max(...matches.map(values => values[0][1]))] : null;
}

/** Only unique, equal content at the same proven source overlap may collapse. */
export function mergeChunks(units: MergeUnit[], options: { overlapping?: boolean; sourceText?: string | null; spans?: ChunkSpan[] | null } = {}): MergeResult {
  const overlapping = options.overlapping ?? true, sourceText = options.sourceText === undefined || options.sourceText === null ? null : new SourceText(options.sourceText);
  const questions: Question[] = [], groups: ParsedGroup[] = [], warnings: string[] = [], sources: MergeSource[] = [], issues = new Map<string, MergeIssue>();
  const issue = (index: number, code: MergeIssue["code"]) => { issues.set(`${index}:${code}`, { questionIndex: index, code }); };
  type Entry = { index: number; location: Location | null; content: string };
  let previous: Entry[] = [], previousIndex: number | null = null, previousGroups: { index: number; location: Location | null }[] = [];
  for (const unit of units) {
    invariant(Number.isSafeInteger(unit.index) && unit.index >= 0, "UNIT_RESULT_INVALID", "Invalid merge unit index");
    const span = options.spans?.[unit.index];
    invariant(!options.spans || span && [span.start, span.end, span.overlapStart, span.overlapEnd].every(value => Number.isSafeInteger(value) && value >= 0) && span.start <= span.end && span.overlapStart <= span.overlapEnd && (!sourceText || span.end <= sourceText.length), "CHUNK_INPUTS_INVALID", "Invalid source span for merge");
    const source = sourceText && span ? normalizedSource(sourceText, span) : null, adjacent = previousIndex !== null && unit.index === previousIndex + 1;
    const indexMap = new Map<number, number>(), current: Entry[] = [], usedPrevious = new Set<number>(), byLocation = new Map<string, Entry[]>();
    for (const entry of previous) { const key = locationKey(entry.location), entries = byLocation.get(key) ?? []; entries.push(entry); byLocation.set(key, entries); }
    for (const [localIndex, original] of unit.questions.entries()) {
      const question = structuredClone(original), found = source ? locations(source, question.sourceText) : [], location = found.length === 1 ? found[0] : null, comparison = overlapping ? content(question) : "", codes = new Set<MergeIssue["code"]>(), candidates: number[] = [];
      if (overlapping && !found.length) codes.add("SOURCE_TEXT_NOT_FOUND"); if (overlapping && found.length > 1) codes.add("AMBIGUOUS_OVERLAP");
      if (overlapping && adjacent && span && span.overlapEnd > span.overlapStart) {
        const prior = location ? [...byLocation.get(locationKey(location)) ?? [], ...byLocation.get("unlocated") ?? []] : previous;
        for (const entry of prior) {
          if (location && locationKey(entry.location) === locationKey(location) && span.overlapStart <= location[0] && location[0] < location[1] && location[1] <= span.overlapEnd) {
            if (entry.content === comparison) candidates.push(entry.index); else { codes.add("OVERLAP_CONFLICT"); issue(entry.index, "OVERLAP_CONFLICT"); }
          } else if ((!location || !entry.location) && entry.content === comparison) { codes.add("AMBIGUOUS_OVERLAP"); issue(entry.index, "AMBIGUOUS_OVERLAP"); }
        }
      }
      let finalIndex: number;
      if (candidates.length === 1 && !usedPrevious.has(candidates[0]) && !codes.size) {
        finalIndex = candidates[0]; usedPrevious.add(finalIndex); const target = questions[finalIndex];
        target.needsReview ||= question.needsReview; target.missingFields = [...new Set([...target.missingFields, ...question.missingFields])]; target.confidence = Math.min(target.confidence, question.confidence);
      } else {
        if (candidates.length) { codes.add("AMBIGUOUS_OVERLAP"); candidates.forEach(index => issue(index, "AMBIGUOUS_OVERLAP")); }
        finalIndex = questions.length; questions.push(question);
      }
      indexMap.set(localIndex, finalIndex); current.push({ index: finalIndex, location, content: comparison }); codes.forEach(code => issue(finalIndex, code)); sources.push({ questionIndex: finalIndex, stage: overlapping ? "document_parse" : "vision_parse", unitIndex: unit.index });
    }
    const currentGroups: typeof previousGroups = [];
    for (const original of unit.groups) {
      const remapped = [...new Set(original.questionIndexes.flatMap(index => indexMap.has(index) ? [indexMap.get(index)!] : []))].sort((a, b) => a - b), location = overlapping && source ? groupLocation(source, original) : null;
      if (!remapped.length && original.questionIndexes.length) continue;
      const matches = previousGroups.filter(prior => adjacent && groups[prior.index].title === original.title && (groups[prior.index].instructions ?? null) === (original.instructions ?? null) && (remapped.some(index => usedPrevious.has(index) && groups[prior.index].questionIndexes.includes(index)) || overlapping && span && location && locationKey(location) === locationKey(prior.location) && (!remapped.length || !groups[prior.index].questionIndexes.length) && span.overlapStart <= location[0] && location[0] < location[1] && location[1] <= span.overlapEnd));
      let index: number;
      if (matches.length === 1) { index = matches[0].index; groups[index].questionIndexes = [...new Set([...groups[index].questionIndexes, ...remapped])].sort((a, b) => a - b); }
      else { index = groups.length; groups.push({ ...structuredClone(original), questionIndexes: remapped }); }
      currentGroups.push({ index, location });
    }
    previousGroups = currentGroups; previousIndex = unit.index; previous = current;
  }
  let truncated = questions.length > 1000;
  if (truncated) {
    const byId = new Map(questions.filter(question => question.id).map(question => [question.id!, question]));
    const roots = questions.map((original, index) => { let question = original; const seen = new Set<string>(); while (question.parentId && byId.has(question.parentId) && !seen.has(question.parentId)) { seen.add(question.parentId); question = byId.get(question.parentId)!; } return question.id || `unidentified:${index}`; });
    const later = new Set(roots.slice(1000)), cutoff = roots.slice(0, 1000).findIndex(root => later.has(root)), keep = cutoff < 0 ? 1000 : cutoff;
    warnings.push(`Parsed ${questions.length} nodes; retained ${keep} nodes without splitting a question group.`); questions.length = keep;
    const retained = groups.filter(group => !group.questionIndexes.length || group.questionIndexes.some(index => index < keep)).map(group => ({ ...group, questionIndexes: group.questionIndexes.filter(index => index < keep) })); groups.splice(0, groups.length, ...retained);
  }
  if (groups.length > 1000) { warnings.push(`Merged ${groups.length} groups; only the first 1000 were kept.`); groups.length = 1000; truncated = true; }
  for (const item of issues.values()) if (item.questionIndex < questions.length) questions[item.questionIndex].needsReview = true;
  for (const [index, question] of questions.entries()) { if (question.missingFields.length) issue(index, "MISSING_FIELDS"); else if (question.needsReview) issue(index, "NEEDS_REVIEW"); }
  const reviewQuestionCount = questions.filter(question => question.needsReview).length;
  return { questions, groups, warnings, truncated, sources: [...new Map(sources.filter(item => item.questionIndex < questions.length).map(item => [`${item.questionIndex}:${item.stage}:${item.unitIndex}`, item])).values()], quality: { reviewRequired: reviewQuestionCount > 0, reviewQuestionCount, issues: [...issues.values()].filter(item => item.questionIndex < questions.length).sort((a, b) => a.questionIndex - b.questionIndex || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)) } };
}
