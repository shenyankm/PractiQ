import type { ParsedItem, Question } from "../src/contracts.generated.js";
import { object } from "./question-contract.js";
import { canonical } from "./questions.js";
import { referenceSupplied, sourceBoundaries, sourceExerciseStarts, sourceFieldMarkers, sourceParentPattern, sourceQuestionLabels } from "./source-chunks.js";
import { sourceCasefold } from "./source-casefold.js";
import digitData from "./source-digits.json" with { type: "json" };
import { parseSourceJson, sourceNumberString, type SourceJson } from "./source-json.js";
import { SourceText, SOURCE_WHITESPACE as space, sourceDecimalDigits as decimal, sourceLines, sourceTrim } from "./source-text.js";
import { validateParsedQuestion } from "./question-contract.js";

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ci = (pattern: string): string => pattern.replace(/i/gi, "[iİı]");
const caseLiteral = (value: string): string => escape(value).replace(/[A-Za-z]/g, char => `[${char.toLowerCase()}${char.toUpperCase()}${char.toLowerCase() === "i" ? "İı" : char.toLowerCase() === "s" ? "ſ" : char.toLowerCase() === "k" ? "K" : ""}]`);
const literal = (value: string): string => sourceTrim(value).replace(new RegExp(`${space}+`, "gu"), " ");
const line = "(?:^|(?<=\\n))", word = "[\\p{L}\\p{N}_]", horizontal = `(?:(?![\\r\\n])${space})`;
const answerLabel = new RegExp(ci(`^(?:(?:reference|supplied|correct|standard|model)${space}+)?answers?$|^answer${space}+order$|^(?:参考|正确|标准)?答案$`), "iu");
const analysisLabel = new RegExp(ci(`^(?:supplied${space}+)?(?:explanation|analysis|solution)$|^(?:答案解析|解析|解答|分析)$`), "iu");
const typePrefix = new RegExp(ci(`^${space}*(?:${sourceQuestionLabels.map(escape).join("|")})${space}*[:：]${space}*`), "iu");
export const printedPrefix = () => new RegExp(`${line}${horizontal}*(?:第${horizontal}*)?(?<number>\\p{Nd}{1,6})(?:${horizontal}*题${horizontal}*[:：.．、)）]?${horizontal}*|${horizontal}*(?:[.．](?!\\p{Nd})|[、:：)）])${horizontal}*|${horizontal}*(?=\\r?(?:\\n|$)))`, "gu");
const answerKeys = () => new RegExp(ci(`${line}${horizontal}*(?:#{1,6}${horizontal}*)?(?:Answers?|Answer key|参考答案|标准答案|答案)(?:${horizontal}*[:：])?${horizontal}*\\r?(?=\\n|$)(?=${space}*\\p{Nd}{1,4}${space}*(?:[、)]|[.．](?!\\p{Nd})))`), "giu");
const isDigit = (value: string) => /^\p{Nd}$/u.test(value) || digitData.extraDigits.includes(value) && value !== "";
const full = (expression: RegExp, value: string): RegExpExecArray | null => { const match = expression.exec(value); return match && match[0].length === value.length ? match : null; };
type RecordText = [string | null, string];
type EvidenceRecord = [string | null, string, string];
interface Fields { answerPayload: string[]; analysis: string[] }
const emptyFields = (): Fields => ({ answerPayload: [], analysis: [] });

