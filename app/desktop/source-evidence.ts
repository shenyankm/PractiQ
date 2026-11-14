import type { Question } from "../src/contracts.generated.js";
import { invariant } from "./errors.js";
import { locations, normalizedSource, type MergeSource } from "./merge-chunks.js";
import { sourceParentPattern, sourceTypedMarkers, tableFrames, typedFrames, type ChunkSpan } from "./source-chunks.js";
import { SourceText, SOURCE_WHITESPACE, sourceLines, sourceTrim } from "./source-text.js";

export interface SourceEvidence { canonical_quote: unknown; full_source: unknown }
export interface EvidenceUnit { start: number; end: number; sourceType: string; sourceIndex?: number; tabularRowsSafe?: boolean }
const blankRefs = () => /\[blank:([^\]]+)\]/gu;
const stripLeft = (value: string) => value.replace(new RegExp(`^${SOURCE_WHITESPACE}+`, "u"), "");
const stripRight = (value: string) => value.replace(new RegExp(`${SOURCE_WHITESPACE}+$`, "u"), "");
const rawRecord = (source: SourceText, start: number, end: number) => source.slice(start, end).replace(/[\r\n]+$/u, "");

function materialReferences(raw: string, header: string | null): string[] {
  const text = header !== null ? [header.split("\t").includes("material") ? raw.split("\t")[header.split("\t").indexOf("material")] : ""] : sourceLines(raw).filter(line => stripLeft(line).startsWith("Material: "));
  return text.flatMap(line => [...line.matchAll(blankRefs())].map(match => match[1]));
}
function canonicalParts(raw: string, positions: Map<string, number>, header: string | null, start = 0, end = new SourceText(raw).length): unknown[] {
  const source = new SourceText(raw), slots: [number, number, string, number][] = [];
  const add = (left: number, right: number, kind: string, id: string) => { const target = kind === "root_task" ? 0 : positions.get(id); invariant(target !== undefined, "OUTPUT_INVALID", "Unproven source identity"); slots.push([source.point(left), source.point(right), kind, target]); };
  if (header !== null) {
    const columns = header.split("\t"), cells = raw.split("\t"); invariant(columns.length === cells.length, "OUTPUT_INVALID", "Source table changed"); let offset = 0;
    for (const [index, cell] of cells.entries()) { const column = columns[index];
      if (["id", "root_task", "parent_id", "option_owner"].includes(column) && /^[1-9]\p{Nd}{0,8}$/u.test(cell)) add(offset, offset + cell.length, column, cell);
      if (column === "material") for (const match of cell.matchAll(blankRefs())) add(offset + match.index + 7, offset + match.index + match[0].length - 1, "blank", match[1]);
      offset += cell.length + 1;
    }
  } else {
    const own = sourceTypedMarkers().exec(raw); invariant(own?.index === 0, "OUTPUT_INVALID", "Unproven source heading");
    const ownStart = own[0].indexOf(own[1]); add(ownStart, ownStart + own[1].length, "id", own[1]); let offset = 0;
    for (const line of sourceLines(raw, true)) {
      const stripped = sourceTrim(line), parent = new RegExp(`^${sourceParentPattern}$`, "du").exec(stripped);
      if (parent?.[0].length === stripped.length) { const leading = line.length - stripLeft(line).length;
        for (const [group, kind] of [[1, "parent_id"], [2, "option_owner"]] as const) if (parent[group]) { const [left, right] = parent.indices![group]!; add(offset + leading + left, offset + leading + right, kind, parent[group]); }
      }
      if (stripLeft(line).startsWith("Material: ")) for (const match of line.matchAll(blankRefs())) add(offset + match.index + 7, offset + match.index + match[0].length - 1, "blank", match[1]);
      offset += line.length;
    }
  }
  const parts: unknown[] = []; let cursor = start;
  for (const [left, right, kind, target] of slots.sort((a, b) => a[0] - b[0] || a[1] - b[1])) if (start <= left && right <= end) { parts.push(source.slice(cursor, left), { reference: kind, target }); cursor = right; }
  parts.push(source.slice(cursor, end)); return parts;
}

