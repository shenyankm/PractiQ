import { hash } from "./assets.js";
import { validateContract } from "./contracts.js";
import { invariant } from "./errors.js";
import { object } from "./question-contract.js";
import { SourceText, SOURCE_WHITESPACE, sourceLines, sourceSpace, sourceTrim } from "./source-text.js";
import { parseSourceJson } from "./source-json.js";
import { sourceCasefold } from "./source-casefold.js";

export const CHUNK_TARGET_CHARS = 30_000, CHUNK_MAX_CHARS = 40_000, CHUNK_TARGET_NODES = 16;
export interface ChunkSpan { start: number; end: number; overlapStart: number; overlapEnd: number }
export interface SourcePresenceHint { need_stem: boolean; need_options: boolean; need_analysis: boolean; stem_sha256?: string; need_answer?: boolean; answer_source?: string }
export interface ChunkSourceOptions { sourceType?: string; tabularRowsSafe?: boolean; complete?: boolean }
export interface ChunkPlan { spans: ChunkSpan[]; header: string | null; nodeCounts: (number | null)[] }
interface Frame { start: number; contentStart: number; end: number; id: string; parent: string; owner: string; refs: Set<string>; group: string; kind: string }
type Block = [number, number, number];
interface Frames { frames: Frame[]; blocks: Block[]; header: string | null; scoped: boolean }
const labels = ["Single choice", "True or false", "Multiple choice", "Fill in the blank", "Short answer", "Writing", "Reading comprehension", "Word bank", "Cloze", "Ordering", "Matching", "Listening", "Grammar fill", "Sentence selection", "Paragraph matching", "Translation"];
const composite = new Set(["Reading comprehension", "Word bank", "Cloze", "Listening", "Grammar fill", "Sentence selection"]), banks = new Set(["Word bank", "Sentence selection"]), choices = new Set(["Single choice", "Multiple choice", "Word bank", "Sentence selection"]);
const start = "(?:^|(?<=\\n))", digit = "\\p{Nd}", whitespace = SOURCE_WHITESPACE;
const boundary = () => new RegExp(`${start}${whitespace}*(?:${digit}{1,4}${whitespace}*[.、)．]|[一二三四五六七八九十]{1,3}${whitespace}*[、.．])`, "gu");
const typed = () => new RegExp(`${start}[ \\t]*([1-9]${digit}{0,8})\\.[ \\t]+(${labels.join("|")}):`, "gu");
const parentLine = new RegExp(`^Parent ID: ([1-9]${digit}{0,8})\\.(?: Shared option owner: ([1-9]${digit}{0,8})\\.)?$`, "u");
const blanks = (value: string) => new Set([...value.matchAll(/\[blank:([^\]]+)\]/gu)].map(match => match[1]));
const full = (expression: RegExp, value: string): RegExpMatchArray | null => { const match = value.match(expression); return match && match[0].length === value.length ? match : null; };
const ignoreCase = (pattern: string) => pattern.replace(/i/gi, "[iİı]");
const unnumbered = new RegExp(`${start}[ \\t]*(?:${ignoreCase([...labels].sort().join("|"))})[ \\t]*[:—–-]`, "iu");
const fieldNames = ["Material", "Reference answer", "Supplied answer", "Correct answer", "Standard answer", "Model answer", "Answer", "Reference answers", "Supplied answers", "Correct answers", "Standard answers", "Model answers", "Answers", "Answer order", "Points", "Score", "Source score", "Rubric", "Scoring rubric", "Supplied explanation", "Supplied analysis", "Supplied solution", "Explanation", "Analysis", "Solution", "Instructions", "Target language", "Transcript", "Play count", "Matching policy", "Choice variant", "Blank count", "Allow reuse", "Answer status", "Audio status", "Genre", "Minimum words", "Maximum words", "Source passage"];
const inlineField = new RegExp(`(?:${ignoreCase(fieldNames.join("|"))}|(?:参考|正确|标准)?答案(?:解析)?|解析|解答|分析|评分(?:标准|细则)?)${whitespace}*[:：]`, "iu");
const declarations = ["Do not reuse options.", "No reference answer is supplied for this question.", "No audio file is supplied."];
export const sourceQuestionLabels = Object.freeze([...labels]);
export const sourceBoundaries = boundary;
export const sourceTypedMarkers = typed;
export const sourceFieldMarkers = () => new RegExp(inlineField.source, "giu");
export const sourceExerciseStarts = () => new RegExp(unnumbered.source, "giu");
export const sourceParentPattern = parentLine.source.slice(1, -1);
const subset = <T>(left: Set<T>, right: Set<T>): boolean => [...left].every(value => right.has(value));
const cache = new Map<string, { source: SourceText; typed?: Frames | null; table?: Frames | null }>();
function layout(text: string) {
  let value = cache.get(text); if (value) cache.delete(text); else value = { source: new SourceText(text) };
  cache.set(text, value); if (cache.size > 4) cache.delete(cache.keys().next().value!); return value;
}
function closedBlocks(frames: Frame[]): Block[] | null {
  if (!subset(new Set(frames.filter(frame => composite.has(frame.kind)).map(frame => frame.id)), new Set(frames.map(frame => frame.parent)))) return null;
  const roots = new Map<string, string>(), kinds = new Map<string, string>(), blocks: Block[] = [], seenGroups = new Set<string>(); let ids = new Set<string>(), refs = new Set<string>(), currentRoot = "", currentGroup = "", start = 0, end = 0, count = 0;
  for (const frame of frames) {
    const { id, parent, owner, kind } = frame, parentKind = kinds.get(parent);
    if (roots.has(id) || parent && !roots.has(parent)) return null;
    if (parent && (!composite.has(parentKind!) || ["Reading comprehension", "Listening"].includes(kind) || (banks.has(parentKind!) || parentKind === "Cloze") && kind !== "Single choice" || parentKind === "Grammar fill" && kind !== "Fill in the blank" || parentKind === "Listening" && !["Single choice", "Multiple choice", "Fill in the blank", "Short answer", "Writing", "Translation"].includes(kind) || banks.has(parentKind!) && owner !== parent)) return null;
    if (owner && (owner !== parent || !banks.has(parentKind!) || kind !== "Single choice")) return null;
    const root = parent ? roots.get(parent)! : id;
    if (root !== currentRoot) {
      if (parent || currentRoot && !subset(refs, ids)) return null;
      if (count) blocks.push([start, end, count]); currentRoot = root; currentGroup = frame.group;
      if (currentGroup && seenGroups.has(currentGroup)) return null; seenGroups.add(currentGroup); start = frame.start; count = 0; ids = new Set(); refs = new Set();
    }
    if (frame.group !== currentGroup) return null; roots.set(id, root); kinds.set(id, kind);
    if (owner && roots.get(owner) !== root) return null;
    ids.add(id); frame.refs.forEach(ref => refs.add(ref)); end = frame.end; count++;
  }
  if (!count || !subset(refs, ids)) return null; blocks.push([start, end, count]); return blocks;
}
function bodyScoped(source: SourceText, frames: Frame[]): boolean {
  for (const frame of frames) for (let line of sourceLines(source.slice(frame.contentStart, frame.end)).slice(1)) {
    line = sourceTrim(line); if (!line || fieldNames.some(prefix => line.startsWith(`${prefix}:`)) || declarations.includes(line) || full(parentLine, line)) continue;
    if (choices.has(frame.kind) && full(/^[A-Z][.、)](?:[ \t]+.*)?$/u, line)) continue;
    if (["Ordering", "Matching", "Paragraph matching"].includes(frame.kind) && full(new RegExp(`^Item (?:sequence|left|right) ${digit}+ \\((?:${digit}+|[A-Z])\\):.*$`, "u"), line)) continue;
    return false;
  } return true;
}
export function tableFrames(text: string): Frames | null {
  const value = layout(text); if (value.table !== undefined) return value.table; value.table = null;
  const lines = sourceLines(text, true); if (lines.length < 2) return null;
  const header = lines[0].replace(/[\r\n]+$/u, ""), columns = header.split("\t"), required = ["id", "root_task", "parent_id", "option_owner", "question_type", "stem"];
  if (!required.every(name => columns.includes(name)) || new Set(columns).size !== columns.length) return null;
  const frames: Frame[] = []; let offset = lines[0].length;
  for (const line of lines.slice(1)) {
    const cells = line.replace(/[\r\n]+$/u, "").split("\t"); if (cells.length !== columns.length) return null;
    const values = Object.fromEntries(required.map(name => [name, cells[columns.indexOf(name)]]));
    if (!values.root_task || !labels.includes(values.question_type) || ["id", "parent_id", "option_owner"].some(name => (name === "id" || values[name]) && !full(new RegExp(`^[1-9]${digit}{0,8}$`, "u"), values[name]))) return null;
    frames.push({ start: frames.length ? value.source.point(offset) : 0, contentStart: value.source.point(offset), end: value.source.point(offset + line.length), id: values.id, parent: values.parent_id, owner: values.option_owner, refs: blanks(line), group: values.root_task, kind: values.question_type }); offset += line.length;
  }
  const blocks = closedBlocks(frames); return blocks ? value.table = { frames, blocks, header, scoped: true } : null;
}
export function typedFrames(text: string): Frames | null {
  const value = layout(text); if (value.typed !== undefined) return value.typed; value.typed = null;
  const matches = [...text.matchAll(typed())]; if (!matches.length || unnumbered.test(text) || sourceLines(text).some(line => { const candidate = boundary().exec(line); return candidate?.index === 0 && typed().exec(line)?.index !== 0; })) return null;
  const frames: Frame[] = [];
  for (const [index, match] of matches.entries()) {
    const end = index + 1 < matches.length ? value.source.point(matches[index + 1].index) : value.source.length, body = value.source.slice(value.source.point(match.index + match[0].length), end);
    if (!sourceTrim(body) || ["Parent ID:", "Shared option owner:"].some(marker => body.split("\n", 1)[0].includes(marker))) return null;
    const lines = sourceLines(body).slice(1).map(sourceTrim).filter(Boolean), declared = lines.filter(line => line.startsWith("Parent ID:") || line.startsWith("Shared option owner:")), parent = lines.length ? full(parentLine, lines[0]) : null;
    if (declared.length && (!parent || declared.length !== 1)) return null;
    frames.push({ start: index ? value.source.point(match.index) : 0, contentStart: value.source.point(match.index), end, id: match[1], parent: parent?.[1] ?? "", owner: parent?.[2] ?? "", refs: blanks(body), group: "", kind: match[2] });
  }
  const blocks = closedBlocks(frames); return blocks ? value.typed = { frames, blocks, header: null, scoped: bodyScoped(value.source, frames) } : null;
}
function legacySpans(source: SourceText, target: number): ChunkSpan[] {
  // Scan whitespace runs once; repeated multiline regex starts can backtrack quadratically.
  const ranges: [number, number][] = [], boundaries: number[] = [], marker = new RegExp(`(?:${digit}{1,4}${whitespace}*[.、)．]|[一二三四五六七八九十]{1,3}${whitespace}*[、.．])`, "uy"); let position = 0;
  while (position >= 0) {
    let content = position; while (content < source.text.length && sourceSpace(source.text[content])) content++; if (content === source.text.length) break;
    marker.lastIndex = content; const match = marker.exec(source.text); if (match) boundaries.push(source.point(position)); const newline = source.text.indexOf("\n", match ? marker.lastIndex : content); position = newline < 0 ? -1 : newline + 1;
  }
  if (source.length <= target) ranges.push([0, source.length]);
  else if (!boundaries.length) for (let start = 0; start < source.length; start += target) ranges.push([start, Math.min(start + target, source.length)]);
  else {
    if (boundaries[0] !== 0) boundaries.unshift(0); boundaries.push(source.length); let start = 0, previous = 0;
    for (const boundary of boundaries.slice(1)) { if (boundary - start >= target) { const cut = previous > start ? previous : boundary; ranges.push([start, boundary - start <= CHUNK_MAX_CHARS ? boundary : cut]); start = cut; } previous = boundary; }
    if (start < source.length) ranges.push([start, source.length]);
  }
  const spans: ChunkSpan[] = [];
  for (const [start, end] of ranges) { invariant(end - start <= CHUNK_MAX_CHARS, "DOCUMENT_CHUNK_TOO_LARGE", "A question exceeds the 40000-character fragment limit; split the source explicitly"); if (sourceTrim(source.slice(start, end))) spans.push({ start, end, overlapStart: start, overlapEnd: spans.length ? Math.min(end, spans.at(-1)!.end) : start }); } return spans;
}
export function splitChunkPlan(text: string, target = CHUNK_TARGET_CHARS, options: ChunkSourceOptions = {}): ChunkPlan {
  invariant(Number.isSafeInteger(target) && target > 0 && target <= CHUNK_MAX_CHARS, "DOCUMENT_CHUNK_TOO_LARGE", "Chunk target must be within the hard input limit");
  const { source } = layout(text), table = options.complete !== false && options.tabularRowsSafe ? tableFrames(text) : null, typed = !table && options.complete !== false && options.sourceType !== "csv" ? typedFrames(text) : null;
  const frames = table ?? (typed && !sourceTrim(source.slice(0, typed.frames[0].contentStart)) && typed.scoped ? typed : null);
  if (!frames) { const spans = legacySpans(source, target); return { spans, header: null, nodeCounts: spans.map(() => null) }; }
  const spans: ChunkSpan[] = [], nodeCounts: (number | null)[] = [], header = frames.header === null ? 0 : new SourceText(frames.header).length + 1; let start = 0, end = 0, nodes = 0;
  for (const [left, right, count] of frames.blocks) {
    invariant(right - left + (left ? header : 0) <= CHUNK_MAX_CHARS, "DOCUMENT_CHUNK_TOO_LARGE", "A question exceeds the 40000-character fragment limit; split the source explicitly");
    if (nodes && (nodes + count > CHUNK_TARGET_NODES || right - start + (start ? header : 0) > target)) { spans.push({ start, end, overlapStart: start, overlapEnd: start }); nodeCounts.push(nodes); start = left; nodes = 0; }
    end = right; nodes += count;
  }
  spans.push({ start, end, overlapStart: start, overlapEnd: start }); nodeCounts.push(nodes); return { spans, header: frames.header, nodeCounts };
}