function tableRecords(text: string): RecordText[] | null {
  if (!text.includes("\t")) return null;
  const rows = sourceLines(text).filter(value => sourceTrim(value)).map(value => value.split("\t"));
  if (!rows.length || rows[0].length < 2 || rows.some(row => row.length !== rows[0].length)) return null;
  const headers = rows[0].map(value => sourceCasefold(sourceTrim(value))), stems = headers.flatMap((name, index) => ["stem", "question", "题干", "題幹", "题目", "題目"].includes(name) ? [index] : []);
  if (stems.length !== 1 || new Set(headers).size !== headers.length) return null;
  return rows.slice(1).map(row => {
    const cells = Object.fromEntries(headers.map((name, index) => [name, row[index]])); let record = row[stems[0]];
    const prefix = sourceBoundaries().exec(record); if (prefix?.index === 0) record = record.slice(prefix[0].length); record = record.replace(typePrefix, "");
    for (const [name, value] of Object.entries(cells)) { const label = name.replaceAll("_", " "); if ((answerLabel.test(label) || analysisLabel.test(label)) && (!answerLabel.test(label) || (cells.answer_status ?? "supplied") === "supplied")) record += `\n${label}: ${value}`; }
    if (cells.evidence) { try { const evidence = parseSourceJson(cells.evidence).value; if (typeof object(evidence).analysis === "string") record += "\nAnalysis: " + object(evidence).analysis; } catch {} }
    return [cells.id ?? null, record];
  });
}
function records(text: string, groupItems = false, answerSheet = false): RecordText[] {
  const table = tableRecords(text); if (table) return table;
  const source = new SourceText(text), boundary = answerSheet ? printedPrefix() : sourceBoundaries();
  let starts = [...text.matchAll(boundary)].filter(match => !/[.．]$/u.test(sourceTrim(match[0])) || !isDigit([...text.slice(match.index + match[0].length, match.index + match[0].length + 2)][0] ?? "")).map(match => ({ match, exercise: false }));
  starts.push(...[...text.matchAll(sourceExerciseStarts())].map(match => ({ match, exercise: true }))); starts.sort((a, b) => a.match.index - b.match.index);
  if (groupItems) {
    const fields = [...text.matchAll(sourceFieldMarkers())].filter(match => answerLabel.test(sourceTrim(match[0].slice(0, -1))) || analysisLabel.test(sourceTrim(match[0].slice(0, -1))));
    let structured = false, begin = 0, field = 0;
    starts = starts.filter(item => {
      const match = item.match;
      if (item.exercise) structured = /^(?:ordering|matching|paragraph matching)/u.test(sourceCasefold(sourceTrim(match[0])));
      else {
        const end = source.point(match.index + match[0].length), typed = typePrefix.exec(source.slice(end, Math.min(end + 128, source.length)));
        while (field < fields.length && fields[field].index < begin) field++;
        if (structured && !typed && (field === fields.length || fields[field].index >= match.index)) return false;
        structured = Boolean(typed && /^(?:ordering|matching|paragraph matching)/u.test(sourceCasefold(sourceTrim(typed[0]))));
      }
      begin = match.index + match[0].length; return true;
    });
  }
  return starts.length ? starts.map(({ match }, index) => { const number = /\p{Nd}+/u.exec(match[0]); return [number ? answerSheet ? decimal(number[0]) : number[0] : null, text.slice(match.index + match[0].length, starts[index + 1]?.match.index ?? text.length).replace(typePrefix, "")]; }) : [[null, text.replace(typePrefix, "")]];
}
export { records as sourceAnswerRecords };
function fields(record: string): Fields {
  const section = new RegExp(ci(`${line}[ \\t]*(?:Section:[ \\t]*[^${space.slice(1, -1)}]|Supplemental reading(?:,[^\\r\\n:]*)?:)`), "iu").exec(record);
  if (section) record = record.slice(0, section.index);
  const matches = [...record.matchAll(sourceFieldMarkers())], result = emptyFields();
  for (const [index, match] of matches.entries()) {
    const label = sourceTrim(match[0].slice(0, -1)), name = answerLabel.test(label) ? "answerPayload" : analysisLabel.test(label) ? "analysis" : null;
    if (name) { const value = sourceTrim(record.slice(match.index + match[0].length, matches[index + 1]?.index ?? record.length)); if (value) result[name].push(value); }
  } return result;
}
const scalarMatches = (printed: string, expected: string): boolean => literal(printed) === literal(expected) || full(/^[+-]?(?:\p{Nd}+(?:\.\p{Nd}*)?|\.\p{Nd}+)(?:[eE][+-]?\p{Nd}+)?\.$/u, printed) !== null && literal(printed.slice(0, -1)) === literal(expected);
const itemParts = (question: Question): [string, ParsedItem[]][] => question.answerMode === "ordering" ? [["Items", question.items]] : ["left", "right"].map(side => [side === "left" ? "Left" : "Right", question.items.filter(item => item.side === side)]);
function answerMatches(question: Question, printed: string, verifiedItems = false): boolean {
  if (question.answerPayload == null) return true;
  if (["choice", "true_false"].includes(question.answerMode ?? "")) printed = sourceTrim(sourceTrim(printed).replace(/[.。．]$/u, ""));
  if (!referenceSupplied(printed)) return false;
  const payload = object(question.answerPayload); let parsed: SourceJson | null = null; try { parsed = parseSourceJson(printed); } catch {}
  const decoded = parsed ? parsed.value : printed, labels = new Map<string, Map<number, string>>();
  if (verifiedItems) for (const [side, items] of itemParts(question)) labels.set(side, new Map(items.map((item, index) => [item.id ?? index, item.label || String(item.id ?? index)])));
  if (verifiedItems && decoded !== null && typeof decoded === "object" && [...labels.values()].some(side => [...side].some(([id, label]) => label !== String(id)))) return false;
  if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) return !parsed?.floatTokens && !parsed?.unsafeIntegers && canonical(decoded) === canonical(payload);
  if (question.answerMode === "true_false") return typeof payload.value === "boolean" && (payload.value ? ["true", "正确", "对", "是", "√", "✓"] : ["false", "错误", "错", "否", "×", "✗"]).includes(sourceCasefold(sourceTrim(printed)));
  if (question.answerMode === "choice") {
    let values: unknown[] = Array.isArray(decoded) ? decoded : sourceTrim(typeof decoded === "string" ? decoded : parsed?.scalarNumber ? sourceNumberString(parsed.scalarNumber) : decoded === true ? "True" : decoded === false ? "False" : "None").split(new RegExp(`[${space.slice(1, -1)},，、;；]+`, "u"));
    if (canonical(values) === canonical(payload.correct)) return true;
    if (values.length === 1 && typeof values[0] === "string" && /^[A-Z]+$/u.test(values[0])) values = [...values[0]];
    const expected = payload.correct;
    return Array.isArray(expected) && [...values, ...expected].every(value => typeof value === "string") && canonical([...new Set(values.map(value => sourceCasefold(String(value))))].sort()) === canonical([...new Set(expected.map(value => sourceCasefold(String(value))))].sort());
  }
  if (question.answerMode === "short_answer") return typeof payload.text === "string" && ["string", "number", "boolean"].includes(typeof decoded) && scalarMatches(typeof decoded === "string" ? decoded : printed, payload.text);
  if (question.answerMode === "fill_blank") { const answers = Array.isArray(decoded) ? decoded : [typeof decoded === "string" ? decoded : printed], expected = payload.answers; return Array.isArray(expected) && answers.length === expected.length && [...answers, ...expected].every(item => typeof item === "string") && answers.every((value, index) => scalarMatches(String(value), String(expected[index]))); }
  if (["ordering", "matching"].includes(question.answerMode ?? "") && Array.isArray(decoded)) return !parsed?.floatTokens && !parsed?.unsafeIntegers && canonical(decoded) === canonical(question.answerMode === "ordering" ? payload.order : payload.matches);
  if (question.answerMode === "ordering") {
    const order = payload.order; if (!Array.isArray(order) || !order.length) return false;
    if (verifiedItems && order.some(value => !labels.get("Items")?.has(value))) return false;
    if (!verifiedItems && order.some(value => !Number.isSafeInteger(value))) return false;
    const pattern = order.map(value => escape(verifiedItems ? labels.get("Items")!.get(value)! : String(value))).join(`${space}*,${space}*`);
    return full(new RegExp(`^${space}*${pattern}${space}*[.。．]?${space}*$`, "u"), printed) !== null;
  }
  if (question.answerMode === "matching") {
    const pairs = payload.matches; if (!Array.isArray(pairs) || !pairs.length) return false;
    if (verifiedItems && pairs.some(pair => !labels.get("Left")?.has(object(pair).left as number) || !labels.get("Right")?.has(object(pair).right as number))) return false;
    if (!verifiedItems && pairs.some(pair => !Number.isSafeInteger(object(pair).left) || !Number.isSafeInteger(object(pair).right))) return false;
    const patterns = pairs.map(pair => { const left = escape(verifiedItems ? labels.get("Left")!.get(pair.left)! : String(pair.left)), right = escape(verifiedItems ? labels.get("Right")!.get(pair.right)! : String(pair.right)); return verifiedItems && question.questionKind === "paragraph_matching" ? `${left}${space}*-${space}*${right}` : `left${space}+${left}${space}*->${space}*right${space}+${right}`; });
    return full(new RegExp(ci(`^${space}*${patterns.join(verifiedItems ? `${space}*[,，;；]${space}*` : `${space}*;${space}*`)}${space}*[.。．]?${space}*$`), "iu"), printed) !== null;
  } return false;
}