/** Only a complete source/model tree bijection may normalize printed identities. */
export function buildSourceEvidence(sourceText: string | null, questions: Question[], sources: MergeSource[], spans: ChunkSpan[] | null, options: { textUnits?: EvidenceUnit[] | null; sourceType?: string; tabularRowsSafe?: boolean; complete?: boolean } = {}): Record<string, SourceEvidence | null> {
  if (options.complete === false || sourceText === null || !spans?.length) return {};
  const source = new SourceText(sourceText), layouts = [];
  for (const unit of options.textUnits?.length ? options.textUnits : [{ start: 0, end: source.length, sourceType: options.sourceType ?? "text", tabularRowsSafe: options.tabularRowsSafe }]) {
    const text = source.slice(unit.start, unit.end), table = unit.tabularRowsSafe ? tableFrames(text) : null, layout = table ?? (unit.sourceType !== "csv" ? typedFrames(text) : null);
    if (!layout) continue; const roots = new Map<string, string>(), trees = new Map<string, Set<string>>();
    for (const frame of layout.frames) { const root = frame.parent ? roots.get(frame.parent)! : frame.id; roots.set(frame.id, root); const members = trees.get(root) ?? new Set(); members.add(frame.id); trees.set(root, members); }
    layouts.push({ unit, text: new SourceText(text), ...layout, trees, starts: layout.frames.map(frame => unit.start + frame.contentStart) });
  }
  if (!layouts.length) return {};
  const result: Record<string, SourceEvidence | null> = Object.create(null), matches = new Map<number, [number, number, number, number]>(), chunks = new Map<number, ReturnType<typeof normalizedSource>>(), bySource = new Map<number, Set<number>>();
  for (const entry of sources) if (entry.stage === "document_parse") { const units = bySource.get(entry.questionIndex) ?? new Set(); units.add(entry.unitIndex); bySource.set(entry.questionIndex, units); }
  for (const [index, question] of questions.entries()) {
    if (question.id == null) continue; const units = bySource.get(index) ?? new Set(), possible: [number, ChunkSpan][] = [];
    for (const [layoutIndex, { unit }] of layouts.entries()) for (const unitIndex of units) { const span = spans[unitIndex]; if (unitIndex >= 0 && span && unit.start <= span.start && span.start < span.end && span.end <= unit.end) possible.push([layoutIndex, span]); }
    if (!possible.length) continue; result[question.id] = null;
    if (units.size !== 1 || possible.length !== 1) continue;
    const [layoutIndex, span] = possible[0], layout = layouts[layoutIndex]; if (!layout.scoped) continue;
    const unitIndex = [...units][0]; if (!chunks.has(unitIndex)) chunks.set(unitIndex, normalizedSource(source, span));
    const found = locations(chunks.get(unitIndex)!, question.sourceText); if (found.length !== 1) continue; const [left, right] = found[0];
    let low = 0, high = layout.starts.length; while (low < high) { const middle = (low + high) >>> 1; if (layout.starts[middle] <= left) low = middle + 1; else high = middle; }
    const frameIndex = low - 1; if (frameIndex < 0) continue; const frame = layout.frames[frameIndex], ownStart = layout.starts[frameIndex], frameEnd = layout.unit.start + frame.end;
    const raw = rawRecord(layout.text, frame.contentStart, frame.end), firstLine = raw.split("\n", 1)[0], anchor = layout.header === null ? sourceTypedMarkers().exec(firstLine) : null;
    const ownOffset = new SourceText(firstLine).length - new SourceText(stripLeft(firstLine)).length, hasStem = anchor ? Boolean(sourceTrim(firstLine.slice(anchor[0].length))) : layout.header ? layout.header.split("\t").includes("stem") && Boolean(raw.split("\t")[layout.header.split("\t").indexOf("stem")]) : false;
    const requiredEnd = ownStart + new SourceText(stripRight(layout.header === null ? firstLine : raw)).length;
    if (hasStem && left === ownStart + ownOffset && right >= requiredEnd && span.start <= ownStart && frameEnd <= span.end && right <= ownStart + new SourceText(raw).length) matches.set(index, [layoutIndex, frameIndex, left - ownStart, right - ownStart]);
  }
  const claims = new Map<string, number[]>(); for (const [index, [layout, frame]] of matches) { const key = `${layout}:${frame}`; claims.set(key, [...claims.get(key) ?? [], index]); }
  for (const indexes of claims.values()) if (indexes.length > 1) for (const index of indexes) matches.delete(index);
  const byId = new Map(questions.map((question, index) => [question.id, index])), trees = new Map<number, number[]>();
  for (const [index] of questions.entries()) { let root = index; const seen = new Set<number>(); while (questions[root].parentId) { const next = byId.get(questions[root].parentId); if (seen.has(root) || next === undefined) return result; seen.add(root); root = next; } trees.set(root, [...trees.get(root) ?? [], index]); }
  for (const indexes of trees.values()) {
    if (!indexes.every(index => matches.has(index))) continue; const layoutIds = new Set(indexes.map(index => matches.get(index)![0])); if (layoutIds.size !== 1) continue;
    const layout = layouts[[...layoutIds][0]], selected = indexes.map(index => layout.frames[matches.get(index)![1]]), physical = new Map(selected.map((frame, local) => [frame.id, local]));
    if (physical.size !== indexes.length || selected[0].parent) continue; const expected = layout.trees.get(selected[0].id)!;
    if (physical.size !== expected.size || [...physical.keys()].some(id => !expected.has(id))) continue;
    const ids = new Map(indexes.map((index, local) => [questions[index].id, local])), proven: Record<string, SourceEvidence> = Object.create(null); let complete = true;
    for (const [local, index] of indexes.entries()) {
      const frame = selected[local], question = questions[index], raw = rawRecord(layout.text, frame.contentStart, frame.end), refs = materialReferences(raw, layout.header), sourceRefs = refs.map(ref => physical.get(ref)), modelRefs = (question.passage ?? []).filter(block => block.questionId).map(block => ids.get(block.questionId));
      if (physical.get(frame.parent) !== ids.get(question.parentId) || physical.get(frame.owner) !== ids.get(question.optionSourceId) || sourceRefs.length !== modelRefs.length || sourceRefs.some((ref, i) => ref !== modelRefs[i])) { complete = false; break; }
      const [, , left, right] = matches.get(index)!;
      proven[question.id!] = { canonical_quote: canonicalParts(raw, physical, layout.header, left, right), full_source: { context: layout.header ?? layout.text.slice(0, layout.frames[0].contentStart), record: canonicalParts(raw, physical, layout.header) } };
    }
    if (complete) Object.assign(result, proven);
  }
  return result;
}