export function referenceSupplied(value: string): boolean {
  value = sourceTrim(value); if (!value || ["none", "null", "n/a", "unknown", "unavailable", "not supplied"].includes(sourceCasefold(value))) return false;
  let decoded: unknown;
  try { decoded = parseSourceJson(value).value; }
  catch { return !["[", "{", '"', "'"].includes(value[0]) || value.length > 2 && value[0] === "'" && value.at(-1) === "'" && Boolean(sourceTrim(value.slice(1, -1))); }
  const pending = [decoded]; while (pending.length) { const item = pending.pop(); if (typeof item === "string" && sourceTrim(item) || typeof item === "boolean" || typeof item === "number") return true; if (item !== null && typeof item === "object") for (const entry of Object.values(item)) pending.push(entry); } return false;
}
function bound(frames: Frame[], field: "end" | "contentStart", value: number, right: boolean): number {
  let left = 0, end = frames.length; while (left < end) { const middle = (left + end) >>> 1; if (frames[middle][field] < value || right && frames[middle][field] === value) left = middle + 1; else end = middle; } return left;
}
export function sourcePresencePlan(text: string, spans: ChunkSpan[], options: ChunkSourceOptions = {}): (Record<string, SourcePresenceHint> | null)[] {
  if (options.complete === false) return spans.map(() => null);
  const source = layout(text).source, table = options.tabularRowsSafe ? tableFrames(text) : null, layoutFrames = table ?? ((options.sourceType ?? "text") === "text" ? typedFrames(text) : null);
  if (!layoutFrames) return spans.map(() => null); const { frames } = layoutFrames, result = new Map<string, SourcePresenceHint>(), parents = new Set(frames.map(frame => frame.parent).filter(Boolean));
  for (const frame of frames) {
    const raw = source.slice(frame.contentStart, frame.end).replace(/[\r\n]+$/u, ""); let stem: string, kind: string, hasOptions = false, hasAnalysis = false, hasAnswer = false, literalStem = layoutFrames.scoped;
    if (table) {
      const columns = table.header!.split("\t"), values = raw.split("\t"), cells = Object.fromEntries(columns.map((column, index) => [column, values[index]])); stem = cells.stem ?? ""; kind = cells.question_type ?? ""; hasAnswer = (cells.answer_status ?? "supplied") === "supplied" && referenceSupplied(cells.reference_answer ?? "");
      try { const options = JSON.parse(cells.options ?? ""); hasOptions = Array.isArray(options) && options.length > 0 && options.every(value => { if (value === null || typeof value !== "object" || Array.isArray(value)) return false; const normalized = { ...value }; for (const field of ["label", "content"]) if (typeof normalized[field] === "string") normalized[field] = sourceTrim(normalized[field]) || null; validateContract("ParsedOption", normalized); return typeof normalized.content === "string" && Boolean(sourceTrim(normalized.content)); }); } catch { /* Unproven option presence remains absent. */ }
      try { const evidence = JSON.parse(cells.evidence ?? ""); hasAnalysis = typeof object(evidence).analysis === "string" && Boolean(sourceTrim(String(object(evidence).analysis))); } catch { /* Unproven explanation presence remains absent. */ }
    } else {
      const match = typed().exec(raw)!; stem = raw.split("\n", 1)[0].slice(match[0].length); kind = match[2]; literalStem = literalStem && !inlineField.test(stem) && !declarations.some(declaration => stem.includes(declaration));
      const lines = sourceLines(raw), stripped = lines.map(sourceTrim), answers = stripped.slice(1).filter(line => line.startsWith("Reference answer:")).map(line => line.slice("Reference answer:".length));
      hasAnswer = literalStem && answers.length === 1 && referenceSupplied(answers[0]) && !stripped.slice(1).some(line => line.startsWith("Answer:") || line.startsWith("Supplied answer:")) && !stripped.includes("No reference answer is supplied for this question.") && stripped.filter(line => line.startsWith("Answer status:")).every(line => line === "Answer status: supplied");
      const options = [...raw.matchAll(new RegExp(`${start}[ \\t]*([A-Z])[.、)](?:[ \\t]+([^\\r\\n]*))?[ \\t]*(?=$|\\n)`, "gu"))]; hasOptions = new Set(options.map(option => option[1])).size >= 2 && options.every(option => sourceTrim(option[2] ?? ""));
      hasAnalysis = lines.some(line => { const stripped = sourceTrim(line); return (stripped.startsWith("Supplied explanation:") || stripped.startsWith("Analysis:")) && Boolean(sourceTrim(line.slice(line.indexOf(":") + 1))); });
    }
    const hint: SourcePresenceHint = { need_stem: Boolean(sourceTrim(stem)), need_options: hasOptions && [...choices, "choice", "single_choice", "multiple_choice", "word_bank", "sentence_selection"].includes(kind) && !frame.owner, need_analysis: hasAnalysis, need_answer: hasAnswer && !composite.has(kind) && !parents.has(frame.id) };
    if (literalStem && sourceTrim(stem)) hint.stem_sha256 = hash(sourceTrim(stem)); if (hasAnswer && !table) hint.answer_source = raw; result.set(frame.id, hint);
  }
  return spans.map(span => {
    invariant(Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.start <= span.end && span.end <= source.length, "SOURCE_SELECTION_INVALID", "Invalid source presence range");
    const selected = frames.slice(bound(frames, "end", span.start, true), bound(frames, "contentStart", span.end, false));
    return selected.some(frame => frame.contentStart < span.start || frame.end > span.end) || !closedBlocks(selected) ? null : Object.fromEntries(selected.map(frame => [frame.id, { ...result.get(frame.id)! }]));
  });
}