function unnumberedStemMatches(question: Question, record: string, stem: string): boolean {
  const marker = sourceFieldMarkers().exec(record), prefix = record.slice(0, marker?.index ?? record.length);
  if (["translation", "writing"].includes(question.questionKind ?? "")) {
    const lines = sourceLines(sourceTrim(prefix)); if (!lines.length) return false; let title = sourceTrim(lines[0]);
    const score = new RegExp(ci(`${space}*\\((\\p{Nd}+(?:\\.\\p{Nd}+)?)${space}*points?\\)${space}*$`), "iu").exec(title);
    if (score) { if (Number([...score[1]].map(char => /\p{Nd}/u.test(char) ? decimal(char) : char).join("")) !== question.sourceScore) return false; title = sourceTrim(title.slice(0, score.index)); }
    const material = question.contentBlocks.filter(block => ["material", "source_text", "starter_text"].includes(block.role ?? ""));
    return title === stem && material.length > 0 && material.every(block => block.partType === "text" && block.textValue) && literal(lines.slice(1).join("\n")) === literal(material.map(block => block.textValue ?? "").join("\n"));
  }
  if (["ordering", "matching"].includes(question.answerMode ?? "")) {
    let pattern = escape(stem); const paragraphs = question.questionKind === "paragraph_matching";
    if (paragraphs && question.matchingVariant === "many_to_one") pattern += `${space}+Paragraphs may be used more than once\\.`;
    for (const [label, items] of itemParts(question)) {
      if (!items.length || items.some(item => !item.content)) return false;
      const ids = items.map((item, index) => item.id ?? index), anchors = items.map((item, index) => item.label || String(ids[index]));
      if (new Set(ids).size !== ids.length || new Set(anchors).size !== anchors.length) return false;
      const entries = items.map((item, index) => `${escape(anchors[index])}[.．、)]${space}*${escape(literal(item.content ?? ""))}`);
      pattern += (paragraphs ? `${space}+` : `${space}+${caseLiteral(label)}:${space}*`) + entries.join(paragraphs ? `${space}+` : `${space}*;${space}*`) + "[.。．]?";
    } return full(new RegExp(`^${pattern}$`, "u"), literal(prefix)) !== null;
  }
  if (question.answerMode !== "choice") return false;
  const options = new Map(question.options.filter(option => option.label && option.content).map(option => [sourceCasefold(option.label!), literal(option.content!)])), remaining: string[] = [];
  for (const line of sourceLines(prefix)) { const match = full(new RegExp(`^${space}*([^${space.slice(1, -1)}.．、)]+)[.．、)]${space}*(.*?)${space}*$`, "u"), line); if (match && options.get(sourceCasefold(match[1])) === literal(match[2])) continue; remaining.push(line); }
  return literal(remaining.join("\n")) === stem;
}

function compositeFields(question: Question, parent: Question, childStems: Set<string>, records: EvidenceRecord[]): Fields | null {
  if (question.answerMode !== "choice" || !question.id || !parent.stem) return null;
  const blanks = (parent.passage ?? []).filter(block => block.partType === "blank").map(block => block.questionId);
  if (blanks.filter(id => id === question.id).length !== 1 || new Set(blanks).size !== blanks.length || (parent.passage ?? []).some(block => !["text", "blank"].includes(block.partType))) return null;
  const marker = "\ue000", passage = (parent.passage ?? []).map(block => block.partType === "blank" ? marker : block.textValue ?? "").join("");
  if ((parent.passage ?? []).some(block => block.textValue?.includes(marker))) return null;
  const pattern = escape(literal(passage)).replaceAll(marker, "\\[(\\p{Nd}{1,4})\\]"), options = parent.answerMode === "word_bank" ? parent.options : question.options, optionLabels = options.filter(option => option.label).map(option => escape(option.label!)).join("|");
  if (!blanks.length || !pattern) return null;
  const title = escape(literal(parent.stem)), candidates: { record: string; body: string; match: RegExpMatchArray }[] = [];
  for (const [index, [, record, body]] of records.entries()) {
    if (!new RegExp(`^${title}(?![\\p{L}\\p{N}_-])`, "u").test(body)) continue;
    const scope = [record];
    for (let later = index + 1; later < records.length; later++) { const [number, following, body] = records[later], continuation = full(new RegExp(`^(.+?)${space}*\\[(\\p{Nd}{1,4})\\][.。．]?$`, "u"), body); if (number === null || !continuation || continuation[2] !== number || !childStems.has(sourceTrim(continuation[1]))) break; scope.push(following); }
    const combined = scope.join("\n"), stop = [...combined.matchAll(sourceFieldMarkers())].find(match => answerLabel.test(sourceTrim(match[0].slice(0, -1))) || analysisLabel.test(sourceTrim(match[0].slice(0, -1))))?.index ?? combined.length, sourceBody = literal(combined.slice(0, stop)), matches = [...sourceBody.matchAll(new RegExp(pattern, "gu"))];
    if (matches.length !== 1) continue; const match = matches[0], prefix = sourceTrim(sourceBody.slice(0, match.index)), suffix = sourceTrim(sourceBody.slice(match.index + match[0].length));
    if (parent.answerMode === "cloze") { if (!full(new RegExp(`^${title}(?:${space}+(?:${caseLiteral("Material")}|${caseLiteral("Passage")}):)?$`, "u"), prefix) || !new RegExp(`^(?:\\p{Nd}{1,4}${space}*:${space}*)?[A-Za-z]+[.．、)]${space}`, "u").test(suffix)) continue; }
    else if (suffix || !new RegExp(`^${title}${space}+(?:(?:${caseLiteral("Bank")}|${caseLiteral("Options")}):${space}*)?(?=(?:${optionLabels})[.．、)]${space})`, "u").test(prefix)) continue;
    candidates.push({ record: combined, body: sourceBody, match });
  }
  if (candidates.length !== 1) return null;
  const { record, body, match } = candidates[0], numbers = match.slice(1); if (new Set(numbers).size !== numbers.length) return null;
  const blankIndex = blanks.indexOf(question.id); let before = "", current = 0;
  for (const block of parent.passage ?? []) { if (block.partType === "blank") { if (current === blankIndex) break; current++; before = ""; } else before += block.textValue ?? ""; }
  const clause = sourceTrim(sourceTrim(before).split(new RegExp(`[.!?]${space}+|[。！？]`, "u")).at(-1)!.replace(/^[.!?;。！？； ]+/u, "")); if (literal(question.stem ?? "") !== literal(clause)) return null;
  let optionSource = parent.answerMode === "word_bank" ? body.slice(0, match.index) : body.slice(match.index! + match[0].length);
  if (parent.answerMode === "cloze") {
    const sections = [...optionSource.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_.])(\\p{Nd}{1,4})${space}*:${space}*(?=[A-Za-z][.．、)])`, "gu"))], selected = sections.flatMap((section, index) => section[1] === numbers[blankIndex] ? [index] : []);
    if (sections.length) { if (selected.length !== 1 || new Set(sections.map(section => section[1])).size !== sections.length || sections.some(section => !numbers.includes(section[1]))) return null; const index = selected[0]; optionSource = optionSource.slice(sections[index].index + sections[index][0].length, sections[index + 1]?.index ?? optionSource.length); }
    else if (blanks.length !== 1) return null;
  }
  if (parent.answerMode === "word_bank" && question.optionSourceId !== parent.id) return null;
  if (!options.length || options.some(option => !option.label || !option.content || !new RegExp(`(?<!${word})${escape(option.label)}[.．、)]${space}*${escape(literal(option.content))}[.。．]?(?=${space}+(?:${optionLabels})[.．、)]${space}|${space}+Do not reuse words\\.${space}*$|${space}*$)`, "u").test(optionSource))) return null;
  const supplied = fields(record), result: Fields = { answerPayload: [], analysis: blanks.length === 1 ? supplied.analysis : [] };
  for (const value of supplied.answerPayload) {
    if (blanks.length === 1 && answerMatches(question, value)) result.answerPayload.push(value);
    else if (full(new RegExp(`^\\p{Nd}{1,4}${space}*[-:：]?${space}*[A-Za-z]+(?:${space}*[;；,，]${space}*\\p{Nd}{1,4}${space}*[-:：]?${space}*[A-Za-z]+)*[.。．]?$`, "u"), value)) {
      const entries = [...value.matchAll(new RegExp(`(\\p{Nd}{1,4})${space}*[-:：]?${space}*([A-Za-z]+)`, "gu"))], keys = entries.map(entry => entry[1]);
      if (new Set(keys).size !== keys.length || keys.some(key => !numbers.includes(key))) result.answerPayload.push(""); else result.answerPayload.push(...entries.filter(entry => entry[1] === numbers[blankIndex]).map(entry => entry[2]));
    } else result.answerPayload.push("");
  } return result;
}
function stemRecords(records: EvidenceRecord[], stem: string): EvidenceRecord[] {
  if (!stem) return []; let left = 0, right = records.length;
  while (left < right) { const middle = (left + right) >>> 1; if (records[middle][2] < stem) left = middle + 1; else right = middle; }
  const result: EvidenceRecord[] = [];
  while (left < records.length && records[left][2].startsWith(stem)) { const record = records[left++], next = record[2].codePointAt(stem.length); if (next === undefined || !/[\p{L}\p{N}_-]/u.test(String.fromCodePoint(next))) result.push(record); } return result;
}

/** shortcut: unfamiliar layouts keep only their raw source for review; extend with unambiguous real-source proofs. */
export function retainSourceAnswers(questions: Question[], primary: string, contexts: string[], answerSheet = false): [number, ("answerPayload" | "analysis")[]][] {
  if (!questions.some(question => question.answerPayload != null || question.analysis != null)) return [];
  const primaryKey = answerKeys().exec(primary), evidence = primaryKey && !answerSheet ? primary.slice(0, primaryKey.index) : primary;
  const project = (values: RecordText[]): EvidenceRecord[] => values.map(([number, record]) => [number, record, literal(record.slice(0, sourceFieldMarkers().exec(record)?.index ?? record.length))]);
  const originalRecords = project(records(evidence, false, answerSheet)), itemRecords = questions.some(question => ["ordering", "matching"].includes(question.answerMode ?? "")) ? project(records(evidence, true, answerSheet)) : originalRecords;
  const sorted = (values: EvidenceRecord[]) => [...values].sort((a, b) => a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0), recordsByStem = sorted(originalRecords), itemsByStem = itemRecords === originalRecords ? recordsByStem : sorted(itemRecords), sourceNumbers = new Map<string, number>(), keys = new Map<string, string[]>();
  const count = (values: (RecordText | EvidenceRecord)[]) => { for (const [number] of values) if (number) sourceNumbers.set(number, (sourceNumbers.get(number) ?? 0) + 1); }; count(originalRecords);
  for (const [index, text] of (answerSheet ? [] : [primary, ...contexts]).entries()) {
    const headings = [...text.matchAll(answerKeys())]; if (index) count(records(text.slice(0, headings[0]?.index ?? text.length)));
    if (headings.length === 1) for (const [number, body] of records(text.slice(headings[0].index + headings[0][0].length))) if (number) keys.set(number, [...keys.get(number) ?? [], body]);
  }
  const changes: [number, ("answerPayload" | "analysis")[]][] = [], parents = new Map(questions.filter(question => ["word_bank", "cloze"].includes(question.answerMode ?? "")).map(question => [question.id, question])), childStems = new Map<string, Set<string>>();
  for (const child of questions) if (child.parentId && child.stem) { const values = childStems.get(child.parentId) ?? new Set(); values.add(literal(child.stem)); childStems.set(child.parentId, values); }
  for (const [index, question] of questions.entries()) {
    if (question.answerPayload == null && question.analysis == null) continue;
    const stem = literal(question.stem ?? ""), parent = question.parentId ? parents.get(question.parentId) : undefined, itemMode = ["ordering", "matching"].includes(question.answerMode ?? "");
    let candidates: RecordText[] = stemRecords(itemMode ? itemsByStem : recordsByStem, stem).filter(([number, record, body]) => body === stem && (!itemMode || originalRecords.some(value => canonical(value) === canonical([number, record, body]))) || unnumberedStemMatches(question, record, stem) || number !== null && !itemMode && (!parent || new RegExp(sourceParentPattern, "u").test(record))).map(([number, record]) => [number, record]);
    if (candidates.length > 1 && question.id) candidates = candidates.filter(([number]) => number === question.id!.split(":").at(-1));
    if (answerSheet) { const quote = question.sourceText ?? "", printed = printedPrefix().exec(quote); candidates = quote && literal(primary).includes(literal(quote)) ? originalRecords.filter(([number, record]) => printed?.index === 0 && number === decimal(printed.groups!.number) && literal(quote).includes(literal(record))).map(([number, record]) => [number, record]) : []; }
    let verified = emptyFields(), verifiedItems = false;
    if (candidates.length === 1) {
      const [number, record] = candidates[0]; verifiedItems = itemMode && unnumberedStemMatches(question, record, stem); verified = fields(record);
      if (answerSheet && !verified.answerPayload.length) { const prefix = sourceTrim(record.slice(0, sourceFieldMarkers().exec(record)?.index ?? record.length)); if (prefix) verified.answerPayload.push(prefix); }
      if (number && sourceNumbers.get(number) === 1 && keys.get(number)?.length === 1) { const body = keys.get(number)![0], prefix = sourceTrim(body.slice(0, sourceFieldMarkers().exec(body)?.index ?? body.length)); if (prefix) verified.answerPayload.push(prefix); const following = fields(body); verified.answerPayload.push(...following.answerPayload); verified.analysis.push(...following.analysis); }
    } else if (parent) verified = compositeFields(question, parent, childStems.get(parent.id ?? "") ?? new Set(), originalRecords) ?? verified;
    const removed: ("answerPayload" | "analysis")[] = [];
    if (question.answerPayload != null && (!verified.answerPayload.length || !verified.answerPayload.every(value => answerMatches(question, value, verifiedItems)))) { question.answerPayload = null; removed.push("answerPayload"); }
    if (question.analysis != null && (!verified.analysis.length || !verified.analysis.every(value => literal(question.analysis!) === literal(value)))) { question.analysis = null; removed.push("analysis"); }
    if (removed.length) { question.needsReview = true; question.missingFields = validateParsedQuestion(question).missingFields; changes.push([index, removed]); }
  } return changes;
}
